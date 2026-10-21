import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveTelegramLogin, getTelegramLogin, settleTelegramLogin } from "../src/auth/telegram.js";
import { contactPhone, createBot } from "../src/bot/index.js";
import { invitations, usageEvents, users } from "../src/db/schema.js";
import { bt } from "../src/i18n.js";
import { maskPhone, TELEGRAM_PHONE_MISMATCH, TELEGRAM_TAKEN } from "../src/services/phone.js";
import { sessionCookie, testContext } from "./helpers.js";

/**
 * Этап 5, проверка «Подключить Telegram» на попытках захвата аккаунта (docs/invito-integration.md, 3.1):
 * ссылка подключения t.me/<бот>?start=auth_<nonce> попала к другому человеку. Бот этого же сервера
 * в процессе (обновления через handleUpdate, запросы к Bot API перехватываются), сайт — через HTTP API.
 * Telegram не вызывается. Права админа — по ADMIN_PHONES и ADMIN_TELEGRAM_IDS этого окружения.
 */
const ADMIN_PHONE = "998946660000";
const ADMIN_PHONE_2 = "998946660001";
const ADMIN_TG = 94_700;
const ADMIN_TG_2 = 94_701;
const t = testContext({ ADMIN_PHONES: `${ADMIN_PHONE},${ADMIN_PHONE_2}`, ADMIN_TELEGRAM_IDS: `1,${ADMIN_TG},${ADMIN_TG_2}` });
const { db, redis, req, smsSent } = t;
const BOT_TOKEN = "123:abc";

const userOf = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];
const byTelegram = async (tg: number) => (await db.select().from(users).where(eq(users.telegramId, tg)))[0];
const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;
const sessionOf = (id: string) => `session=${t.app.jwt.sign({ sub: id })}`;
const events = async (userId: string, type: string) => db.select().from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.type, type)));
const invitationsOf = async (userId: string) => db.select().from(invitations).where(eq(invitations.userId, userId));
/** Аккаунт, созданный входом по номеру (без Telegram). */
const account = async (phone: string, extra: Partial<typeof users.$inferInsert> = {}) => (await db.insert(users).values({ phone, ...extra }).returning())[0]!;
const me = async (session: string) => (await req(session, "GET", "/api/auth/me")).json().user;

/** Бот без сети: запросы к Bot API сохраняются в calls, обновления подаются через handleUpdate. */
function botHarness() {
  const bot = createBot(t.app.ctx);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Invite",
    username: "invite_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as typeof bot.botInfo;
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: true } as never;
  });
  let id = 1;
  const date = Math.floor(Date.now() / 1000);
  const from = (tg: number) => ({ id: tg, is_bot: false, first_name: "Гость", language_code: "ru" });
  const chat = (tg: number) => ({ id: tg, type: "private" as const, first_name: "Гость" });
  const message = (tg: number, text: string) => {
    const command = text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {};
    return bot.handleUpdate({ update_id: id++, message: { message_id: id, date, chat: chat(tg), from: from(tg), text, ...command } } as never);
  };
  /** Контакт: owner — чей это контакт (user_id), null — карточка без user_id (номер не из Telegram). */
  const contact = (tg: number, phone: string, owner: number | null = tg) =>
    bot.handleUpdate({
      update_id: id++,
      message: {
        message_id: id,
        date,
        chat: chat(tg),
        from: from(tg),
        contact: { phone_number: phone, first_name: "Кто-то", ...(owner !== null && { user_id: owner }) },
      },
    } as never);
  const press = (tg: number, data: string) =>
    bot.handleUpdate({
      update_id: id++,
      callback_query: { id: String(id), from: from(tg), chat_instance: "ci", data, message: { message_id: 1, date, chat: chat(tg), text: "…" } },
    } as never);
  const of = (method: string) => calls.filter((c) => c.method === method);
  const replies = () => of("sendMessage").map((c) => c.payload.text as string);
  const edits = () => of("editMessageText").map((c) => c.payload.text as string);
  /** Кнопки под сообщениями бота (inline): по ним видно, предлагал ли бот «Подключить». */
  const buttons = () => of("sendMessage").flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  return { bot, calls, message, contact, press, of, replies, edits, buttons };
}

