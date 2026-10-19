import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/index.js";
import { guests, invitations, subscriptions, templates, usageEvents, users } from "../src/db/schema.js";
import { bt, translateError } from "../src/i18n.js";
import { linkTelegramToUser, maskPhone, TELEGRAM_PHONE_MISMATCH, TELEGRAM_TAKEN } from "../src/services/phone.js";
import { dueReminders, sendDueReminders } from "../src/services/reminders.js";
import { defaultInvitationSettings } from "../src/db/schema.js";
import { APP_URL, phoneOf, sessionCookie, testContext } from "./helpers.js";
import { signInitData } from "./telegram.test.js";

/**
 * Этап 4, бэкенд: токен в ответе входа по флагу bearer, причина отказа в контакте для мини-аппа,
 * «Подключить Telegram» из аккаунта, стёртые дата и время, лимит гостей в запросе, дата подписки
 * в боте по Ташкенту и заголовки фреймов у страницы «не найдено».
 */
const t = testContext();
const { db, redis, smsSent, telegram, login, req, pay } = t;
const template = "wedding-classic";

let nextUser = 90_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);
const userOf = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];
const byTelegram = async (tg: number) => (await db.select().from(users).where(eq(users.telegramId, tg)))[0];
const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name)?.value;
const metaOf = (html: string, prop: string) =>
  [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].find((m) => m[1] === prop)?.[2];

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
  const from = (tg: number, lang = "ru") => ({ id: tg, is_bot: false, first_name: "Гость", language_code: lang });
  const chat = (tg: number) => ({ id: tg, type: "private" as const, first_name: "Гость" });
  const message = (tg: number, text: string) => {
    const command = text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {};
    return bot.handleUpdate({ update_id: id++, message: { message_id: id, date, chat: chat(tg), from: from(tg), text, ...command } } as never);
  };
  const contact = (tg: number, phone: string, owner = tg) =>
    bot.handleUpdate({
      update_id: id++,
      message: { message_id: id, date, chat: chat(tg), from: from(tg), contact: { phone_number: phone, first_name: "Гость", user_id: owner } },
    } as never);
  const press = (tg: number, data: string) =>
    bot.handleUpdate({
      update_id: id++,
      callback_query: { id: String(id), from: from(tg), chat_instance: "ci", data, message: { message_id: 1, date, chat: chat(tg), text: "…" } },
    } as never);
  const of = (method: string) => calls.filter((c) => c.method === method);
  const replies = () => of("sendMessage").map((c) => c.payload.text as string);
  const edits = () => of("editMessageText").map((c) => c.payload.text as string);
  return { bot, calls, message, contact, press, of, replies, edits };
}

/** initData мини-аппа для Telegram ID tg. */
const initDataOf = (tg: number) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: tg, first_name: "Mini", language_code: "ru" }) });

/** Код из последнего SMS на номер. */
async function otpFor(phone: string) {
  smsSent.length = 0;
  expect((await req(null, "POST", "/api/auth/phone/request", { phone })).statusCode).toBe(200);
  return smsSent.find((s) => s.phone === phone)!.text.match(/\d{6}/)![0];
}

