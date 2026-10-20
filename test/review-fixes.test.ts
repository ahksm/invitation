import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot, setBotCommands } from "../src/bot/index.js";
import { cacheKeys, createCache } from "../src/cache.js";
import { botUsername, type Config } from "../src/config.js";
import {
  defaultInvitationSettings,
  guestReminders,
  guests,
  invitations,
  orders,
  smsMessages,
  templates,
  users,
} from "../src/db/schema.js";
import { bt } from "../src/i18n.js";
import { dueReminders, sendDueReminders } from "../src/services/reminders.js";
import { APP_URL, multipart, samples, testContext } from "./helpers.js";

/** Регрессионные тесты к замечаниям ревью: оплаты при смене режима и шаблона, бот, напоминания, кэш и мелочи. */
const t = testContext();
const { db, redis, cache, config, login, req, callback, pay, telegram } = t;

let nextUser = 60_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);

const get = (url: string) => t.app.inject({ url });
const post = (url: string, payload: unknown) => req(null, "POST", url, payload);

async function create(cookie: string, body: Record<string, unknown>) {
  const res = await req(cookie, "POST", "/api/invitations", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; slug: string; [k: string]: any };
}
const invOf = async (id: string) => (await db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const orderOf = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const guestOf = async (id: string) => (await db.select().from(guests).where(eq(guests.id, id)))[0]!;
const ownerGuests = async (cookie: string, id: string) => (await req(cookie, "GET", `/api/invitations/${id}`)).json().guests as any[];
const activity = async (cookie: string, id: string) => (await req(cookie, "GET", `/api/invitations/${id}/activity`)).json() as any[];
const order = async (cookie: string, body: Record<string, unknown>) => {
  const res = await req(cookie, "POST", "/api/orders", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().order as { id: string; number: number; amount: number };
};

/** Общее приглашение: шаблон оплачен, опубликовано. */
async function sharedPublished(data: Record<string, unknown> = {}) {
  const { cookie } = await user();
  const inv = await create(cookie, { template: "wedding-classic", mode: "shared", data: { names: "Азиз & Мадина", ...data } });
  await pay(cookie, { kind: "template", invitationId: inv.id });
  expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
  return { cookie, inv };
}

/** Персональное приглашение с гостями и оплаченными местами, опубликованное. */
async function personalPublished(names: string[], seats: number, data: Record<string, unknown> = {}) {
  const { cookie } = await user();
  const inv = await create(cookie, { template: "wedding-classic", mode: "personal", data: { names: "Той", ...data } });
  const added = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: names.map((name) => ({ name })) });
  expect(added.statusCode, added.body).toBe(201);
  await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: seats });
  expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
  return { cookie, inv, added: added.json() as { id: string; token: string; name: string }[] };
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

describe("смена режима", () => {
  it("режим не меняется, пока в приглашении есть гости", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "personal" });
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Аня" }, { name: "Боря" }] })).statusCode).toBe(201);
    const r = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "shared" }, { "x-lang": "en" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("The mode can be changed only while the invitation has no guests");
    expect((await invOf(inv.id)).mode).toBe("personal");
  });

  it("в общем режиме оплата шаблона не открывает личные ссылки гостей владельца", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "personal", data: { names: "Той" } });
    const [owner] = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Аня" }] })).json();
    // Режим сменили в обход проверки (так было до исправления): гости владельца остаются в общем приглашении.
    await db.update(invitations).set({ mode: "shared" }).where(eq(invitations.id, inv.id));
    await pay(cookie, { kind: "template", invitationId: inv.id });
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);

    expect((await ownerGuests(cookie, inv.id))[0]).toMatchObject({ id: owner.id, paid: false });
    expect((await get(`/api/public/g/${owner.token}`)).statusCode).toBe(404);

    // Гость, ответивший сам по общей ссылке, оплачен шаблоном.
    const rsvp = await post(`/api/public/i/${inv.slug}/rsvp`, { name: "Вера", status: "yes" });
    expect(rsvp.statusCode, rsvp.body).toBe(200);
    expect((await get(`/api/public/g/${rsvp.json().guestToken}`)).statusCode).toBe(200);
    const list = await ownerGuests(cookie, inv.id);
    expect(list.map((g) => [g.name, g.paid])).toEqual([
      ["Аня", false],
      ["Вера", true],
    ]);
  });

  it("смена режима отменяет начатые оплаты прежнего режима", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "personal" });
    const seats = await order(cookie, { kind: "seats", invitationId: inv.id, quantity: 5 });
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "shared" })).statusCode).toBe(200);
    expect(await orderOf(seats.id)).toMatchObject({ status: "cancelled", meta: { cancelled: "mode_changed" } });

    // По отменённому счёту всё же заплатили: оплата отклоняется, Multicard её вернёт.
    const late = await callback(seats.number, seats.amount);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual({ success: false, message: "Заказ отменён, оформите оплату заново" });
    expect(await orderOf(seats.id)).toMatchObject({ status: "cancelled", paidAt: null, meta: { stale: true } });
    expect(await invOf(inv.id)).toMatchObject({ mode: "shared", paidSeats: 0 });

    // Обратно в персональный: отменяется счёт за шаблон.
    const tpl = await order(cookie, { kind: "template", invitationId: inv.id });
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "personal" })).statusCode).toBe(200);
    expect((await orderOf(tpl.id)).status).toBe("cancelled");
    expect((await callback(tpl.number, tpl.amount)).statusCode).toBe(400);
    expect(await invOf(inv.id)).toMatchObject({ mode: "personal", unlocked: false });
  });

  it("счёт другого режима не применяется, даже если его не отменили", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "personal" });
    const seats = await order(cookie, { kind: "seats", invitationId: inv.id, quantity: 2 });
    await db.update(invitations).set({ mode: "shared" }).where(eq(invitations.id, inv.id));
    expect((await callback(seats.number, seats.amount)).statusCode).toBe(400);
    expect(await orderOf(seats.id)).toMatchObject({ status: "cancelled", paidAt: null, meta: { stale: true } });
    expect((await invOf(inv.id)).paidSeats).toBe(0);
  });
});