function signInitData(fields: Record<string, string>) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const initDataOf = (tg: number) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: tg, first_name: "Mini", language_code: "ru" }) });

/** Вход мини-аппа этим Telegram: ответ /webapp и пользователь его сессии. */
async function webapp(tg: number) {
  const res = (await req(null, "POST", "/api/auth/webapp", { initData: initDataOf(tg) })).json();
  if (res.status !== "ok") return { res, user: null };
  return { res, user: (await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${res.token}` })).json().user };
}

/** Начало входа или подключения Telegram: nonce и cookie этого браузера (с сессией, если она передана). */
async function tgStart(session: string | null) {
  const res = await req(session, "POST", "/api/auth/telegram/start");
  expect(res.statusCode, res.body).toBe(200);
  const tg = `tglogin=${cookieOf(res, "tglogin")}`;
  return { nonce: res.json().nonce as string, browser: session ? `${session}; ${tg}` : tg };
}
const poll = (browser: string, nonce: string, headers: Record<string, string> = {}) => req(browser, "POST", "/api/auth/telegram/poll", { nonce }, headers);

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("«Подключить Telegram»: попытки захвата по чужой ссылке", () => {
  it("свежий Telegram по ссылке жертвы (админ по номеру): отказ, а его вход — в свой аккаунт мини-аппом, ботом и ссылкой /login", async () => {
    const h = botHarness();
    const victim = await account(ADMIN_PHONE, { firstName: "Жертва", freeAccess: true, freeAccessNote: "свои", isAdmin: true });
    const cookie = sessionOf(victim.id);
    expect((await req(cookie, "POST", "/api/invitations", { template: "wedding-classic" })).statusCode).toBe(201);
    const { nonce, browser } = await tgStart(cookie);

    const attacker = 94_001;
    const own = "998946661001";
    await h.message(attacker, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    // Подделанное нажатие «Подключить» без номера: снова просьба о контакте, ничего не меняется.
    await h.press(attacker, `auth:${nonce}`);
    expect(h.edits()).toEqual([]);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink"), bt("ru", "askPhoneLink")]);
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null });

    await h.contact(attacker, `+${own}`);
    expect(h.replies().slice(2)).toEqual([bt("ru", "phoneLinked", { phone: "+998 94 666-10-01" }), TELEGRAM_PHONE_MISMATCH]);
    expect(h.buttons()).toEqual([]);
    expect(h.replies().join("\n")).not.toContain(maskPhone(ADMIN_PHONE));

    // Браузер жертвы: отказ, новой сессии нет, вход прежний.
    const res = await poll(browser, nonce);
    expect(res.json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(sessionCookie(res)).toBeNull();
    expect(await me(cookie)).toMatchObject({ id: victim.id, telegramId: null, isAdmin: true, freeAccess: true });

    // Аккаунт жертвы и его данные на месте; Telegram нападающего — отдельный аккаунт без прав и доступа.
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, phone: ADMIN_PHONE, firstName: "Жертва", freeAccess: true, freeAccessNote: "свои", isAdmin: true });
    expect(await invitationsOf(victim.id)).toHaveLength(1);
    expect(await events(victim.id, "telegram_linked")).toHaveLength(0);
    const row = (await byTelegram(attacker))!;
    expect(row).toMatchObject({ phone: own, isAdmin: false, freeAccess: false });
    expect(row.id).not.toBe(victim.id);
    expect(await invitationsOf(row.id)).toHaveLength(0);

    // Мини-апп этим Telegram — его собственный аккаунт, не админка.
    const mini = await webapp(attacker);
    expect(mini.res).toMatchObject({ status: "ok", redirect: "/app/" });
    expect(mini.user).toMatchObject({ id: row.id, phone: own, isAdmin: false, freeAccess: false });

    // Обычный вход через бота из своего браузера — тоже в свой аккаунт.
    const plain = await tgStart(null);
    await h.message(attacker, `/start auth_${plain.nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLogin", { device: "браузер" }));
    await h.press(attacker, `auth:${plain.nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginConfirmed"));
    const ok = await poll(plain.browser, plain.nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect((await me(sessionCookie(ok)!)).id).toBe(row.id);

    // Ссылка входа из /login — тоже.
    await h.message(attacker, "/login");
    const url = h.replies().at(-1)!.match(/https?:\/\/\S+/)![0];
    const link = await t.app.inject({ url: url.replace(/^https?:\/\/[^/]+/, "") });
    expect(link.headers.location).toBe("/app/");
    expect((await me(sessionCookie(link)!)).id).toBe(row.id);
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, isAdmin: true });
  });

  it("чужая карточка контакта (контакт жертвы, без user_id) не подтверждает номер; запрос ждёт свой", async () => {
    const h = botHarness();
    const victimPhone = "998946662001";
    const victim = await account(victimPhone);
    const { nonce, browser } = await tgStart(sessionOf(victim.id));
    const attacker = 94_011;
    await h.message(attacker, `/start auth_${nonce}`);

    // Карточка контакта жертвы (её Telegram — 94_019) и карточка с её номером без user_id.
    await h.contact(attacker, `+${victimPhone}`, 94_019);
    await h.contact(attacker, `+${victimPhone}`, null);
    expect(h.replies().slice(1)).toEqual([bt("ru", "ownPhoneOnly"), bt("ru", "ownPhoneOnly")]);
    expect(await byTelegram(attacker)).toMatchObject({ phone: null });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null });
    expect(h.buttons()).toEqual([]);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "pending" });
    // Мини-апп нападающего видит причину и в аккаунт не входит.
    expect((await webapp(attacker)).res).toEqual({ status: "phone_required", error: bt("ru", "ownPhoneOnly") });

    // Свой контакт: другой номер — отказ.
    await h.contact(attacker, "+998946662099");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null });
  });

  it("номер Telegram изменили в базе между /start и нажатием: решает база в момент нажатия", async () => {
    const h = botHarness();
    const victim = await account("998946663001");
    const cookie = sessionOf(victim.id);

    // У Telegram был номер (свой аккаунт), его стёрли до нажатия: нажатие ведёт к контакту, не к подключению.
    const a = 94_021;
    await db.insert(users).values({ telegramId: a, phone: "998946663021" });
    const first = await tgStart(cookie);
    await h.message(a, `/start auth_${first.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "confirmLink", { phone: maskPhone("998946663001"), device: "браузер" })]);
    await db.update(users).set({ phone: null }).where(eq(users.telegramId, a));
    await h.press(a, `auth:${first.nonce}`);
    expect(h.edits()).toEqual([]);
    expect(h.replies().at(-1)).toBe(bt("ru", "askPhoneLink"));
    expect((await poll(first.browser, first.nonce)).json()).toEqual({ status: "pending" });
    await h.contact(a, "+998946663022");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(first.browser, first.nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });

    // У Telegram не было номера, номер появился в базе (не из контакта) до подделанного нажатия: другой аккаунт.
    const b = 94_022;
    const second = await tgStart(cookie);
    h.calls.length = 0;
    await h.message(b, `/start auth_${second.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    await db.update(users).set({ phone: "998946663023" }).where(eq(users.telegramId, b));
    await h.press(b, `auth:${second.nonce}`);
    expect(h.edits()).toEqual([TELEGRAM_TAKEN]);
    expect((await poll(second.browser, second.nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_TAKEN });

    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, phone: "998946663001" });
    expect(await me(cookie)).toMatchObject({ id: victim.id, telegramId: null });
    expect(await events(victim.id, "telegram_linked")).toHaveLength(0);
  });

  it("двойное и повторное нажатие: подключение один раз, отказ один раз, повтор ничего не делает", async () => {
    const h = botHarness();
    const owner = await account("998946664001");
    const cookie = sessionOf(owner.id);
    const { nonce, browser } = await tgStart(cookie);
    const tg = 94_031;
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, "+998946664001");
    expect(h.buttons()).toEqual([{ text: bt("ru", "confirmLinkButton"), callback_data: `auth:${nonce}` }]);

    // Два нажатия одновременно.
    await Promise.all([h.press(tg, `auth:${nonce}`), h.press(tg, `auth:${nonce}`)]);
    expect([...h.edits()].sort()).toEqual([bt("ru", "linkConfirmed", { phone: maskPhone("998946664001") }), bt("ru", "loginExpired")].sort());
    expect(await events(owner.id, "telegram_linked")).toHaveLength(1);
    const ok = await poll(browser, nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect((await me(sessionCookie(ok)!)).id).toBe(owner.id);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "expired" });

    // Повтор кнопки, ссылки и контакта после ответа.
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginExpired"));
    await h.message(tg, `/start auth_${nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "loginExpired"));
    await h.contact(tg, "+998946664001");
    expect(h.replies().at(-1)).toBe(bt("ru", "whatNext"));
    expect(await events(owner.id, "telegram_linked")).toHaveLength(1);
    expect(await userOf(owner.id)).toMatchObject({ telegramId: tg, phone: "998946664001" });

    // Telegram другого аккаунта жмёт дважды одновременно: один отказ, браузер получает его один раз.
    const other = await account("998946664002");
    const again = await tgStart(sessionOf(other.id));
    h.calls.length = 0;
    await h.message(tg, `/start auth_${again.nonce}`);
    await Promise.all([h.press(tg, `auth:${again.nonce}`), h.press(tg, `auth:${again.nonce}`)]);
    expect([...h.edits()].sort()).toEqual([TELEGRAM_TAKEN, bt("ru", "loginExpired")].sort());
    expect((await poll(again.browser, again.nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_TAKEN });
    expect((await poll(again.browser, again.nonce)).json()).toEqual({ status: "expired" });
    expect(await userOf(other.id)).toMatchObject({ telegramId: null });
    expect(await userOf(owner.id)).toMatchObject({ telegramId: tg });
  });

  it("владелец и чужой Telegram на одном запросе: чужой может только сорвать запрос, но не подключиться", async () => {
    const h = botHarness();
    const owner = await account("998946665001");
    const cookie = sessionOf(owner.id);
    const { nonce, browser } = await tgStart(cookie);
    const mine = 94_041;
    const stranger = 94_042;
    await h.message(mine, `/start auth_${nonce}`);
    await h.message(stranger, `/start auth_${nonce}`);
    await h.contact(stranger, "+998946665042");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    // Контакт владельца — подтверждение номера: Telegram объединяется с аккаунтом, как при обычном входе,
    // но запрос уже завершён отказом, поэтому кнопки нет.
    await h.contact(mine, "+998946665001");
    expect(h.replies().at(-1)).toBe(bt("ru", "loginExpired"));
    expect(h.buttons()).toEqual([]);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(owner.id)).toMatchObject({ telegramId: mine });
    expect(await byTelegram(stranger)).toMatchObject({ phone: "998946665042" });
    expect((await webapp(stranger)).user).toMatchObject({ phone: "998946665042" });
    expect((await webapp(stranger)).user.id).not.toBe(owner.id);
  });
});