/** Начало входа или подключения Telegram: nonce и cookie этого браузера (с сессией, если она передана). */
async function tgStart(session: string | null, headers: Record<string, string> = {}) {
  const res = await req(session, "POST", "/api/auth/telegram/start", undefined, headers);
  expect(res.statusCode, res.body).toBe(200);
  const tg = `tglogin=${cookieOf(res, "tglogin")}`;
  return { nonce: res.json().nonce as string, browser: session ? `${session}; ${tg}` : tg };
}
const poll = (browser: string, nonce: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  req(browser, "POST", "/api/auth/telegram/poll", { nonce, ...body }, headers);

async function create(cookie: string, body: Record<string, unknown>) {
  const res = await req(cookie, "POST", "/api/invitations", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; slug: string; data: Record<string, unknown> };
}

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("токен сессии в ответе входа (bearer)", () => {
  it("POST /phone/verify отдаёт token только с bearer: true", async () => {
    const plain = await req(null, "POST", "/api/auth/phone/verify", { phone: "998935550001", code: await otpFor("998935550001") });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect(sessionCookie(plain)).not.toBeNull();

    const tg = await req(null, "POST", "/api/auth/phone/verify", { phone: "998935550002", code: await otpFor("998935550002"), bearer: true });
    const body = tg.json();
    expect(body).toMatchObject({ status: "ok", redirect: "/app/" });
    // Тот же JWT, что и в cookie: с ним работают запросы с Authorization: Bearer.
    expect(body.token).toBe(cookieOf(tg, "session"));
    const me = await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${body.token}` });
    expect(me.json().user.phone).toBe("998935550002");

    // bearer: false — как без флага; не boolean — 400.
    const off = await req(null, "POST", "/api/auth/phone/verify", { phone: "998935550003", code: await otpFor("998935550003"), bearer: false });
    expect(off.json()).not.toHaveProperty("token");
    expect((await req(null, "POST", "/api/auth/phone/verify", { phone: "998935550004", code: "123456", bearer: "yes" })).statusCode).toBe(400);
  });

  it("POST /telegram/poll отдаёт token только с bearer: true", async () => {
    const h = botHarness();
    const site = await tgStart(null);
    const mini = await tgStart(null);
    for (const tg of [91_001, 91_002]) await login(tg);
    for (const [tg, s] of [[91_001, site], [91_002, mini]] as const) {
      await h.message(tg, `/start auth_${s.nonce}`);
      await h.press(tg, `auth:${s.nonce}`);
    }
    const a = await poll(site.browser, site.nonce);
    expect(a.json()).toEqual({ status: "ok", redirect: "/app/" });
    const b = await poll(mini.browser, mini.nonce, { bearer: true });
    expect(b.json()).toMatchObject({ status: "ok", token: cookieOf(b, "session") });
    const me = await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${b.json().token}` });
    expect(me.json().user.telegramId).toBe("91002");
  });
});

describe("мини-апп: причина отказа в контакте", () => {
  it("error после отклонённого контакта, новый контакт его сбрасывает", async () => {
    const h = botHarness();
    // Номер уже у аккаунта с другим Telegram.
    await login(92_001);
    const tg = 92_002;
    const initData = initDataOf(tg);
    expect((await req(null, "POST", "/api/auth/webapp", { initData })).json()).toEqual({ status: "phone_required" });

    await h.contact(tg, `+${phoneOf(92_001)}`);
    expect(h.replies().at(-1)).toBe(translateError("Этот номер уже привязан к другому Telegram-аккаунту", "ru"));
    const en = await req(null, "POST", "/api/auth/webapp", { initData }, { "x-lang": "en" });
    expect(en.json()).toEqual({ status: "phone_required", error: "This number is linked to another Telegram account" });
    expect((await req(null, "POST", "/api/auth/webapp", { initData }, { "x-lang": "ru" })).json().error).toBe("Этот номер уже привязан к другому Telegram-аккаунту");

    // Новый контакт заменяет причину: чужой контакт — текст бота на языке запроса.
    await h.contact(tg, "+998935559999", 777);
    expect((await req(null, "POST", "/api/auth/webapp", { initData }, { "x-lang": "uz" })).json()).toEqual({
      status: "phone_required",
      error: bt("uz", "ownPhoneOnly"),
    });

    // Свой свободный номер: причина сброшена, мини-апп входит.
    await h.contact(tg, "+998935550010");
    expect(await redis.exists(`inv:tgcontact:rejected:${tg}`)).toBe(0);
    const ok = (await req(null, "POST", "/api/auth/webapp", { initData })).json();
    expect(ok).toMatchObject({ status: "ok", redirect: "/app/" });
    expect(ok).not.toHaveProperty("error");
  });
});