describe("смена шаблона до оплаты", () => {
  const PRICEY = 90_000_00;
  beforeAll(async () => {
    await db.update(templates).set({ price: PRICEY }).where(eq(templates.slug, "wedding-botanical"));
  });
  afterAll(async () => {
    await db.update(templates).set({ price: null }).where(eq(templates.slug, "wedding-botanical"));
  });

  it("счёт за дешёвый шаблон отменяется и не открывает дорогой", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "shared" });
    const cheap = await order(cookie, { kind: "template", invitationId: inv.id });
    expect(cheap.amount).toBe(50_000_00);
    expect((await orderOf(cheap.id)).meta).toEqual({ templateId: (await invOf(inv.id)).templateId });

    const r = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-botanical" });
    expect(r.statusCode, r.body).toBe(200);
    expect(await orderOf(cheap.id)).toMatchObject({ status: "cancelled", meta: { cancelled: "template_changed" } });
    expect((await callback(cheap.number, cheap.amount)).statusCode).toBe(400);
    expect((await invOf(inv.id)).unlocked).toBe(false);
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(402);

    // Новый счёт выставляется по цене нового шаблона и открывает его.
    const full = await pay(cookie, { kind: "template", invitationId: inv.id });
    expect(full.order.amount).toBe(PRICEY);
    expect((await invOf(inv.id)).unlocked).toBe(true);
  });

  it("счёт остаётся в силе при смене на шаблон не дороже", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-botanical", mode: "shared" });
    const o = await order(cookie, { kind: "template", invitationId: inv.id });
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-classic" })).statusCode).toBe(200);
    expect((await orderOf(o.id)).status).toBe("pending");
    expect((await callback(o.number, o.amount)).statusCode).toBe(200);
    expect((await invOf(inv.id)).unlocked).toBe(true);
  });

  it("applyPayment сверяет шаблон счёта с текущим, а не только цену", async () => {
    const { cookie } = await user();
    // Шаблон сменили, а счёт не отменили (гонка до исправления): оплата отклоняется.
    const inv = await create(cookie, { template: "wedding-classic", mode: "shared" });
    const o = await order(cookie, { kind: "template", invitationId: inv.id });
    const [botanical] = await db.select().from(templates).where(eq(templates.slug, "wedding-botanical"));
    await db.update(invitations).set({ templateId: botanical!.id }).where(eq(invitations.id, inv.id));
    expect((await callback(o.number, o.amount)).statusCode).toBe(400);
    expect(await orderOf(o.id)).toMatchObject({ status: "cancelled", meta: { stale: true } });
    expect((await invOf(inv.id)).unlocked).toBe(false);

    // Админ поднял цену того же шаблона после выставления счёта: счёт всё равно действует.
    const inv2 = await create(cookie, { template: "wedding-classic", mode: "shared" });
    const o2 = await order(cookie, { kind: "template", invitationId: inv2.id });
    await db.update(templates).set({ price: 70_000_00 }).where(eq(templates.slug, "wedding-classic"));
    try {
      expect((await callback(o2.number, o2.amount)).statusCode).toBe(200);
      expect((await invOf(inv2.id)).unlocked).toBe(true);
    } finally {
      await db.update(templates).set({ price: null }).where(eq(templates.slug, "wedding-classic"));
    }
  });
});