describe("номер из контакта Telegram — международный", () => {
  it("девять цифр — короткий номер другой страны, а не узбекский без +998", () => {
    expect(contactPhone("+998 90 123 45 67")).toBe("998901234567");
    expect(contactPhone("998901234567")).toBe("998901234567");
    expect(contactPhone("+7 999 123 45 67")).toBe("79991234567");
    // Сен-Пьер и Микелон (+508), Мьянма (+95 9…): номер Telegram из девяти цифр.
    expect(contactPhone("+508551234")).toBe("508551234");
    expect(contactPhone("959123456")).toBe("959123456");
    // 998 с неверным числом цифр и слишком короткий номер не принимаются.
    expect(contactPhone("99890123456")).toBeNull();
    expect(contactPhone("998901234")).toBeNull();
    expect(contactPhone("+683 400")).toBeNull();
  });

  it("Telegram с номером +508 55 12 34 не входит в аккаунт +998 50 855-12-34 и не подключается к нему", async () => {
    const h = botHarness();
    const victim = await account("998508551234", { firstName: "Ucell" });
    const cookie = sessionOf(victim.id);
    const { nonce, browser } = await tgStart(cookie);
    const attacker = 94_111;
    await h.message(attacker, `/start auth_${nonce}`);
    await h.contact(attacker, "+508551234");
    expect(h.replies().slice(1)).toEqual([bt("ru", "phoneLinked", { phone: "+508551234" }), TELEGRAM_PHONE_MISMATCH]);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, phone: "998508551234" });
    expect(await byTelegram(attacker)).toMatchObject({ phone: "508551234" });

    // Мини-апп Telegram с номером +95 9 123 456 — его собственный аккаунт, а не аккаунт +998 95 912-34-56 (вход по SMS).
    const victim2 = await account("998959123456");
    const other = 94_112;
    expect((await webapp(other)).res).toEqual({ status: "phone_required" });
    await h.contact(other, "959123456");
    const mini = await webapp(other);
    expect(mini.user).toMatchObject({ phone: "959123456" });
    expect(mini.user.id).not.toBe(victim2.id);
    expect(await userOf(victim2.id)).toMatchObject({ telegramId: null, phone: "998959123456" });
  });
});

