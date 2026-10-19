import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { count, gt } from "drizzle-orm";
import { issueLoginCode } from "../auth/codes.js";
import { approveTelegramLogin, getTelegramLogin, isNonce } from "../auth/telegram.js";
import type { Ctx } from "../context.js";
import { invitations, users, type User } from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { bt, dateLocale, localeNames, locales, pickLocale, translateError, type Locale } from "../i18n.js";
import { getPrices } from "../services/settings.js";
import { listOwnInvitations } from "../services/invitations.js";
import { attachPhoneToTelegramUser, formatPhone, normalizePhone } from "../services/phone.js";
import { track } from "../services/usage.js";
import { getAccess, invalidateUser, setUserLocale, upsertTelegramUser } from "../services/users.js";

export type BotContext = Context & { user: User; lang: Locale };

export function formatMoney(minor: number, currency: string, l: Locale = "ru") {
  const unit = currency !== "UZS" ? currency : l === "ru" ? "сум" : l === "uz" ? "so'm" : l === "uzc" ? "сўм" : "UZS";
  return `${(minor / 100).toLocaleString(dateLocale[l], { maximumFractionDigits: 2 })} ${unit}`;
}

/** Номер из контакта Telegram: узбекский приводим к 998XXXXXXXXX, остальные храним цифрами. */
export function contactPhone(raw: string): string | null {
  const uz = normalizePhone(raw);
  if (uz) return uz;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export function createBot(ctx: Ctx) {
  const bot = new Bot<BotContext>(ctx.config.TELEGRAM_BOT_TOKEN);
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  // Telegram принимает в кнопках только публичные https-ссылки.
  const canUseUrlButtons = appUrl.startsWith("https://");
  const pendingKey = (tgId: number) => `bot:pending-login:${tgId}`;
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

  const askPhone = (c: BotContext) =>
    c.reply(bt(c.lang, "askPhone"), {
      reply_markup: new Keyboard().requestContact(bt(c.lang, "sharePhoneButton")).resized().oneTime(),
    });

  async function askLoginConfirm(c: BotContext, nonce: string) {
    const login = await getTelegramLogin(ctx.cache, nonce);
    if (!login || login.userId) return void (await c.reply(bt(c.lang, "loginExpired")));
    await c.reply(bt(c.lang, "confirmLogin", { device: login.device }), {
      reply_markup: new InlineKeyboard().text(bt(c.lang, "confirmButton"), `auth:${nonce}`),
    });
  }

  async function sendLoginLink(c: BotContext) {
    const code = await issueLoginCode(ctx.cache, c.user.id);
    const url = `${appUrl}/api/auth/link?code=${code}`;
    const text = bt(c.lang, "loginLink");
    if (canUseUrlButtons) await c.reply(text, { reply_markup: new InlineKeyboard().url(bt(c.lang, "menuLogin"), url) });
    else await c.reply(`${text}\n${url}`, { link_preview_options: { is_disabled: true } });
  }

  bot.command("start", async (c) => {
    await track(ctx, c.user.id, "bot_start");
    const payload = c.match;
    // t.me/<бот>?start=auth_<nonce> приходит с кнопки «Войти через Telegram» на сайте.
    if (payload.startsWith("auth_") && isNonce(payload.slice(5))) {
      const nonce = payload.slice(5);
      if (!c.user.phone) {
        await ctx.cache.set(pendingKey(c.from!.id), nonce, 300);
        return void (await askPhone(c));
      }
      return askLoginConfirm(c, nonce);
    }
    if (!c.user.phone) return void (await askPhone(c));
    await c.reply(bt(c.lang, "welcome"), { reply_markup: menu(c.lang) });
  });

  bot.on("message:contact", async (c) => {
    const contact = c.message.contact;
    // Принимаем только собственный номер, отправленный кнопкой, а не чужой контакт.
    if (contact.user_id !== c.from.id) return void (await c.reply(bt(c.lang, "ownPhoneOnly")));
    const phone = contactPhone(contact.phone_number);
    if (!phone) return void (await c.reply(bt(c.lang, "badPhone")));
    try {
      c.user = await attachPhoneToTelegramUser(ctx, c.user, phone);
    } catch (err) {
      if (err instanceof HttpError) return void (await c.reply(translateError(err.message, c.lang), { reply_markup: { remove_keyboard: true } }));
      throw err;
    }
    await c.reply(bt(c.lang, "phoneLinked", { phone: phone.startsWith("998") ? formatPhone(phone) : `+${phone}` }), { reply_markup: { remove_keyboard: true } });
    const nonce = await ctx.cache.take<string>(pendingKey(c.from.id));
    if (nonce) await askLoginConfirm(c, nonce);
    else await c.reply(bt(c.lang, "whatNext"), { reply_markup: menu(c.lang) });
  });

  bot.callbackQuery(/^auth:([\w-]+)$/, async (c) => {
    if (!c.user.phone) {
      await c.answerCallbackQuery();
      return void (await askPhone(c));
    }
    const ok = await approveTelegramLogin(ctx.cache, c.match[1]!, c.user.id);
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
          ? bt(l, "accessSub", { date: access.subscriptionEndsAt.toLocaleDateString(dateLocale[l]) })
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

  async function setFree(c: BotContext, free: boolean) {
    const [idArg, ...note] = (c.message?.text ?? "").split(/\s+/).slice(1);
    const usage = `Использование: /${free ? "grant" : "revoke"} <telegram_id или телефон>${free ? " [заметка]" : ""}`;
    if (!idArg) return void (await c.reply(usage));
    const phone = normalizePhone(idArg);
    const telegramId = Number(idArg);
    if (!phone && (!Number.isSafeInteger(telegramId) || telegramId <= 0)) return void (await c.reply(usage));
    const noteText = note.join(" ") || null;
    const target = phone ? { phone } : { telegramId };
    const [u] = await ctx.db
      .insert(users)
      .values({ ...target, freeAccess: free, freeAccessNote: noteText })
      .onConflictDoUpdate({ target: phone ? users.phone : users.telegramId, set: { freeAccess: free, ...(free && { freeAccessNote: noteText }) } })
      .returning();
    await invalidateUser(ctx, u!.id);
    await track(ctx, u!.id, free ? "free_access_granted" : "free_access_revoked", { adminId: c.user.id, via: "bot" });
    await c.reply(free ? `Бесплатный доступ выдан: ${idArg}` : `Бесплатный доступ снят: ${idArg}`);
  }
  admin.command("grant", (c) => setFree(c, true));
  admin.command("revoke", (c) => setFree(c, false));

  verified.on("message", (c) => c.reply(bt(c.lang, "unknown")));

  bot.catch((err) => ctx.log.error({ err: err.error, update: err.ctx.update.update_id }, "ошибка бота"));

  return bot;
}

export async function setBotCommands(bot: Bot<BotContext>) {
  await bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "login", description: "Войти на сайт" },
    { command: "my", description: "Мои приглашения" },
    { command: "prices", description: "Тарифы" },
    { command: "lang", description: "Язык / Til / Language" },
  ]);
}