describe("бесплатные оплаты", () => {
  it("открытие шаблона и места без оплаты пишут событие paid", async () => {
    const { cookie } = await user({ freeAccess: true });
    const shared = await create(cookie, { template: "wedding-classic", mode: "shared" });
    expect((await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: shared.id })).json().status).toBe("fulfilled");
    expect((await activity(cookie, shared.id))[0]).toMatchObject({ kind: "paid", meta: { orderId: null, kind: "template", quantity: 1, amount: 0 } });

    const personal = await create(cookie, { template: "wedding-classic", mode: "personal" });
    expect((await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: personal.id, quantity: 4 })).json().status).toBe("fulfilled");
    expect((await activity(cookie, personal.id))[0]).toMatchObject({ kind: "paid", meta: { orderId: null, kind: "seats", quantity: 4, amount: 0 } });
  });
});

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
  const contact = (tg: number, phone: string) =>
    bot.handleUpdate({
      update_id: id++,
      message: { message_id: id, date, chat: chat(tg), from: from(tg), contact: { phone_number: phone, first_name: "Гость", user_id: tg } },
    } as never);
  const press = (tg: number, data: string) =>
    bot.handleUpdate({
      update_id: id++,
      callback_query: { id: String(id), from: from(tg), chat_instance: "ci", data, message: { message_id: 1, date, chat: chat(tg), text: "…" } },
    } as never);
  const of = (method: string) => calls.filter((c) => c.method === method);
  const replies = () => of("sendMessage").map((c) => c.payload.text as string);
  return { bot, calls, message, contact, press, of, replies };
}