describe("«Подключить Telegram»: обычный вход и подключение, истёкший запрос, блокировка", () => {
  it("подтверждение обычного входа не завершает запрос подключения (браузер не переключается на чужой аккаунт)", async () => {
    const victim = await account("998946666001");
    const cookie = sessionOf(victim.id);
    const { nonce, browser } = await tgStart(cookie);
    const { user: stranger } = await t.login(94_051);
    // Сервис: вход другим пользователем по nonce подключения не проходит, запрос ждёт дальше.
    expect(await approveTelegramLogin(t.cache, nonce, stranger.id)).toBe(false);
    expect(await settleTelegramLogin(t.cache, nonce, { userId: stranger.id })).toBe(false);
    expect(await getTelegramLogin(t.cache, nonce)).not.toHaveProperty("userId");
    const res = await poll(browser, nonce);
    expect(res.json()).toEqual({ status: "pending" });
    expect(sessionCookie(res)).toBeNull();
    // Отказ и вход в свой же аккаунт по-прежнему завершают запрос.
    expect(await settleTelegramLogin(t.cache, nonce, { userId: victim.id })).toBe(true);
    const ok = await poll(browser, nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect((await me(sessionCookie(ok)!)).id).toBe(victim.id);
    // Обычный вход (без сессии при start) подтверждается любым пользователем бота, как раньше.
    const plain = await tgStart(null);
    expect(await approveTelegramLogin(t.cache, plain.nonce, stranger.id)).toBe(true);
  });

  it("бот: запрос подключения жертвы и свой обычный вход у одного Telegram не смешиваются", async () => {
    const h = botHarness();
    const victim = await account("998946666101");
    const cookie = sessionOf(victim.id);
    const connect = await tgStart(cookie);
    const plain = await tgStart(null);
    const attacker = 94_061;

    // Сначала ссылка жертвы, затем свой вход: контакт продолжает последний запрос — свой вход.
    await h.message(attacker, `/start auth_${connect.nonce}`);
    await h.message(attacker, `/start auth_${plain.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink"), bt("ru", "askPhone")]);
    await h.contact(attacker, "+998946666161");
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLogin", { device: "браузер" }));
    await h.press(attacker, `auth:${plain.nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginConfirmed"));
    const ok = await poll(plain.browser, plain.nonce);
    const own = (await byTelegram(attacker))!;
    expect((await me(sessionCookie(ok)!)).id).toBe(own.id);
    expect((await poll(connect.browser, connect.nonce)).json()).toEqual({ status: "pending" });

    // Кнопка запроса жертвы (подделанная, у Telegram уже свой номер) — не вход, а отказ подключения.
    await h.press(attacker, `auth:${connect.nonce}`);
    expect(h.edits().at(-1)).toBe(TELEGRAM_TAKEN);
    const res = await poll(connect.browser, connect.nonce);
    expect(res.json()).toEqual({ status: "conflict", error: TELEGRAM_TAKEN });
    expect(sessionCookie(res)).toBeNull();
    expect(await me(cookie)).toMatchObject({ id: victim.id, telegramId: null });

    // Обратный порядок: свой вход, затем ссылка жертвы — контакт продолжает подключение, отказ.
    const victim2 = await account("998946666102");
    const connect2 = await tgStart(sessionOf(victim2.id));
    const plain2 = await tgStart(null);
    const attacker2 = 94_062;
    await h.message(attacker2, `/start auth_${plain2.nonce}`);
    await h.message(attacker2, `/start auth_${connect2.nonce}`);
    await h.contact(attacker2, "+998946666162");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(connect2.browser, connect2.nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    // Свой вход по-прежнему проходит по ссылке заново.
    await h.message(attacker2, `/start auth_${plain2.nonce}`);
    await h.press(attacker2, `auth:${plain2.nonce}`);
    const ok2 = await poll(plain2.browser, plain2.nonce);
    expect((await me(sessionCookie(ok2)!)).id).toBe((await byTelegram(attacker2))!.id);
    expect(await userOf(victim2.id)).toMatchObject({ telegramId: null });
  });

  it("запрос истёк, пока бот ждал контакт: продолжения нет, аккаунт не меняется", async () => {
    const h = botHarness();
    const victim = await account("998946667001");
    const { nonce, browser } = await tgStart(sessionOf(victim.id));
    const attacker = 94_071;
    await h.message(attacker, `/start auth_${nonce}`);
    expect(await redis.exists(`inv:bot:pending-start:${attacker}`)).toBe(1);
    // Запрос истёк (5 минут), а ожидание контакта у бота ещё живо.
    await redis.del(`inv:tglogin:${nonce}`);
    await h.contact(attacker, "+998946667071");
    expect(h.replies().slice(1)).toEqual([bt("ru", "phoneLinked", { phone: "+998 94 666-70-71" }), bt("ru", "loginExpired")]);
    expect(h.buttons()).toEqual([]);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "expired" });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null });

    // Истёк и запрос, к которому пришёл отклонённый контакт (номер у другого Telegram): только причина контакта.
    const { user: taken } = await t.login(94_079);
    const second = await tgStart(sessionOf(victim.id));
    await h.message(94_072, `/start auth_${second.nonce}`);
    await redis.del(`inv:tglogin:${second.nonce}`);
    await h.contact(94_072, `+${taken.phone}`);
    expect(h.replies().at(-1)).toBe("Этот номер уже привязан к другому Telegram-аккаунту");
    expect((await poll(second.browser, second.nonce)).json()).toEqual({ status: "expired" });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null });
  });

  it("заблокированный Telegram (запись админа) бот не слушает: ни контакта, ни подключения", async () => {
    const h = botHarness();
    const victim = await account("998946668001");
    const { nonce, browser } = await tgStart(sessionOf(victim.id));
    const blocked = 94_081;
    await db.insert(users).values({ telegramId: blocked, blocked: true });
    await h.message(blocked, `/start auth_${nonce}`);
    await h.press(blocked, `auth:${nonce}`);
    // Даже контакт с номером аккаунта (как если бы это был его Telegram).
    await h.contact(blocked, "+998946668001");
    expect(h.calls).toEqual([]);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "pending" });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, blocked: false });
    expect((await req(null, "POST", "/api/auth/webapp", { initData: initDataOf(blocked) })).statusCode).toBe(403);
  });

  it("аккаунт заблокировали после контакта и подтверждения: нажатие не подключает и не выдаёт сессию", async () => {
    const h = botHarness();
    const owner = await account("998946668101");
    const { nonce, browser } = await tgStart(sessionOf(owner.id));
    const tg = 94_082;
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, "+998946668101");
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLink", { phone: maskPhone("998946668101"), device: "браузер" }));
    await db.update(users).set({ blocked: true }).where(eq(users.id, owner.id));
    await redis.del(`inv:user:${owner.id}`);
    // Telegram теперь в заблокированном аккаунте: бот его не слушает, запрос не завершается.
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits()).toEqual([]);
    const res = await poll(browser, nonce);
    expect(res.json()).toEqual({ status: "pending" });
    expect(sessionCookie(res)).toBeNull();
    expect(await events(owner.id, "telegram_linked")).toHaveLength(0);
    expect((await req(null, "POST", "/api/auth/webapp", { initData: initDataOf(tg) })).statusCode).toBe(403);
  });
});