describe("«Подключить Telegram» из аккаунта", () => {
  it("запись выдачи доступа по Telegram ID (без номера): бот просит номер, тот же номер объединяет её с аккаунтом", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935551001", firstName: "Аня" }).returning();
    const cookie = `session=${t.app.jwt.sign({ sub: owner!.id })}`;
    // Админ заранее выдал бесплатный доступ по Telegram ID (/grant в боте): запись без номера.
    const tg = 93_001;
    await login(1);
    await h.message(1, `/grant ${tg} друг`);
    expect(h.replies()).toEqual([`Бесплатный доступ выдан: Telegram ID ${tg}`]);
    const grant = await byTelegram(tg);
    expect(grant).toMatchObject({ phone: null, freeAccess: true, freeAccessNote: "друг" });
    h.calls.length = 0;

    const { nonce, browser } = await tgStart(cookie);
    expect((await poll(browser, nonce)).json().status).toBe("pending");

    // У Telegram нет номера: подключение ждёт, пока он подтвердит номер аккаунта своим контактом.
    await h.message(tg, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    expect(h.of("sendMessage").at(-1)!.payload.reply_markup.keyboard.flat()).toEqual([{ text: bt("ru", "sharePhoneButton"), request_contact: true }]);
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null, freeAccess: false });

    // Тот же номер: запись объединяется с аккаунтом (бесплатный доступ и заметка остаются), затем подтверждение.
    await h.contact(tg, "+998935551001");
    expect(h.replies().slice(1)).toEqual([
      bt("ru", "phoneLinked", { phone: "+998 93 555-10-01" }),
      bt("ru", "confirmLink", { phone: "+998 93 ***-**-01", device: "браузер" }),
    ]);
    const confirm = h.of("sendMessage").at(-1)!.payload;
    expect(confirm.reply_markup.inline_keyboard.flat()).toEqual([{ text: bt("ru", "confirmLinkButton"), callback_data: `auth:${nonce}` }]);
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: tg, freeAccess: true, freeAccessNote: "друг", phone: "998935551001", firstName: "Аня" });
    expect(await userOf(grant!.id)).toBeUndefined();
    expect(await db.select().from(users).where(eq(users.telegramId, tg))).toHaveLength(1);
    expect((await poll(browser, nonce)).json().status).toBe("pending");

    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "linkConfirmed", { phone: maskPhone("998935551001") }));
    expect(await db.select().from(usageEvents).where(and(eq(usageEvents.userId, owner!.id), eq(usageEvents.type, "telegram_linked")))).toHaveLength(1);
    // Журнал выдачи доступа перешёл к аккаунту вместе с записью.
    expect(await db.select().from(usageEvents).where(and(eq(usageEvents.userId, owner!.id), eq(usageEvents.type, "free_access_granted")))).toHaveLength(1);

    // Повторное нажатие ничего не делает.
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginExpired"));

    const ok = await poll(browser, nonce, { bearer: true });
    expect(ok.json()).toMatchObject({ status: "ok", redirect: "/app/" });
    const me = (await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${ok.json().token}` })).json();
    expect(me.user).toMatchObject({ id: owner!.id, telegramId: String(tg), freeAccess: true });
    // Подключение — не новый вход: событие login не пишется.
    expect(await db.select().from(usageEvents).where(and(eq(usageEvents.userId, owner!.id), eq(usageEvents.type, "login")))).toHaveLength(0);

    // Теперь этот Telegram входит в тот же аккаунт: мини-апп по initData и обычный вход через бота.
    const webapp = (await req(null, "POST", "/api/auth/webapp", { initData: initDataOf(tg) })).json();
    expect(webapp.status).toBe("ok");
    expect((await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${webapp.token}` })).json().user.id).toBe(owner!.id);
  });

  it("Telegram этого же аккаунта: ok без изменений; сессия по Bearer тоже запоминается", async () => {
    const h = botHarness();
    const { user: u, cookie } = await login(93_101);
    const bearer = { authorization: `Bearer ${cookie.replace(/^session=/, "")}` };
    const { nonce, browser } = await tgStart(null, bearer);
    await h.message(93_101, `/start auth_${nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLink", { phone: maskPhone(u.phone!), device: "браузер" }));
    await h.press(93_101, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "linkConfirmed", { phone: maskPhone(u.phone!) }));
    expect((await poll(browser, nonce)).json()).toEqual({ status: "ok", redirect: "/app/" });
    expect(await userOf(u.id)).toMatchObject({ telegramId: 93_101, phone: u.phone });
  });

  it("во фрейме Telegram Web без cookie tglogin подключение забирает сессия того же аккаунта", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935551501" }).returning();
    const bearer = { authorization: `Bearer ${t.app.jwt.sign({ sub: owner!.id })}` };
    const { nonce } = await tgStart(null, bearer);
    const pollAs = (session: string | null, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
      req(session, "POST", "/api/auth/telegram/poll", { nonce, ...body }, headers);
    // Ни cookie, ни сессии — expired; сессия другого аккаунта запрос не забирает.
    expect((await pollAs(null)).json()).toEqual({ status: "expired" });
    const { cookie: stranger } = await login(93_502);
    expect((await pollAs(stranger)).json()).toEqual({ status: "expired" });
    expect((await pollAs(null, bearer)).json()).toEqual({ status: "pending" });

    await h.message(93_501, `/start auth_${nonce}`);
    await h.contact(93_501, "+998935551501");
    await h.press(93_501, `auth:${nonce}`);
    expect((await pollAs(stranger)).json()).toEqual({ status: "expired" });
    const ok = (await pollAs(null, bearer, { bearer: true })).json();
    expect(ok).toMatchObject({ status: "ok", redirect: "/app/" });
    expect((await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${ok.token}` })).json().user).toMatchObject({ id: owner!.id, telegramId: "93501" });

    // Обычный вход (без сессии при start) сессией не забирается: нужен секрет браузера.
    const plain = await tgStart(null);
    await h.message(93_501, `/start auth_${plain.nonce}`);
    await h.press(93_501, `auth:${plain.nonce}`);
    expect((await req(null, "POST", "/api/auth/telegram/poll", { nonce: plain.nonce }, bearer)).json()).toEqual({ status: "expired" });
    expect((await poll(plain.browser, plain.nonce)).json().status).toBe("ok");
  });

  it("Telegram другого аккаунта (уже с другим номером): conflict, ничего не привязывается и сессия не меняется", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935551201" }).returning();
    const cookie = `session=${t.app.jwt.sign({ sub: owner!.id })}`;
    const { user: other } = await login(93_201);

    const { nonce, browser } = await tgStart(cookie);
    await h.message(93_201, `/start auth_${nonce}`);
    // Номер у этого Telegram уже есть: бот его не спрашивает, решение — по кнопке.
    expect(h.replies()).toEqual([bt("ru", "confirmLink", { phone: maskPhone("998935551201"), device: "браузер" })]);
    await h.press(93_201, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(TELEGRAM_TAKEN);
    // Повторное нажатие после отказа ничего не делает.
    await h.press(93_201, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginExpired"));

    const res = await poll(browser, nonce, { bearer: true }, { "x-lang": "en" });
    expect(res.json()).toEqual({ status: "conflict", error: "This Telegram account is linked to another account" });
    // Ни cookie, ни токена другого аккаунта.
    expect(cookieOf(res, "session")).toBeUndefined();
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null, phone: "998935551201" });
    expect(await userOf(other.id)).toMatchObject({ telegramId: 93_201, phone: other.phone });
    expect((await req(cookie, "GET", "/api/auth/me")).json().user.id).toBe(owner!.id);
    // Отказ забирается один раз.
    expect((await poll(browser, nonce)).json()).toEqual({ status: "expired" });

    // Перевод отказа на языках бота и сайта.
    for (const l of ["uz", "uzc", "en"] as const) expect(translateError(TELEGRAM_TAKEN, l)).not.toBe(TELEGRAM_TAKEN);
  });

  it("без сессии /telegram/start — обычный вход, Telegram без номера спрашивают номер", async () => {
    const h = botHarness();
    const { nonce } = await tgStart(null);
    await h.message(93_301, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhone")]);
    // Недействительная cookie сессии — тоже обычный вход.
    const stale = await tgStart("session=broken");
    await login(93_302);
    await h.message(93_302, `/start auth_${stale.nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLogin", { device: "браузер" }));
  });

  it("аккаунт заблокировали после начала подключения: запрос не действует", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935551401" }).returning();
    const { nonce, browser } = await tgStart(`session=${t.app.jwt.sign({ sub: owner!.id })}`);
    // Нажатие после блокировки аккаунта сбрасывает запрос (раньше любой проверки Telegram).
    await login(93_401);
    await h.message(93_401, `/start auth_${nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "confirmLink", { phone: maskPhone("998935551401"), device: "браузер" }));
    await db.update(users).set({ blocked: true }).where(eq(users.id, owner!.id));
    await redis.del(`inv:user:${owner!.id}`);
    await h.press(93_401, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginExpired"));
    expect((await userOf(owner!.id))!.telegramId).toBeNull();
    expect((await poll(browser, nonce)).json()).toEqual({ status: "expired" });

    // Telegram без номера подтверждает номер аккаунта, который заблокировали, пока бот ждал контакт:
    // подтверждения нет, бот отвечает, что запрос устарел, браузер вход не получает.
    await db.update(users).set({ blocked: false }).where(eq(users.id, owner!.id));
    await redis.del(`inv:user:${owner!.id}`);
    const again = await tgStart(`session=${t.app.jwt.sign({ sub: owner!.id })}`);
    h.calls.length = 0;
    await h.message(93_402, `/start auth_${again.nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    await db.update(users).set({ blocked: true }).where(eq(users.id, owner!.id));
    await redis.del(`inv:user:${owner!.id}`);
    await h.contact(93_402, "+998935551401");
    expect(h.replies().slice(1)).toEqual([bt("ru", "phoneLinked", { phone: "+998 93 555-14-01" }), bt("ru", "loginExpired")]);
    expect((await poll(again.browser, again.nonce)).json()).toEqual({ status: "pending" });
  });
});

describe("«Подключить Telegram»: только Telegram с номером аккаунта", () => {
  const cookieOfUser = (id: string) => `session=${t.app.jwt.sign({ sub: id })}`;
  const inlineButtons = (h: ReturnType<typeof botHarness>) => h.of("sendMessage").flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []);
  const linkedEvents = async (userId: string) =>
    db.select().from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.type, "telegram_linked")));

  it("чужой Telegram по ссылке подключения: бот просит номер, другой номер — отказ, аккаунт и вход не меняются", async () => {
    const h = botHarness();
    const [victim] = await db.insert(users).values({ phone: "998935556001", firstName: "Лола" }).returning();
    const cookie = cookieOfUser(victim!.id);
    const { nonce, browser } = await tgStart(cookie);

    // Ссылка t.me/<бот>?start=auth_<nonce> попала к другому человеку (переслали, увидел на экране),
    // и он открыл её в своём новом Telegram без номера.
    const attacker = 93_601;
    await h.message(attacker, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    expect(inlineButtons(h)).toEqual([]);
    // «Подключить» без номера (кнопка из старого сообщения или подделанное нажатие) тоже ведёт к контакту.
    await h.press(attacker, `auth:${nonce}`);
    expect(h.edits()).toEqual([]);
    expect(h.replies().at(-1)).toBe(bt("ru", "askPhoneLink"));
    expect((await poll(browser, nonce)).json()).toEqual({ status: "pending" });

    // Свой контакт с другим номером: номер привязывается к его собственному Telegram, подключение отклоняется.
    await h.contact(attacker, "+998935556099");
    expect(h.replies().slice(-2)).toEqual([bt("ru", "phoneLinked", { phone: "+998 93 555-60-99" }), TELEGRAM_PHONE_MISMATCH]);
    // Ни кнопки «Подключить», ни номера аккаунта (даже со скрытой серединой) он не увидел.
    expect(inlineButtons(h)).toEqual([]);
    expect(h.replies().join("\n")).not.toContain(maskPhone("998935556001"));

    // Повтор нажатия после отказа ничего не делает.
    await h.press(attacker, `auth:${nonce}`);
    expect(h.edits()).toEqual([bt("ru", "loginExpired")]);

    // Браузер получает отказ на языке сайта и остаётся в своём аккаунте.
    const res = await poll(browser, nonce, { bearer: true }, { "x-lang": "en" });
    expect(res.json()).toEqual({ status: "conflict", error: "This Telegram has a different phone number than the account: connect a Telegram with the same number" });
    expect(cookieOf(res, "session")).toBeUndefined();
    expect((await req(cookie, "GET", "/api/auth/me")).json().user).toMatchObject({ id: victim!.id, telegramId: null });
    expect((await poll(browser, nonce)).json()).toEqual({ status: "expired" });

    // Аккаунт не изменился; Telegram нападающего — отдельный аккаунт с его номером.
    expect(await userOf(victim!.id)).toMatchObject({ telegramId: null, phone: "998935556001", firstName: "Лола", freeAccess: false });
    const own = await byTelegram(attacker);
    expect(own).toMatchObject({ phone: "998935556099" });
    expect(own!.id).not.toBe(victim!.id);
    expect(await linkedEvents(victim!.id)).toHaveLength(0);

    // Повтор ссылки и кнопки после того, как отказ забран, тоже ничего не делает.
    await h.message(attacker, `/start auth_${nonce}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "loginExpired"));
    await h.press(attacker, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "loginExpired"));
    expect(await userOf(victim!.id)).toMatchObject({ telegramId: null });

    // Этим Telegram входят в его собственный аккаунт, а не в аккаунт по ссылке.
    const webapp = (await req(null, "POST", "/api/auth/webapp", { initData: initDataOf(attacker) })).json();
    expect(webapp.status).toBe("ok");
    expect((await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${webapp.token}` })).json().user.id).toBe(own!.id);
  });

  it("тот же человек: новый Telegram подтверждает номер аккаунта и подключается", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935556101" }).returning();
    const { nonce, browser } = await tgStart(cookieOfUser(owner!.id), { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36" });
    const tg = 93_611;
    await h.message(tg, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);

    await h.contact(tg, "+998935556101");
    // Подтверждение по-прежнему с номером аккаунта (скрытая середина) и устройством запроса.
    expect(h.replies().slice(1)).toEqual([
      bt("ru", "phoneLinked", { phone: "+998 93 555-61-01" }),
      bt("ru", "confirmLink", { phone: "+998 93 ***-**-01", device: "Chrome, Windows" }),
    ]);
    expect(inlineButtons(h)).toEqual([{ text: bt("ru", "confirmLinkButton"), callback_data: `auth:${nonce}` }]);
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits()).toEqual([bt("ru", "linkConfirmed", { phone: "+998 93 ***-**-01" })]);

    expect(await userOf(owner!.id)).toMatchObject({ telegramId: tg, phone: "998935556101" });
    expect(await db.select().from(users).where(eq(users.telegramId, tg))).toHaveLength(1);
    expect(await linkedEvents(owner!.id)).toHaveLength(1);
    const ok = await poll(browser, nonce, { bearer: true });
    expect(ok.json()).toMatchObject({ status: "ok", redirect: "/app/" });
    expect((await req(null, "GET", "/api/auth/me", undefined, { authorization: `Bearer ${ok.json().token}` })).json().user).toMatchObject({
      id: owner!.id,
      telegramId: String(tg),
    });
  });

  it("запись выдачи доступа с другим номером: отказ, бесплатный доступ к аккаунту не переходит", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935556201" }).returning();
    const tg = 93_621;
    const [grant] = await db.insert(users).values({ telegramId: tg, freeAccess: true, freeAccessNote: "друг" }).returning();
    const { nonce, browser } = await tgStart(cookieOfUser(owner!.id));
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, "+998935556299");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null, freeAccess: false, freeAccessNote: null });
    // Запись осталась отдельным аккаунтом со своим номером и своим доступом.
    expect(await userOf(grant!.id)).toMatchObject({ telegramId: tg, phone: "998935556299", freeAccess: true, freeAccessNote: "друг" });
  });

  it("номер Telegram — номер другого аккаунта (вход по SMS): Telegram объединяется с ним, а не с аккаунтом по ссылке", async () => {
    const h = botHarness();
    const [owner] = await db.insert(users).values({ phone: "998935556301" }).returning();
    const [smsAccount] = await db.insert(users).values({ phone: "998935556399", firstName: "Свой" }).returning();
    const { nonce, browser } = await tgStart(cookieOfUser(owner!.id));
    const tg = 93_631;
    await h.message(tg, `/start auth_${nonce}`);
    await h.contact(tg, "+998935556399");
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null });
    expect(await userOf(smsAccount!.id)).toMatchObject({ telegramId: tg, phone: "998935556399" });
  });

  it("номер уже у аккаунта с другим Telegram: бот отклоняет контакт, подключение сразу завершается отказом", async () => {
    const h = botHarness();
    const taken = "Этот номер уже привязан к другому Telegram-аккаунту";
    const [owner] = await db.insert(users).values({ phone: "998935556501" }).returning();
    await login(93_651);
    const { nonce, browser } = await tgStart(cookieOfUser(owner!.id));
    await h.message(93_652, `/start auth_${nonce}`);
    await h.contact(93_652, `+${phoneOf(93_651)}`);
    expect(h.replies().at(-1)).toBe(taken);
    expect(await redis.exists(`inv:bot:pending-start:93652`)).toBe(0);
    expect((await poll(browser, nonce)).json()).toEqual({ status: "conflict", error: taken });
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null });
    expect(await byTelegram(93_652)).toMatchObject({ phone: null });

    // Номер самого аккаунта, у которого Telegram уже есть: второй Telegram не подключается, прежний остаётся.
    const { user: withTg, cookie } = await login(93_661);
    const again = await tgStart(cookie);
    await h.message(93_662, `/start auth_${again.nonce}`);
    await h.contact(93_662, `+${withTg.phone}`);
    expect(h.replies().at(-1)).toBe(taken);
    expect((await poll(again.browser, again.nonce)).json()).toEqual({ status: "conflict", error: taken });
    expect(await userOf(withTg.id)).toMatchObject({ telegramId: 93_661 });
  });

  it("сервис: linkTelegramToUser сам ничего не привязывает и не объединяет", async () => {
    const ctx = t.app.ctx;
    const [owner] = await db.insert(users).values({ phone: "998935556401" }).returning();
    // Telegram без номера (запись бота или выдачи доступа) и Telegram, которого нет в базе, — номер не подтверждён.
    const [loose] = await db.insert(users).values({ telegramId: 93_641, freeAccess: true }).returning();
    await expect(linkTelegramToUser(ctx, owner!.id, loose!)).rejects.toMatchObject({ statusCode: 409, message: TELEGRAM_PHONE_MISMATCH });
    await expect(linkTelegramToUser(ctx, owner!.id, { telegramId: 93_642 })).rejects.toMatchObject({ statusCode: 409, message: TELEGRAM_PHONE_MISMATCH });
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null, freeAccess: false });
    expect(await userOf(loose!.id)).toMatchObject({ telegramId: 93_641, phone: null, freeAccess: true });
    // Telegram с номером — другой аккаунт.
    const { user: other } = await login(93_643);
    await expect(linkTelegramToUser(ctx, owner!.id, other)).rejects.toMatchObject({ statusCode: 409, message: TELEGRAM_TAKEN });
    expect(await userOf(owner!.id)).toMatchObject({ telegramId: null });
    // Telegram этого аккаунта — сам аккаунт; заблокированный аккаунт — null.
    const { user: self } = await login(93_644);
    expect(await linkTelegramToUser(ctx, self.id, self)).toMatchObject({ id: self.id, telegramId: 93_644 });
    await db.update(users).set({ blocked: true }).where(eq(users.id, self.id));
    expect(await linkTelegramToUser(ctx, self.id, self)).toBeNull();
  });

  it("отказ из-за другого номера переведён на языки бота и сайта", () => {
    for (const l of ["uz", "uzc", "en"] as const) expect(translateError(TELEGRAM_PHONE_MISMATCH, l)).not.toBe(TELEGRAM_PHONE_MISMATCH);
    expect(translateError(TELEGRAM_PHONE_MISMATCH, "uzc")).toMatch(/[а-яўқғҳ]/i);
    expect(new Set((["ru", "uz", "uzc", "en"] as const).map((l) => bt(l, "askPhoneLink"))).size).toBe(4);
  });
});

describe("стёртые дата и время", () => {
  it("сохраняются пустыми строками, null удаляет ключ, неверная дата — понятная ошибка", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template, data: { names: "Аня и Боря", date: "2031-06-01", time: "18:00" } });
    const patched = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { date: "", time: "" } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data).toMatchObject({ date: "", time: "" });
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().data).toMatchObject({ date: "", time: "" });

    const removed = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { date: null, time: null } })).json();
    expect(removed.data).not.toHaveProperty("date");
    expect(removed.data).not.toHaveProperty("time");
    expect(await create(cookie, { template, data: { date: "", time: "" } })).toMatchObject({ data: { date: "", time: "" } });

    const bad = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { date: "2031-02-30" } }, { "x-lang": "en" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("There is no such date");
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { time: "25:00" } })).json().error).toBe("Время в формате ЧЧ:ММ");
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { program: [{ time: "9:5", title: "x" }] } })).json().error).toBe("Время в формате ЧЧ:ММ");
  });

  it("без даты: страница гостя, og:title, бот, SMS, напоминания", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template, mode: "personal", data: { names: "Аня и Боря", date: "", time: "18:00", venue: "Навруз" } });
    const [guest] = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Вера", phone: "+998935552001" }] })).json();
    await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 1 });
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);

    // Страница гостя и мета-теги.
    expect((await t.app.inject({ url: `/api/public/g/${guest.token}` })).json().data).toMatchObject({ date: "", time: "18:00" });
    const page = await t.app.inject({ url: `/g/${guest.token}` });
    expect(page.statusCode).toBe(200);
    expect(metaOf(page.body, "og:title")).toBe("Аня и Боря");

    // Карточка в боте: без строки даты (только время), место на месте.
    const h = botHarness();
    await login(94_001);
    await h.message(94_001, `/start g_${guest.token}`);
    const card = h.replies().at(-1)!;
    expect(card).toContain("📅 18:00\n");
    expect(card).toContain("📍 Навруз");

    // SMS-приглашение без даты.
    await db.update(templates).set({ smsEnabled: true }).where(eq(templates.slug, template));
    smsSent.length = 0;
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json().sent).toBe(1);
    expect(smsSent[0]!.text).toBe(`Вера, приглашаем вас: Аня и Боря. Ваше приглашение: ${APP_URL}/g/${guest.token}`);

    // Напоминание владельца в Telegram без даты; по расписанию без даты не напоминаем.
    telegram.sent.length = 0;
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, { guestIds: [guest.id] })).json()).toMatchObject({ telegram: 1 });
    expect(telegram.sent[0]!.text.split("\n")[0]).toBe("Вера, напоминаем о приглашении: Аня и Боря.");
    expect(dueReminders({ date: "", time: "18:00" }, defaultInvitationSettings, new Date())).toEqual([]);
    await db.update(guests).set({ rsvp: "yes" }).where(eq(guests.id, guest.id));
    expect(await sendDueReminders(t.app.ctx)).toBe(0);

    // Дата без времени.
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { date: "2031-06-01", time: "" } });
    const titled = await t.app.inject({ url: `/g/${guest.token}` });
    expect(metaOf(titled.body, "og:title")).toBe("Аня и Боря — 1 июня 2031 г.");
    const [row] = await db.select({ data: invitations.data }).from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.data).toMatchObject({ date: "2031-06-01", time: "" });
    // Русская дата кончается точкой («г.»): в тексте после неё вторая точка не ставится.
    await redis.del(`inv:remind:${guest.id}`);
    telegram.sent.length = 0;
    await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, { guestIds: [guest.id] });
    expect(telegram.sent[0]!.text.split("\n")[0]).toBe("Вера, напоминаем о приглашении: Аня и Боря, 1 июня 2031 г.");
  });
});

describe("гости одним запросом", () => {
  it("больше 500 строк — понятная ошибка с лимитом на языке запроса", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template, mode: "personal" });
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Гость ${i + 1}` }));
    const ru = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: list(501) });
    expect(ru.statusCode).toBe(400);
    expect(ru.json().error).toBe("За один раз можно добавить не больше 500 гостей");
    const en = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: list(501) }, { "x-lang": "en" });
    expect(en.json().error).toBe("You can add at most 500 guests at a time");
    for (const l of ["uz", "uzc"]) {
      const r = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: list(501) }, { "x-lang": l });
      expect(r.json().error).toContain("500");
      expect(r.json().error).not.toBe("За один раз можно добавить не больше 500 гостей");
    }
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: list(500) })).statusCode).toBe(201);
  });
});