describe("бот", () => {
  it("/grant и /revoke: девять цифр — Telegram ID, а не телефон", async () => {
    await login(1);
    const h = botHarness();
    await h.message(1, "/grant 901234567 друг семьи");
    expect(await db.select().from(users).where(eq(users.telegramId, 901234567))).toMatchObject([{ freeAccess: true, freeAccessNote: "друг семьи", phone: null }]);
    expect(await db.select().from(users).where(eq(users.phone, "998901234567"))).toHaveLength(0);
    expect(h.replies().at(-1)).toBe("Бесплатный доступ выдан: Telegram ID 901234567");

    await h.message(1, "/grant +998907654321");
    expect(await db.select().from(users).where(eq(users.phone, "998907654321"))).toMatchObject([{ freeAccess: true, telegramId: null }]);

    await h.message(1, "/revoke tg:901234567");
    expect((await db.select().from(users).where(eq(users.telegramId, 901234567)))[0]!.freeAccess).toBe(false);
    expect(h.replies().at(-1)).toBe("Бесплатный доступ снят: Telegram ID 901234567");

    // Снять доступ у неизвестного: пользователь не создаётся.
    await h.message(1, "/revoke 777000777");
    expect(await db.select().from(users).where(eq(users.telegramId, 777000777))).toHaveLength(0);
    expect(h.replies().at(-1)).toBe("Пользователь не найден: Telegram ID 777000777");

    await h.message(1, "/grant @username");
    expect(h.replies().at(-1)).toMatch(/^Использование: \/grant/);

    // Не админ: команда не выполняется.
    const { user: plain } = await user();
    await h.message(Number(plain.telegramId), "/grant 555555555");
    expect(await db.select().from(users).where(eq(users.telegramId, 555555555))).toHaveLength(0);
  });

  it("/start g_<token>: телефон, привязка чата, карточка и ответ кнопками", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня", "Боря"], 1, { date: "2031-03-14", time: "18:00", venue: "Навруз" });
    const [anya, borya] = added as [(typeof added)[0], (typeof added)[0]];
    const h = botHarness();
    const tg = 61_001;

    // Номера ещё нет: бот просит контакт и помнит параметр.
    await h.message(tg, `/start g_${anya.token}`);
    expect(h.replies()).toEqual([bt("ru", "askPhone")]);
    await h.contact(tg, "+998931110001");
    expect(await redis.exists(`inv:bot:pending-start:${tg}`)).toBe(0);
    const card = h.of("sendMessage").at(-1)!.payload;
    expect(card.text).toContain(bt("ru", "guestInvited", { name: "Аня" }));
    expect(card.text).toContain("📅 ");
    expect(card.text).toContain("📍 Навруз");
    // Сайт по http: ссылка текстом, а не кнопкой.
    expect(card.text).toContain(`${APP_URL}/g/${anya.token}`);
    expect(card.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toEqual([
      `rsvp:${anya.id}:yes`,
      `rsvp:${anya.id}:maybe`,
      `rsvp:${anya.id}:no`,
    ]);
    expect((await guestOf(anya.id)).telegramChatId).toBe(tg);
    expect((await ownerGuests(cookie, inv.id))[0]).toMatchObject({ id: anya.id, telegramLinked: true });

    // Ответ кнопкой идёт тем же путём, что POST /api/public/g/:token/rsvp.
    await h.press(tg, `rsvp:${anya.id}:yes`);
    expect(h.of("answerCallbackQuery").at(-1)!.payload).toMatchObject({ text: bt("ru", "rsvpSaved") });
    expect(h.of("editMessageText").at(-1)!.payload.text).toContain(bt("ru", "guestAnswer", { answer: bt("ru", "rsvpYes") }));
    expect(await guestOf(anya.id)).toMatchObject({ rsvp: "yes", plus: 0 });
    expect((await activity(cookie, inv.id))[0]).toMatchObject({ kind: "yes" });

    // Кнопка из чужого чата не меняет ответ.
    const stranger = 61_002;
    await login(stranger);
    await h.press(stranger, `rsvp:${anya.id}:no`);
    expect(h.of("answerCallbackQuery").at(-1)!.payload).toMatchObject({ text: bt("ru", "guestNotFound"), show_alert: true });
    expect((await guestOf(anya.id)).rsvp).toBe("yes");

    // Кнопка не трогает пожелание и его видимость в гостевой книге.
    await db.update(guests).set({ message: "Поздравляем!", messagePublic: true }).where(eq(guests.id, anya.id));
    await h.press(tg, `rsvp:${anya.id}:maybe`);
    expect(await guestOf(anya.id)).toMatchObject({ rsvp: "maybe", message: "Поздравляем!", messagePublic: true });

    // После срока ответа кнопка отвечает предупреждением, ответ не меняется.
    const [row] = await db.select({ data: invitations.data }).from(invitations).where(eq(invitations.id, inv.id));
    await db.update(invitations).set({ data: { ...(row!.data as object), rsvpBy: "2020-01-01" } }).where(eq(invitations.id, inv.id));
    await h.press(tg, `rsvp:${anya.id}:no`);
    expect(h.of("answerCallbackQuery").at(-1)!.payload).toMatchObject({ text: bt("ru", "rsvpClosed"), show_alert: true });
    expect((await guestOf(anya.id)).rsvp).toBe("maybe");
    await db.update(invitations).set({ data: row!.data }).where(eq(invitations.id, inv.id));

    // Место Бори не оплачено: ссылка не открывается, чат не привязывается.
    await h.message(tg, `/start g_${borya.token}`);
    expect(h.replies().at(-1)).toBe(bt("ru", "guestNotFound"));
    expect((await guestOf(borya.id)).telegramChatId).toBeNull();

    // Напоминание владельца теперь уходит в Telegram.
    telegram.sent.length = 0;
    const remind = await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, { guestIds: [anya.id] });
    expect(remind.json()).toMatchObject({ telegram: 1, sms: 0 });
    expect(telegram.sent.map((m) => m.chatId)).toEqual([tg]);
  });

  it("меню команд для русского, узбекского и английского клиента", async () => {
    const h = botHarness();
    await setBotCommands(h.bot);
    const calls = h.of("setMyCommands");
    expect(calls.map((c) => c.payload.language_code)).toEqual([undefined, "uz", "en"]);
    expect(calls.map((c) => c.payload.commands[0].description)).toEqual(["Главное меню", "Asosiy menyu", "Main menu"]);
    for (const c of calls) expect(c.payload.commands.map((x: { command: string }) => x.command)).toEqual(["start", "login", "my", "prices", "lang"]);
  });
});