describe("«Подключить Telegram»: записи выдачи доступа и права админа", () => {
  it("запись /grant по Telegram ID и номер аккаунта: объединение, доступ и заметка остаются, не админ", async () => {
    const h = botHarness();
    await t.login(1);
    const tg = 94_091;
    await h.message(1, `/grant tg:${tg} подарок`);
    expect(await byTelegram(tg)).toMatchObject({ phone: null, freeAccess: true, freeAccessNote: "подарок", isAdmin: false });
    const owner = await account("998946669001");
    const { nonce, browser } = await tgStart(sessionOf(owner.id));
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, "+998946669001");
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "linkConfirmed", { phone: maskPhone("998946669001") }));
    const ok = await poll(browser, nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect(await userOf(owner.id)).toMatchObject({ telegramId: tg, freeAccess: true, freeAccessNote: "подарок", isAdmin: false });
    expect(await db.select().from(users).where(eq(users.telegramId, tg))).toHaveLength(1);
    expect((await webapp(tg)).user).toMatchObject({ id: owner.id, freeAccess: true, isAdmin: false });
  });

  it("запись выдачи доступа (админка) для Telegram ID из ADMIN_TELEGRAM_IDS: аккаунт с тем же номером становится админским", async () => {
    const h = botHarness();
    const { cookie: admin } = await t.login(1);
    expect((await req(admin, "POST", "/api/admin/users/free-access", { who: `tg:${ADMIN_TG}`, note: "команда" })).statusCode).toBe(200);
    const owner = await account("998946669101");
    const { nonce, browser } = await tgStart(sessionOf(owner.id));
    await h.message(ADMIN_TG, `/start auth_${nonce}`);
    await h.contact(ADMIN_TG, "+998946669101");
    await h.press(ADMIN_TG, `auth:${nonce}`);
    const ok = await poll(browser, nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/admin/" });
    expect(await userOf(owner.id)).toMatchObject({ telegramId: ADMIN_TG, isAdmin: true, freeAccess: true, freeAccessNote: "команда" });
    expect(await me(sessionCookie(ok)!)).toMatchObject({ id: owner.id, isAdmin: true });
  });

  it("запись выдачи доступа и аккаунт админа по номеру: объединение, права админа остаются", async () => {
    const h = botHarness();
    const tg = 94_092;
    await db.insert(users).values({ telegramId: tg, freeAccess: true });
    const owner = await account(ADMIN_PHONE_2, { isAdmin: true });
    const { nonce, browser } = await tgStart(sessionOf(owner.id));
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, `+${ADMIN_PHONE_2}`);
    await h.press(tg, `auth:${nonce}`);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "ok", redirect: "/admin/" });
    expect(await userOf(owner.id)).toMatchObject({ telegramId: tg, isAdmin: true, freeAccess: true });
  });

  it("Telegram админа (запись выдачи доступа) по ссылке чужого аккаунта с другим номером: аккаунт не становится админским", async () => {
    const h = botHarness();
    await db.insert(users).values({ telegramId: ADMIN_TG_2, freeAccess: true, freeAccessNote: "админ" });
    const victim = await account("998946669201");
    const cookie = sessionOf(victim.id);
    const { nonce, browser } = await tgStart(cookie);
    await h.message(ADMIN_TG_2, `/start auth_${nonce}`);
    await h.contact(ADMIN_TG_2, "+998946669202");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(victim.id)).toMatchObject({ telegramId: null, isAdmin: false, freeAccess: false, freeAccessNote: null });
    expect(await me(cookie)).toMatchObject({ id: victim.id, isAdmin: false });
    expect(await byTelegram(ADMIN_TG_2)).toMatchObject({ phone: "998946669202", isAdmin: true, freeAccess: true, freeAccessNote: "админ" });
  });
});

