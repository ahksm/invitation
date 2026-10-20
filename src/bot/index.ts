import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { count, eq, gt } from "drizzle-orm";
import { issueLoginCode } from "../auth/codes.js";
import {
  approveTelegramLogin,
  claimTelegramApproval,
  clearContactRejection,
  dropTelegramLogin,
  getTelegramLogin,
  isNonce,
  setContactRejection,
  settleTelegramLogin,
} from "../auth/telegram.js";
import type { Ctx } from "../context.js";
import { invitations, users, type User } from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { bt, dateLocale, localeNames, locales, pickLocale, translateError, type BotTextKey, type Locale } from "../i18n.js";
import { getPrices } from "../services/settings.js";
import { listOwnInvitations } from "../services/invitations.js";
import { attachPhoneToTelegramUser, formatPhone, linkTelegramToUser, maskPhone, normalizePhone, TELEGRAM_PHONE_MISMATCH } from "../services/phone.js";
import { linkGuestChat, longDate, personalView, rsvpFromChat, type PublicView } from "../services/public.js";
import { tashkentDate } from "../services/reminders.js";
import { track } from "../services/usage.js";
import { parseUserRef, type UserRef } from "../services/user-ref.js";
import { getAccess, getUser, invalidateUser, setUserLocale, upsertTelegramUser } from "../services/users.js";

export type BotContext = Context & { user: User; lang: Locale };

export function formatMoney(minor: number, currency: string, l: Locale = "ru") {
  const unit = currency !== "UZS" ? currency : l === "ru" ? "сум" : l === "uz" ? "so'm" : l === "uzc" ? "сўм" : "UZS";
  return `${(minor / 100).toLocaleString(dateLocale[l], { maximumFractionDigits: 2 })} ${unit}`;
}

/**
 * Номер из контакта Telegram. Telegram присылает его в международном виде (с кодом страны, «+» может
 * не быть), поэтому узбекский номер — только 998 и девять цифр, остальные храним цифрами (7–15, E.164).
 * Девять цифр — это не узбекский номер без +998 (так normalizePhone понимает ввод на сайте), а короткий
 * номер другой страны: иначе Telegram с номером +508 55 12 34 «подтвердил» бы чужой +998 50 855-12-34
 * и вошёл бы в аккаунт с ним (или подключился бы к нему).
 */
export function contactPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("998")) return normalizePhone(digits) === digits ? digits : null;
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

const RSVP_BUTTONS = { yes: "rsvpYes", maybe: "rsvpMaybe", no: "rsvpNo" } as const satisfies Record<string, BotTextKey>;
type RsvpStatus = keyof typeof RSVP_BUTTONS;
// Параметр /start: вход на сайт (auth_<nonce>) или гость со страницы приглашения (g_<token>).
const GUEST_PAYLOAD = /^g_([\w-]{8,62})$/;

/** Ссылка на пользователя в ответе админу: видно, что именно разобрал parseUserRef. */
const describeRef = (ref: UserRef) => ("phone" in ref ? formatPhone(ref.phone) : `Telegram ID ${ref.telegramId}`);