describe("напоминания по расписанию", () => {
  const on = { ...defaultInvitationSettings };
  const at = (iso: string) => new Date(iso);
  // 20 мая 2031, 18:00 по Ташкенту = 13:00 UTC.
  const event = { date: "2031-05-20", time: "18:00" };

  it("окна r1d, morning и r3h", () => {
    expect(dueReminders(event, on, at("2031-05-19T12:59:00Z"))).toEqual([]);
    expect(dueReminders(event, on, at("2031-05-19T13:00:00Z"))).toEqual(["r1d"]);
    expect(dueReminders(event, on, at("2031-05-20T03:59:00Z"))).toEqual(["r1d"]);
    expect(dueReminders(event, on, at("2031-05-20T04:00:00Z"))).toEqual(["morning", "r1d"]);
    expect(dueReminders(event, on, at("2031-05-20T09:59:00Z"))).toEqual(["morning", "r1d"]);
    expect(dueReminders(event, on, at("2031-05-20T10:00:00Z"))).toEqual(["r3h", "morning"]);
    expect(dueReminders(event, on, at("2031-05-20T12:59:00Z"))).toEqual(["r3h", "morning"]);
    expect(dueReminders(event, on, at("2031-05-20T13:00:00Z"))).toEqual([]);
    // Выключенные в настройках не отправляются.
    expect(dueReminders(event, { ...on, r1d: false }, at("2031-05-20T04:00:00Z"))).toEqual(["morning"]);
    expect(dueReminders(event, { ...on, r3h: false, morning: false }, at("2031-05-20T10:30:00Z"))).toEqual([]);
    // Без времени: только утреннее, до полудня.
    const noTime = { date: "2031-05-20" };
    expect(dueReminders(noTime, on, at("2031-05-19T13:00:00Z"))).toEqual([]);
    expect(dueReminders(noTime, on, at("2031-05-20T04:00:00Z"))).toEqual(["morning"]);
    expect(dueReminders(noTime, on, at("2031-05-20T06:59:00Z"))).toEqual(["morning"]);
    expect(dueReminders(noTime, on, at("2031-05-20T07:00:00Z"))).toEqual([]);
    expect(dueReminders({}, on, at("2031-05-20T04:00:00Z"))).toEqual([]);
  });

  it("отправляет оплаченным гостям с ботом по одному разу", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня", "Боря", "Вера", "Гена", "Дина"], 4, {
      ...event,
      venue: "Навруз",
      address: "Ташкент",
    });
    const set = (i: number, v: Partial<typeof guests.$inferInsert>) => db.update(guests).set(v).where(eq(guests.id, added[i]!.id));
    await set(0, { telegramChatId: 62_001, rsvp: "yes" });
    await set(1, { telegramChatId: 62_002 });
    await set(2, { telegramChatId: 62_003, rsvp: "no" });
    await set(3, { rsvp: "yes" });
    // Пятое место не оплачено.
    await set(4, { telegramChatId: 62_005, rsvp: "yes" });

    telegram.sent.length = 0;
    expect(await sendDueReminders(t.app.ctx, at("2031-05-20T04:00:00Z"))).toBe(2);
    expect(telegram.sent.map((m) => m.chatId)).toEqual([62_001, 62_002]);
    const [anya, borya] = telegram.sent;
    expect(anya!.text).toMatch(/^☀️ Аня, сегодня: /);
    expect(anya!.text).toContain("18:00");
    expect(anya!.text).toContain("📍 Навруз, Ташкент");
    expect(anya!.text).toContain(`Открыть приглашение: ${APP_URL}/g/${added[0]!.token}`);
    expect(anya!.text).not.toContain("Ответьте");
    expect(anya!.other.reply_markup.inline_keyboard).toEqual([
      [{ text: "Маршрут", url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("Навруз, Ташкент")}` }],
    ]);
    // Гость без ответа получает просьбу ответить.
    expect(borya!.text).toContain("Ответьте, пожалуйста");
    // Утреннее закрыло и r1d (окно открыто одновременно): за сутки второе сообщение не придёт.
    const kinds = await db.select().from(guestReminders).where(eq(guestReminders.guestId, added[0]!.id));
    expect(kinds.map((k) => k.kind).sort()).toEqual(["morning", "r1d"]);

    // Повторный запуск ничего не дублирует.
    expect(await sendDueReminders(t.app.ctx, at("2031-05-20T04:01:00Z"))).toBe(0);
    // За 3 часа — следующее напоминание, без кнопки маршрута.
    telegram.sent.length = 0;
    expect(await sendDueReminders(t.app.ctx, at("2031-05-20T10:30:00Z"))).toBe(2);
    expect(telegram.sent[0]!.text).toMatch(/^⏰ Аня, скоро начало: /);
    expect(telegram.sent[0]!.other.reply_markup).toBeUndefined();
    expect(await sendDueReminders(t.app.ctx, at("2031-05-20T10:31:00Z"))).toBe(0);

    const events = (await activity(cookie, inv.id)).filter((a) => a.kind === "reminder");
    expect(events.map((e) => e.meta)).toEqual([
      { n: 2, scheduled: true },
      { n: 2, scheduled: true },
    ]);
  });

  it("общее приглашение: гости, ответившие сами; черновики не участвуют", async () => {
    // 10 июня 2031, 10:00 по Ташкенту = 05:00 UTC; за сутки — 9 июня 05:00 UTC.
    const data = { date: "2031-06-10", time: "10:00" };
    const { inv } = await sharedPublished(data);
    const rsvp = await post(`/api/public/i/${inv.slug}/rsvp`, { name: "Вера", status: "maybe" });
    expect(rsvp.statusCode, rsvp.body).toBe(200);
    await db.update(guests).set({ telegramChatId: 63_001 }).where(eq(guests.token, rsvp.json().guestToken));

    const { cookie } = await user();
    const draft = await create(cookie, { template: "wedding-classic", mode: "personal", data });
    const [g] = (await req(cookie, "POST", `/api/invitations/${draft.id}/guests`, { guests: [{ name: "Черновик" }] })).json();
    await db.update(guests).set({ telegramChatId: 63_002 }).where(eq(guests.id, g.id));
    await db.update(invitations).set({ paidSeats: 1 }).where(eq(invitations.id, draft.id));

    telegram.sent.length = 0;
    expect(await sendDueReminders(t.app.ctx, at("2031-06-09T05:00:00Z"))).toBe(1);
    expect(telegram.sent.map((m) => m.chatId)).toEqual([63_001]);
    expect(telegram.sent[0]!.text).toMatch(/^🔔 Вера, напоминаем о приглашении: /);
  });

  it("без бота напоминания не отправляются", async () => {
    const ctx = { ...t.app.ctx, notifier: { ...t.app.ctx.notifier, enabled: false } };
    expect(await sendDueReminders(ctx, at("2031-05-20T04:00:00Z"))).toBe(0);
  });
});

describe("кэш публичных страниц", () => {
  it("wrap не оставляет значение, загруженное до invalidate", async () => {
    const c = createCache(redis, "test-wrap:");
    expect(await c.wrap("k", 60, async () => (await c.invalidate("k"), "old"))).toBe("old");
    expect(await c.get("k")).toBeUndefined();
    expect(await c.wrap("k", 60, async () => "new")).toBe("new");
    expect(await c.get("k")).toBe("new");
    expect(await redis.ttl("test-wrap:ver:k")).toBeGreaterThan(0);
  });

  /** Во время загрузки страницы в кэш владелец меняет приглашение (как параллельный запрос). */
  async function racing(key: string, during: () => Promise<void>, load: () => Promise<unknown>) {
    const orig = cache.set;
    let fired = false;
    cache.set = async function (this: typeof cache, k: string, value: unknown, ttl: number) {
      if (!fired && k === key) {
        fired = true;
        await during();
      }
      return orig.call(this, k, value, ttl);
    };
    try {
      await load();
    } finally {
      cache.set = orig;
    }
    expect(fired).toBe(true);
  }

  it("пароль, заданный во время загрузки страницы, действует сразу", async () => {
    const { cookie, inv } = await sharedPublished();
    const url = `/api/public/i/${inv.slug}`;
    await racing(
      cacheKeys.publicShared(inv.slug),
      async () => void expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { accessCode: "4321" })).statusCode).toBe(200),
      () => get(url),
    );
    expect((await get(url)).statusCode).toBe(401);
    expect((await post(`${url}/rsvp`, { name: "Гость", status: "yes" })).statusCode).toBe(401);
    expect((await post(`${url}/rsvp`, { name: "Гость", status: "yes", code: "4321" })).statusCode).toBe(200);
  });

  it("архив во время загрузки страницы закрывает её сразу", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня"], 1);
    const url = `/api/public/g/${added[0]!.token}`;
    await racing(
      cacheKeys.publicGuest(added[0]!.token),
      async () => void expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204),
      () => get(url),
    );
    expect((await invOf(inv.id)).status).toBe("archived");
    expect((await get(url)).statusCode).toBe(404);
    expect((await post(`${url}/rsvp`, { status: "yes" })).statusCode).toBe(404);
  });

  it("ответ проверяет приглашение по базе, а не по записи в кэше", async () => {
    const { inv } = await sharedPublished();
    const url = `/api/public/i/${inv.slug}`;
    expect((await get(url)).statusCode).toBe(200);
    // Изменения в обход сброса кэша: запись в кэше устарела.
    await db.update(invitations).set({ accessCode: "777" }).where(eq(invitations.id, inv.id));
    expect((await post(`${url}/rsvp`, { name: "Гость", status: "yes" })).statusCode).toBe(401);
    expect((await post(`${url}/rsvp`, { name: "Гость", status: "yes", code: "1" })).statusCode).toBe(401);
    expect((await post(`${url}/rsvp`, { name: "Гость", status: "yes", code: "777" })).statusCode).toBe(200);
    await db.update(invitations).set({ status: "archived" }).where(eq(invitations.id, inv.id));
    expect((await post(`${url}/rsvp`, { name: "Гость 2", status: "yes", code: "777" })).statusCode).toBe(404);

    const p = await personalPublished(["Аня"], 1);
    const gurl = `/api/public/g/${p.added[0]!.token}`;
    expect((await get(gurl)).statusCode).toBe(200);
    await db.update(invitations).set({ status: "archived" }).where(eq(invitations.id, p.inv.id));
    expect((await post(`${gurl}/rsvp`, { status: "no" })).statusCode).toBe(404);
    expect((await guestOf(p.added[0]!.id)).rsvp).toBe("pending");
  });
});

describe("архив", () => {
  it("архивное приглашение не меняется, не публикуется, не оплачивается и не рассылается", async () => {
    const { cookie, inv } = await personalPublished(["Аня"], 1);
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    const conflict = async (method: "POST" | "PATCH", url: string, body?: unknown) => {
      const r = await req(cookie, method, url, body, { "x-lang": "en" });
      expect(r.statusCode, url).toBe(409);
      expect(r.json().error).toBe("The invitation is archived");
    };
    await conflict("POST", `/api/invitations/${inv.id}/publish`);
    await conflict("PATCH", `/api/invitations/${inv.id}`, { data: { names: "Новое" } });
    await conflict("POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Боря" }] });
    await conflict("POST", `/api/invitations/${inv.id}/sms`, {});
    await conflict("POST", `/api/invitations/${inv.id}/remind`, {});
    await conflict("POST", "/api/orders", { kind: "seats", invitationId: inv.id, quantity: 1 });
    const og = await t.app.inject({
      method: "PUT",
      url: `/api/invitations/${inv.id}/og`,
      payload: samples.png,
      headers: { cookie, origin: APP_URL, "content-type": "image/png" },
    });
    expect(og.statusCode).toBe(409);
    expect(await invOf(inv.id)).toMatchObject({ status: "archived", ogImageUrl: null });
    // Копия архивного — обычный новый черновик.
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/duplicate`)).statusCode).toBe(201);
  });

  it("начатая до архива оплата мест не теряется, новые счета не выставляются", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "personal" });
    const seats = await order(cookie, { kind: "seats", invitationId: inv.id, quantity: 3 });
    // Черновик с начатой оплатой уходит в архив, а не удаляется.
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    expect((await invOf(inv.id)).status).toBe("archived");
    expect((await callback(seats.number, seats.amount)).statusCode).toBe(200);
    expect((await invOf(inv.id)).paidSeats).toBe(3);
    expect((await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: inv.id, quantity: 1 })).statusCode).toBe(409);
  });

  it("копия на выключенном шаблоне не создаётся", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic", mode: "shared" });
    await db.update(templates).set({ isActive: false }).where(eq(templates.slug, "wedding-classic"));
    try {
      const r = await req(cookie, "POST", `/api/invitations/${inv.id}/duplicate`, undefined, { "x-lang": "en" });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("This template is no longer available, choose another one");
    } finally {
      await db.update(templates).set({ isActive: true }).where(eq(templates.slug, "wedding-classic"));
    }
  });
});