describe("обычный вход через Telegram и мини-апп по-прежнему работают", () => {
  async function smsAccount(phone: string) {
    smsSent.length = 0;
    expect((await req(null, "POST", "/api/auth/phone/request", { phone })).statusCode).toBe(200);
    const code = smsSent.find((s) => s.phone === phone)!.text.match(/\d{6}/)![0];
    const res = await req(null, "POST", "/api/auth/phone/verify", { phone, code });
    expect(res.statusCode, res.body).toBe(200);
    const session = sessionCookie(res)!;
    return { id: (await me(session)).id as string, session };
  }

  it("вход на сайте через бота: номер один раз, объединение с аккаунтом по SMS с тем же номером", async () => {
    const h = botHarness();
    const sms = await smsAccount("998946670001");
    expect((await req(sms.session, "POST", "/api/invitations", { template: "wedding-classic" })).statusCode).toBe(201);
    const tg = 94_101;
    const plain = await tgStart(null);
    await h.message(tg, `/start auth_${plain.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhone")]);
    await h.contact(tg, "+998946670001");
    expect(h.replies().slice(1)).toEqual([bt("ru", "phoneLinked", { phone: "+998 94 667-00-01" }), bt("ru", "confirmLogin", { device: "браузер" })]);
    await h.press(tg, `auth:${plain.nonce}`);
    expect(h.edits()).toEqual([bt("ru", "loginConfirmed")]);
    const ok = await poll(plain.browser, plain.nonce);
    expect(ok.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect(await me(sessionCookie(ok)!)).toMatchObject({ id: sms.id, telegramId: String(tg), phone: "998946670001" });
    expect(await invitationsOf(sms.id)).toHaveLength(1);
    expect(await events(sms.id, "login")).toHaveLength(2);

    // Второй вход: номер уже есть, бот его не спрашивает.
    const next = await tgStart(null);
    h.calls.length = 0;
    await h.message(tg, `/start auth_${next.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "confirmLogin", { device: "браузер" })]);
    await h.press(tg, `auth:${next.nonce}`);
    expect((await me(sessionCookie(await poll(next.browser, next.nonce))!)).id).toBe(sms.id);
  });

  it("мини-апп: номер один раз, объединение с аккаунтом по SMS с тем же номером", async () => {
    const h = botHarness();
    const sms = await smsAccount("998946670101");
    const tg = 94_102;
    expect((await webapp(tg)).res).toEqual({ status: "phone_required" });
    await h.contact(tg, "+998946670101");
    expect(h.replies()).toEqual([bt("ru", "phoneLinked", { phone: "+998 94 667-01-01" }), bt("ru", "whatNext")]);
    const mini = await webapp(tg);
    expect(mini.res).toMatchObject({ status: "ok", redirect: "/app/" });
    expect(mini.user).toMatchObject({ id: sms.id, telegramId: String(tg), phone: "998946670101" });
    await h.message(tg, "/start");
    expect(h.replies().at(-1)).toBe(bt("ru", "welcome"));
  });
});