export function createBot(ctx: Ctx) {
  const bot = new Bot<BotContext>(ctx.config.TELEGRAM_BOT_TOKEN);
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  // Telegram принимает в кнопках только публичные https-ссылки.
  const canUseUrlButtons = appUrl.startsWith("https://");
  // Параметр /start ждёт, пока человек делится номером: вход на сайт 5 минут, приглашение гостя час.
  const pendingKey = (tgId: number) => `bot:pending-start:${tgId}`;
  const menu = (l: Locale) =>
    new InlineKeyboard().text(bt(l, "menuLogin"), "login").row().text(bt(l, "menuMy"), "my").text(bt(l, "menuPrices"), "prices").row().text(bt(l, "menuLang"), "lang");

  // Защита: только личные чаты, лимит сообщений, заблокированные пользователи игнорируются.
  bot.use(async (c, next) => {
    if (c.chat?.type !== "private" || !c.from || c.from.is_bot) return;
    if (await ctx.cache.hit(`bot:${c.from.id}`, 20, 60)) return;
    const user = await upsertTelegramUser(ctx, c.from);
    if (user.blocked) return;
    c.user = user;
    c.lang = pickLocale(user.locale);
    await next();
  });

  const askPhone = (c: BotContext, text: BotTextKey = "askPhone") =>
    c.reply(bt(c.lang, text), {
      reply_markup: new Keyboard().requestContact(bt(c.lang, "sharePhoneButton")).resized().oneTime(),
    });

  /** Аккаунт, к которому подключают Telegram (запрос начат с сессией на сайте); null — обычный вход. */
  async function linkTarget(nonce: string) {
    const login = await getTelegramLogin(ctx.cache, nonce);
    if (!login?.linkUserId) return null;
    const user = await getUser(ctx, login.linkUserId);
    return { login, user: user && !user.blocked && user.phone ? { ...user, phone: user.phone } : null };
  }

  /**
   * Отказ подключения: запрос завершается с причиной (браузер получит её в poll и останется в своём
   * аккаунте), ничего не привязывается. Возвращает текст причины для бота.
   */
  async function refuseLink(c: BotContext, nonce: string, reason: string) {
    await settleTelegramLogin(ctx.cache, nonce, { conflict: reason });
    return translateError(reason, c.lang);
  }

  /** afterContact: запрос продолжается после контакта, о котором бот попросил (см. bot.on("message:contact")). */
  async function askLoginConfirm(c: BotContext, nonce: string, afterContact = false) {
    const login = await getTelegramLogin(ctx.cache, nonce);
    if (!login || login.userId || login.conflict) return void (await c.reply(bt(c.lang, "loginExpired")));
    if (login.linkUserId) {
      const target = await linkTarget(nonce);
      if (!target?.user) return void (await c.reply(bt(c.lang, "loginExpired")));
      // Telegram подтвердил номер своим контактом, и номер не тот: это не владелец аккаунта (или его другой
      // номер). Отказ сразу, без кнопки: аккаунт, Telegram и вход в браузере не меняются.
      if (afterContact && c.user.id !== target.user.id) {
        if (!(await claimTelegramApproval(ctx.cache, nonce))) return void (await c.reply(bt(c.lang, "loginExpired")));
        return void (await c.reply(await refuseLink(c, nonce, TELEGRAM_PHONE_MISMATCH)));
      }
      // Подключение: человек видит, к какому аккаунту (номер со скрытой серединой) и с какого устройства.
      return void (await c.reply(bt(c.lang, "confirmLink", { phone: maskPhone(target.user.phone), device: login.device }), {
        reply_markup: new InlineKeyboard().text(bt(c.lang, "confirmLinkButton"), `auth:${nonce}`),
      }));
    }
    await c.reply(bt(c.lang, "confirmLogin", { device: login.device }), {
      reply_markup: new InlineKeyboard().text(bt(c.lang, "confirmButton"), `auth:${nonce}`),
    });
  }

  /**
   * Нажатие «Подключить»: подключение проходит, только если этот Telegram уже и есть аккаунт запроса
   * (Telegram подтвердил номер аккаунта своим контактом, и бот объединил их, или Telegram был
   * подключён раньше); браузер получает сессию этого аккаунта. Telegram другого аккаунта не
   * подключается: запрос завершается отказом, и браузер остаётся в своём аккаунте. Telegram без
   * номера сюда не доходит: бот сначала просит контакт. Возвращает текст, которым заменяется
   * сообщение с кнопкой.
   */
  async function confirmLink(c: BotContext, nonce: string, targetId: string): Promise<string> {
    // Повторное или параллельное нажатие той же кнопки ничего не делает.
    if (!(await claimTelegramApproval(ctx.cache, nonce))) return bt(c.lang, "loginExpired");
    let linked;
    try {
      linked = await linkTelegramToUser(ctx, targetId, c.user);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return refuseLink(c, nonce, err.message);
    }
    if (!linked?.phone) {
      await dropTelegramLogin(ctx.cache, nonce);
      return bt(c.lang, "loginExpired");
    }
    c.user = linked;
    await settleTelegramLogin(ctx.cache, nonce, { userId: linked.id });
    await track(ctx, linked.id, "telegram_linked", { telegramId: String(linked.telegramId) });
    return bt(c.lang, "linkConfirmed", { phone: maskPhone(linked.phone) });
  }

  async function sendLoginLink(c: BotContext) {
    const code = await issueLoginCode(ctx.cache, c.user.id);
    const url = `${appUrl}/api/auth/link?code=${code}`;
    const text = bt(c.lang, "loginLink");
    if (canUseUrlButtons) await c.reply(text, { reply_markup: new InlineKeyboard().url(bt(c.lang, "menuLogin"), url) });
    else await c.reply(`${text}\n${url}`, { link_preview_options: { is_disabled: true } });
  }

  /** Карточка приглашения для гостя на языке приглашения: кнопка открыть и кнопки ответа. */
  function guestCard(guestId: string, token: string, view: PublicView) {
    const l = view.language;
    const d = view.data;
    const link = `${appUrl}/g/${token}`;
    const when = [d.date ? longDate(d.date, l) : "", d.time ?? ""].filter(Boolean).join(", ");
    const place = [d.venue, d.address].map((s) => s?.trim()).filter(Boolean).join(", ");
    const g = view.guest;
    const lines = [
      bt(l, "guestInvited", { name: g?.name ?? "" }),
      d.names?.trim() || eventLabel(view.event, l) || ctx.config.APP_NAME,
      when && `📅 ${when}`,
      place && `📍 ${place}`,
      g && g.rsvp !== "pending" && bt(l, "guestAnswer", { answer: bt(l, RSVP_BUTTONS[g.rsvp]) }),
      bt(l, "guestReminders"),
      !canUseUrlButtons && `${bt(l, "openInvitation")}: ${link}`,
    ];
    const kb = new InlineKeyboard();
    if (canUseUrlButtons) kb.url(bt(l, "openInvitation"), link).row();
    for (const [status, key] of Object.entries(RSVP_BUTTONS)) kb.text(bt(l, key), `rsvp:${guestId}:${status}`);
    return { text: lines.filter(Boolean).join("\n"), reply_markup: kb };
  }

  /** /start g_<token>: чат привязывается к гостю (напоминания), гость получает карточку приглашения. */
  async function startGuest(c: BotContext, token: string) {
    const linked = await linkGuestChat(ctx, token, c.chat!.id);
    if (!linked) return void (await c.reply(bt(c.lang, "guestNotFound")));
    const { text, reply_markup } = guestCard(linked.guestId, token, linked.view);
    await c.reply(text, { reply_markup, link_preview_options: { is_disabled: true } });
  }

  /** Параметр /start после того, как номер привязан. afterContact: номер привязан только что, по просьбе бота. */
  async function handleStart(c: BotContext, payload: string, afterContact = false) {
    if (payload.startsWith("auth_")) return askLoginConfirm(c, payload.slice(5), afterContact);
    const guest = GUEST_PAYLOAD.exec(payload);
    if (guest) return startGuest(c, guest[1]!);
  }

  /**
   * Telegram без номера: параметр /start ждёт контакта. Подключение Telegram к аккаунту тоже ждёт его:
   * Telegram подключается, только подтвердив своим контактом номер аккаунта, поэтому чужая ссылка
   * подключения (пересланная, увиденная на экране) Telegram другого человека к аккаунту не подключит.
   */
  async function waitForPhone(c: BotContext, payload: string) {
    const auth = payload.startsWith("auth_");
    await ctx.cache.set(pendingKey(c.from!.id), payload, auth ? 300 : 3600);
    const link = auth && (await linkTarget(payload.slice(5))) !== null;
    await askPhone(c, link ? "askPhoneLink" : "askPhone");
  }

  /**
   * Контакт отклонён (номер уже у другого Telegram), а его ждало подключение Telegram к аккаунту: номер
   * этого Telegram не изменится, и подключение не состоится. Запрос сразу завершается отказом с той же
   * причиной, чтобы сайт показал её, а не ждал, пока запрос истечёт.
   */
  async function refusePendingLink(c: BotContext, reason: string) {
    const payload = await ctx.cache.get<string>(pendingKey(c.from!.id));
    const nonce = payload?.startsWith("auth_") ? payload.slice(5) : null;
    const link = nonce ? await linkTarget(nonce) : null;
    if (!nonce || !link || link.login.userId || link.login.conflict) return;
    if (!(await claimTelegramApproval(ctx.cache, nonce))) return;
    await ctx.cache.del(pendingKey(c.from!.id));
    await refuseLink(c, nonce, reason);
  }

  bot.command("start", async (c) => {
    await track(ctx, c.user.id, "bot_start");
    const payload = c.match;
    // t.me/<бот>?start=auth_<nonce> приходит с кнопки «Войти через Telegram» или «Подключить Telegram»
    // на сайте, t.me/<бот>?start=g_<token> — с кнопки «Напомнить мне в Telegram» на странице гостя после ответа.
    const known = (payload.startsWith("auth_") && isNonce(payload.slice(5))) || GUEST_PAYLOAD.test(payload);
    if (known) {
      if (!c.user.phone) return waitForPhone(c, payload);
      return handleStart(c, payload);
    }
    if (!c.user.phone) return void (await askPhone(c));
    await c.reply(bt(c.lang, "welcome"), { reply_markup: menu(c.lang) });
  });

  // Отказ принять контакт запоминается для мини-аппа (/api/auth/webapp отвечает с error), новый контакт его сбрасывает.
  bot.on("message:contact", async (c) => {
    const contact = c.message.contact;
    const tgId = c.from.id;
    await clearContactRejection(ctx.cache, tgId);
    // Принимаем только собственный номер, отправленный кнопкой, а не чужой контакт.
    if (contact.user_id !== tgId) {
      await setContactRejection(ctx.cache, tgId, { text: "ownPhoneOnly" });
      return void (await c.reply(bt(c.lang, "ownPhoneOnly")));
    }
    const phone = contactPhone(contact.phone_number);
    if (!phone) {
      await setContactRejection(ctx.cache, tgId, { text: "badPhone" });
      return void (await c.reply(bt(c.lang, "badPhone")));
    }
    try {
      c.user = await attachPhoneToTelegramUser(ctx, c.user, phone);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await setContactRejection(ctx.cache, tgId, { error: err.message });
      await c.reply(translateError(err.message, c.lang), { reply_markup: { remove_keyboard: true } });
      return refusePendingLink(c, err.message);
    }
    await c.reply(bt(c.lang, "phoneLinked", { phone: phone.startsWith("998") ? formatPhone(phone) : `+${phone}` }), { reply_markup: { remove_keyboard: true } });
    const payload = await ctx.cache.take<string>(pendingKey(c.from.id));
    if (payload) await handleStart(c, payload, true);
    else await c.reply(bt(c.lang, "whatNext"), { reply_markup: menu(c.lang) });
  });

  bot.callbackQuery(/^auth:([\w-]+)$/, async (c) => {
    const nonce = c.match[1]!;
    const link = await linkTarget(nonce);
    if (link) {
      await c.answerCallbackQuery();
      if (link.login.userId || link.login.conflict) return void (await c.editMessageText(bt(c.lang, "loginExpired")));
      // Кнопка у Telegram без номера (например, из сообщения до обновления бота): сначала контакт.
      if (!c.user.phone) return waitForPhone(c, `auth_${nonce}`);
      return void (await c.editMessageText(await confirmLink(c, nonce, link.login.linkUserId!)));
    }
    if (!c.user.phone) {
      await c.answerCallbackQuery();
      return void (await askPhone(c));
    }
    const ok = await approveTelegramLogin(ctx.cache, nonce, c.user.id);
    await c.answerCallbackQuery();
    await c.editMessageText(bt(c.lang, ok ? "loginConfirmed" : "loginExpired"));
  });

  // Выбор языка доступен и до привязки номера.
  const langKeyboard = () => {
    const kb = new InlineKeyboard();
    for (const l of locales) kb.text(localeNames[l], `lang:${l}`);
    return kb;
  };
  bot.command("lang", (c) => c.reply(bt(c.lang, "chooseLang"), { reply_markup: langKeyboard() }));
  bot.callbackQuery("lang", async (c) => {
    await c.answerCallbackQuery();
    await c.reply(bt(c.lang, "chooseLang"), { reply_markup: langKeyboard() });
  });
  bot.callbackQuery(/^lang:(ru|uz|uzc|en)$/, async (c) => {
    const l = pickLocale(c.match[1]);
    await setUserLocale(ctx, c.user.id, l);
    c.lang = l;
    await c.answerCallbackQuery();
    await c.editMessageText(bt(l, "langSaved"));
    if (!c.user.phone) await askPhone(c);
    else await c.reply(bt(l, "whatNext"), { reply_markup: menu(l) });
  });

  // Всё остальное доступно только после привязки номера.
  bot.filter((c) => !c.user.phone).on(["message", "callback_query"], async (c) => {
    if (c.callbackQuery) await c.answerCallbackQuery();
    await askPhone(c);
  });
  const verified = bot.filter((c) => Boolean(c.user.phone));

  // Ответ гостя кнопкой под карточкой приглашения.
  verified.callbackQuery(/^rsvp:([0-9a-f-]{36}):(yes|maybe|no)$/, async (c) => {
    const status = c.match[2] as RsvpStatus;
    let token: string | null;
    try {
      token = await rsvpFromChat(ctx, c.match[1]!, c.chat!.id, status);
    } catch (e) {
      // Срок ответа или день события прошли: ответ не меняется, гостю — объяснение.
      if (e instanceof HttpError && e.statusCode === 410) return void (await c.answerCallbackQuery({ text: bt(c.lang, "rsvpClosed"), show_alert: true }));
      throw e;
    }
    const view = token ? await personalView(ctx, token) : null;
    if (!token || !view) return void (await c.answerCallbackQuery({ text: bt(c.lang, "guestNotFound"), show_alert: true }));
    await c.answerCallbackQuery({ text: bt(view.language, "rsvpSaved") });
    const { text, reply_markup } = guestCard(c.match[1]!, token, view);
    // Тот же ответ второй раз: Telegram отвечает «message is not modified», это не ошибка.
    await c.editMessageText(text, { reply_markup, link_preview_options: { is_disabled: true } }).catch(() => {});
  });

  verified.command("login", sendLoginLink);
  verified.callbackQuery("login", async (c) => {
    await c.answerCallbackQuery();
    await sendLoginLink(c);
  });

  async function sendMy(c: BotContext) {
    const rows = await listOwnInvitations(ctx, c.user.id);
    if (!rows.length) return void (await c.reply(bt(c.lang, "noInvitations")));
    const status = { draft: "statusDraft", active: "statusActive", archived: "statusArchived" } as const;
    const lines = rows.slice(0, 20).map((i) => {
      const label = eventLabel(i.event, c.lang);
      const kind = i.mode === "shared" ? bt(c.lang, "invShared") : bt(c.lang, "invPersonal", { guests: i.stats.guests, paid: i.paidSeats });
      return `• ${i.title}${label ? ` (${label})` : ""}: ${kind}, ${bt(c.lang, status[i.status])}`;
    });
    await c.reply(lines.join("\n"));
  }
  verified.command("my", sendMy);
  verified.callbackQuery("my", async (c) => {
    await c.answerCallbackQuery();
    await sendMy(c);
  });

  async function sendPrices(c: BotContext) {
    const [prices, access] = await Promise.all([getPrices(ctx), getAccess(ctx, c.user)]);
    const m = (v: number) => formatMoney(v, ctx.config.CURRENCY, c.lang);
    const l = c.lang;
    const lines = [
      bt(l, "priceShared", { price: m(prices.sharedTemplate) }),
      bt(l, "priceSeat", { price: m(prices.seat) }),
      bt(l, "priceSub", { price: m(prices.subscriptionMonth) }),
      "",
      access.free
        ? bt(l, "accessFree")
        : access.subscriptionEndsAt
          ? // Дата по календарю Ташкента, как в приложении: подписка до 01:30 19-го — это 19-е, а не 18-е (UTC).
            bt(l, "accessSub", { date: longDate(tashkentDate(access.subscriptionEndsAt), l) })
          : bt(l, "accessNone"),
    ];
    await c.reply(lines.join("\n"));
  }
  verified.command("prices", sendPrices);
  verified.callbackQuery("prices", async (c) => {
    await c.answerCallbackQuery();
    await sendPrices(c);
  });

  // Команды владельца.
  const admin = verified.filter((c) => c.user.isAdmin);

  admin.command("stats", async (c) => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [[total], [active], [inv]] = await Promise.all([
      ctx.db.select({ n: count() }).from(users),
      ctx.db.select({ n: count() }).from(users).where(gt(users.lastSeenAt, monthAgo)),
      ctx.db.select({ n: count() }).from(invitations),
    ]);
    await c.reply(`Пользователей: ${total!.n}\nАктивных за 30 дней: ${active!.n}\nПриглашений: ${inv!.n}\nАдминка: ${appUrl}/admin/`);
  });

  // Как в админке (parseUserRef): «+998…» или 998XXXXXXXXX — телефон, просто цифры или tg:123 — Telegram ID.
  // Девять цифр — Telegram ID, а не номер без +998: иначе доступ получил бы посторонний владелец номера.
  async function setFree(c: BotContext, free: boolean) {
    const [idArg = "", ...note] = (c.message?.text ?? "").split(/\s+/).slice(1);
    const usage = `Использование: /${free ? "grant" : "revoke"} <Telegram ID или телефон +998…>${free ? " [заметка]" : ""}`;
    const ref = parseUserRef(idArg);
    if (!ref) return void (await c.reply(usage));
    const by = { adminId: c.user.id, via: "bot" };
    if (!free) {
      // Снять доступ можно только существующему пользователю, нового не создаём.
      const [u] = await ctx.db
        .update(users)
        .set({ freeAccess: false })
        .where("phone" in ref ? eq(users.phone, ref.phone) : eq(users.telegramId, ref.telegramId))
        .returning();
      if (!u) return void (await c.reply(`Пользователь не найден: ${describeRef(ref)}`));
      await invalidateUser(ctx, u.id);
      await track(ctx, u.id, "free_access_revoked", by);
      return void (await c.reply(`Бесплатный доступ снят: ${describeRef(ref)}`));
    }
    const set = { freeAccess: true, freeAccessNote: note.join(" ") || null };
    const [u] = await ctx.db
      .insert(users)
      .values({ ...ref, ...set })
      .onConflictDoUpdate({ target: "phone" in ref ? users.phone : users.telegramId, set })
      .returning();
    await invalidateUser(ctx, u!.id);
    await track(ctx, u!.id, "free_access_granted", by);
    await c.reply(`Бесплатный доступ выдан: ${describeRef(ref)}`);
  }
  admin.command("grant", (c) => setFree(c, true));
  admin.command("revoke", (c) => setFree(c, false));

  verified.on("message", (c) => c.reply(bt(c.lang, "unknown")));

  bot.catch((err) => ctx.log.error({ err: err.error, update: err.ctx.update.update_id }, "ошибка бота"));

  return bot;
}

/** Команды меню «/» на языке бота. */
export function botCommands(l: Locale) {
  return [
    { command: "start", description: bt(l, "menuStart") },
    { command: "login", description: bt(l, "menuLogin") },
    { command: "my", description: bt(l, "menuMy") },
    { command: "prices", description: bt(l, "menuPrices") },
    { command: "lang", description: "Язык / Til / Language" },
  ];
}

/**
 * Меню команд по языку клиента Telegram: без language_code — русское (для всех остальных языков),
 * отдельно uz и en. Telegram различает язык только по коду клиента («uz» без письменности),
 * поэтому кириллический uzc получает узбекское меню на латинице.
 */
export async function setBotCommands(bot: Pick<Bot<BotContext>, "api">) {
  await bot.api.setMyCommands(botCommands("ru"));
  for (const l of ["uz", "en"] as const) await bot.api.setMyCommands(botCommands(l), { language_code: l });
}