describe("мелкие исправления", () => {
  it("счётчик SMS гостя не учитывает неудачные отправки", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня"], 1);
    const base = { purpose: "invite" as const, phone: "998901112233", invitationId: inv.id, guestId: added[0]!.id, provider: "mock" };
    await db.insert(smsMessages).values([
      { ...base, status: "delivered", createdAt: new Date("2030-01-01T10:00:00Z") },
      { ...base, purpose: "reminder", status: "failed", createdAt: new Date("2030-01-01T11:00:00Z") },
      { ...base, purpose: "reminder", status: "failed", createdAt: new Date("2030-01-01T12:00:00Z") },
    ]);
    expect((await ownerGuests(cookie, inv.id))[0].sms).toEqual({ status: "failed", count: 1 });
  });

  it("в содержимом только свои загруженные файлы; общий файл не удаляется при замене превью", async () => {
    const upload = async (cookie: string) => {
      const form = multipart("file", "photo.png", "image/png", samples.png);
      const res = await req(cookie, "POST", "/api/media", form.payload, form.headers);
      expect(res.statusCode, res.body).toBe(201);
      return res.json().url as string;
    };
    const a = await user();
    const b = await user();
    const foreign = await upload(a.cookie);

    const bad = await req(b.cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover: foreign } }, { "x-lang": "en" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("The file must be uploaded via /api/media");
    const own = await create(b.cookie, { template: "wedding-classic", data: { cover: await upload(b.cookie) } });
    expect((await req(b.cookie, "PATCH", `/api/invitations/${own.id}`, { data: { gallery: [foreign] } })).statusCode).toBe(400);
    expect((await req(b.cookie, "PATCH", `/api/invitations/${own.id}`, { data: { gallery: ["/media/00000000-0000-0000-0000-000000000000.png"] } })).statusCode).toBe(400);
    // Уже сохранённый адрес не мешает менять остальное.
    expect((await req(b.cookie, "PATCH", `/api/invitations/${own.id}`, { data: { names: "Б" } })).statusCode).toBe(200);

    // Картинка превью первого приглашения стала обложкой второго: замена превью её не удаляет.
    const put = (id: string) =>
      t.app.inject({ method: "PUT", url: `/api/invitations/${id}/og`, payload: samples.png, headers: { cookie: a.cookie, origin: APP_URL, "content-type": "image/png" } });
    const first = await create(a.cookie, { template: "wedding-classic" });
    const { ogImageUrl } = (await put(first.id)).json();
    await create(a.cookie, { template: "wedding-classic", data: { cover: ogImageUrl } });
    expect((await put(first.id)).statusCode).toBe(200);
    expect((await get(ogImageUrl)).statusCode).toBe(200);
  });

  it("прежнюю ссылку старого формата можно прислать обратно", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { template: "wedding-classic" });
    await db.update(invitations).set({ slug: "Legacy_Abc12" }).where(eq(invitations.id, inv.id));
    const same = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "Legacy_Abc12", data: { names: "Той" } });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().slug).toBe("Legacy_Abc12");
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "Other_Slug" })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "new-slug-60001" })).statusCode).toBe(200);
  });

  it("Telegram не предлагается, когда бот выключен", async () => {
    const cfg = config as { -readonly [K in keyof Config]: Config[K] };
    expect((await get("/api/auth/config")).json()).toMatchObject({ telegram: true, botUsername: "invite_test_bot" });
    const { inv } = await sharedPublished();
    const prev = cfg.TELEGRAM_MODE;
    cfg.TELEGRAM_MODE = "off";
    try {
      expect((await get("/api/auth/config")).json()).toMatchObject({ telegram: false, botUsername: null });
      expect((await get(`/api/public/i/${inv.slug}`)).json().botUsername).toBeNull();
      expect((await req(null, "POST", "/api/auth/telegram/start", {})).statusCode).toBe(503);
    } finally {
      cfg.TELEGRAM_MODE = prev;
    }
    expect(botUsername({ TELEGRAM_MODE: "polling", TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_USERNAME: "x" })).toBeNull();
    expect(botUsername({ TELEGRAM_MODE: "webhook", TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_BOT_USERNAME: "" })).toBeNull();
  });
});