describe("бот: дата окончания подписки", () => {
  it("по календарю Ташкента, как в приложении", async () => {
    const { user: u } = await login(95_001);
    // 19 мая 2031, 20:30 UTC — в Ташкенте уже 20 мая, 01:30.
    await db.insert(subscriptions).values({ userId: u.id, startsAt: new Date("2031-04-19T20:30:00Z"), endsAt: new Date("2031-05-19T20:30:00Z") });
    const h = botHarness();
    await h.message(95_001, "/prices");
    expect(h.replies().at(-1)).toContain("Ваша подписка активна до 20 мая 2031 г.");
    expect(h.replies().at(-1)).not.toContain("г..");
    await db.update(users).set({ locale: "uz" }).where(eq(users.id, u.id));
    await redis.del(`inv:user:${u.id}`);
    await h.message(95_001, "/prices");
    expect(h.replies().at(-1)).toContain(bt("uz", "accessSub", { date: "20-may, 2031" }));
  });
});

describe("страница «не найдено»", () => {
  it("открывается во фрейме Telegram Web: заголовки как у страниц приложения", async () => {
    const res = await t.app.inject({ url: "/no/such/page", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('"mode":"notfound"');
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
    const app = await t.app.inject({ url: "/app/" });
    expect(res.headers["content-security-policy"]).toBe(app.headers["content-security-policy"]);

    // JSON-ответ 404 (API) по-прежнему с запретом фреймов, как весь сайт.
    const api = await t.app.inject({ url: "/api/no-such", headers: { accept: "text/html" } });
    expect(api.statusCode).toBe(404);
    expect(api.headers["x-frame-options"]).toBe("DENY");
    expect(api.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