describe("миграция старого содержимого", () => {
  it("переводит поля invite-cover в поля Invito и не меняет данные при повторном запуске", async () => {
    const { user: u, cookie } = await user();
    await db.insert(templates).values({ slug: "invite-cover", title: "Обложка", isActive: false }).onConflictDoNothing();
    const [tpl] = await db.select().from(templates).where(eq(templates.slug, "invite-cover"));
    const rows = [
      {
        title: "Свадьба Азиза",
        data: {
          hosts: "Азиз и Мадина",
          event: "Свадьба",
          date: "12.09.2026",
          time: "18:00",
          venue: "Ресторан «Навруз»",
          address: "Ташкент",
          mapUrl: "https://maps.example/x",
          message: "Ждём вас",
        },
      },
      { title: "Мой праздник", data: { event: " ", hosts: "", date: "в субботу", time: "вечером", venue: "x".repeat(250), notes: "Старое" } },
      { title: "Т", data: { hosts: "Ли", names: "Уже есть", date: "31.02.2026", time: "7.05" } },
      { title: "Т", data: { event: "Той", date: "2026-1-5", time: "25:00" } },
      { title: "Т", data: { names: "Новые", date: "2026-01-02" } },
    ];
    const ids = [];
    for (const [i, r] of rows.entries()) {
      const [inv] = await db
        .insert(invitations)
        .values({ userId: u.id, templateId: tpl!.id, mode: "shared", title: r.title, slug: `legacy-${u.id.slice(0, 8)}-${i}`, data: r.data as never })
        .returning();
      ids.push(inv!.id);
    }

    const migration = readFileSync(new URL("../drizzle/0004_legacy_content.sql", import.meta.url), "utf8");
    const expected = [
      {
        names: "Свадьба",
        host: "Азиз и Мадина",
        date: "2026-09-12",
        time: "18:00",
        venue: "Ресторан «Навруз»",
        address: "Ташкент",
        message: "Ждём вас",
        notes: "https://maps.example/x",
      },
      { names: "Мой праздник", venue: "x".repeat(200), notes: "Старое\nв субботу\nвечером" },
      { names: "Уже есть", host: "Ли", time: "07:05", notes: "31.02.2026" },
      { names: "Той", date: "2026-01-05", notes: "25:00" },
      { names: "Новые", date: "2026-01-02" },
    ];
    for (let run = 0; run < 2; run++) {
      await db.execute(sql.raw(migration));
      for (const [i, id] of ids.entries()) expect((await invOf(id)).data, `запуск ${run + 1}, строка ${i}`).toEqual(expected[i]);
    }

    // Владелец видит переведённые поля.
    expect((await req(cookie, "GET", `/api/invitations/${ids[0]}`)).json().data).toMatchObject({ names: "Свадьба", host: "Азиз и Мадина", date: "2026-09-12" });
    expect(await db.select().from(invitations).where(and(eq(invitations.templateId, tpl!.id), sql`${invitations.data} ? 'hosts'`))).toHaveLength(0);
  });
});
