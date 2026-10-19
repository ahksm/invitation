import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramNotifier } from "../src/bot/notifier.js";
import { cacheKeys } from "../src/cache.js";
import { guests, invitations, smsMessages, templates, users } from "../src/db/schema.js";
import { noopNotifier } from "../src/notifier.js";
import { APP_URL, fakeTelegram, testContext } from "./helpers.js";

const t = testContext();
const { db, redis, cache, login, req, pay, telegram, smsSent } = t;

let nextUser = 30_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Персональное опубликованное приглашение. guests: имя и, если нужно, телефон. */
async function personal(cookie: string, list: { name: string; phone?: string }[], seats: number, data: Record<string, unknown> = { names: "Анна и Тимур", date: "2026-12-26", time: "18:00" }) {
  const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "personal", language: "ru", data })).json();
  const added = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: list })).json() as { id: string; token: string; name: string }[];
  await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: seats });
  expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
  return { inv, added };
}

const sentTo = (chatId: number) => telegram.sent.filter((m) => m.chatId === chatId);
const activity = async (cookie: string, id: string) => (await req(cookie, "GET", `/api/invitations/${id}/activity`)).json() as { kind: string; meta: unknown }[];
const smsTemplates = (on: boolean) => db.update(templates).set({ smsEnabled: on }).where(eq(templates.slug, "wedding-classic"));

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
  telegram.sent.length = 0;
  telegram.failChats.clear();
  smsSent.length = 0;
});

afterEach(async () => {
  await smsTemplates(false);
  t.app.ctx.notifier = createTelegramNotifier(telegram.api, t.app.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("Telegram-уведомления", () => {
  it("https-кнопки уходят клавиатурой, остальные ссылки текстом, ошибки не выбрасываются", async () => {
    const tg = fakeTelegram();
    const n = createTelegramNotifier(tg.api, t.app.ctx);
    expect(n.enabled).toBe(true);
    expect(await n.sendToChat(5, "Привет", { buttons: [{ text: "Открыть", url: "https://example.com/g/x" }, { text: "Локально", url: "http://localhost/app/" }] })).toBe(true);
    expect(tg.sent[0]).toMatchObject({ chatId: 5, text: "Привет\nЛокально: http://localhost/app/" });
    expect(tg.sent[0]!.other.reply_markup.inline_keyboard).toEqual([[{ text: "Открыть", url: "https://example.com/g/x" }]]);
    expect(tg.sent[0]!.other.link_preview_options).toEqual({ is_disabled: true });

    tg.failChats.add(6);
    expect(await n.sendToChat(6, "Привет")).toBe(false);

    // sendToUser: только пользователю с Telegram и без блокировки.
    const { user: withTg } = await user();
    expect(await n.sendToUser(withTg.id, "Тест")).toBe(true);
    expect(tg.sent.at(-1)).toMatchObject({ chatId: withTg.telegramId, text: "Тест" });
    const [phoneOnly] = await db.insert(users).values({ phone: "998977000001" }).returning();
    expect(await n.sendToUser(phoneOnly!.id, "Тест")).toBe(false);
    const { user: blocked } = await user({ blocked: true });
    expect(await n.sendToUser(blocked.id, "Тест")).toBe(false);
    expect(await n.sendToUser("00000000-0000-0000-0000-000000000000", "Тест")).toBe(false);
    expect(tg.sent).toHaveLength(2);

    expect(await noopNotifier.sendToUser(withTg.id, "x")).toBe(false);
    expect(noopNotifier.enabled).toBe(false);
  });

  it("владелец получает ответы гостей и отметки на входе на своём языке", async () => {
    const { cookie, user: owner } = await user();
    const { inv, added } = await personal(cookie, [{ name: "Аня Иванова" }, { name: "Боря" }], 2);

    const r = await req(null, "POST", `/api/public/g/${added[0]!.token}/rsvp`, { status: "yes", count: 2, msg: "  Поздравляем!  " });
    expect(r.statusCode).toBe(200);
    await vi.waitFor(() => expect(sentTo(owner.telegramId!)).toHaveLength(1));
    expect(sentTo(owner.telegramId!)[0]!.text).toBe(
      `✅ Аня Иванова придёт (+1)\nПриглашение: Анна и Тимур\nПожелание: Поздравляем!\nМои приглашения: ${APP_URL}/app/`,
    );

    await db.update(users).set({ locale: "en" }).where(eq(users.id, owner.id));
    await redis.del(`inv:${cacheKeys.user(owner.id)}`);
    await req(null, "POST", `/api/public/g/${added[1]!.token}/rsvp`, { status: "no", count: 3 });
    await vi.waitFor(() => expect(sentTo(owner.telegramId!)).toHaveLength(2));
    expect(sentTo(owner.telegramId!)[1]!.text).toBe(`❌ Боря can't come\nInvitation: Анна и Тимур\nMy invitations: ${APP_URL}/app/`);

    await db.update(users).set({ locale: "uzc" }).where(eq(users.id, owner.id));
    await redis.del(`inv:${cacheKeys.user(owner.id)}`);
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/checkin`, { token: added[0]!.token })).statusCode).toBe(200);
    await vi.waitFor(() => expect(sentTo(owner.telegramId!)).toHaveLength(3));
    expect(sentTo(owner.telegramId!)[2]!.text).toMatch(/^🎟 Аня Иванова: киришда белгиланди\nТаклифнома: Анна и Тимур\n/);

    // Повторная отметка и снятие отметки уведомлений не шлют; отметка через PATCH шлёт.
    await req(cookie, "POST", `/api/invitations/${inv.id}/checkin`, { token: added[0]!.token });
    await req(cookie, "PATCH", `/api/invitations/${inv.id}/guests/${added[1]!.id}`, { checkedIn: true });
    await vi.waitFor(() => expect(sentTo(owner.telegramId!)).toHaveLength(4));
    await req(cookie, "PATCH", `/api/invitations/${inv.id}/guests/${added[1]!.id}`, { checkedIn: true });
    await sleep(150);
    expect(sentTo(owner.telegramId!)).toHaveLength(4);
  });

  it("ответ по общей ссылке тоже уведомляет; без notify, Telegram или бота уведомлений нет", async () => {
    const { cookie, user: owner } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", data: { names: "Той" } })).json();
    await pay(cookie, { kind: "template", invitationId: inv.id });
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    await req(null, "POST", `/api/public/i/${inv.slug}/rsvp`, { name: "Гость", status: "maybe", count: 1 });
    await vi.waitFor(() => expect(sentTo(owner.telegramId!)).toHaveLength(1));
    expect(sentTo(owner.telegramId!)[0]!.text).toMatch(/^🤔 Гость, возможно, придёт\n/);

    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { settings: { notify: false } });
    await req(null, "POST", `/api/public/i/${inv.slug}/rsvp`, { name: "Второй", status: "yes", count: 1 });
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { settings: { notify: true } });
    t.app.ctx.notifier = noopNotifier;
    await req(null, "POST", `/api/public/i/${inv.slug}/rsvp`, { name: "Третий", status: "yes", count: 1 });
    t.app.ctx.notifier = createTelegramNotifier(telegram.api, t.app.ctx);

    // Владелец без Telegram (вход по телефону).
    const [phoneOwner] = await db.insert(users).values({ phone: "998977000002" }).returning();
    const cookie2 = `session=${t.app.jwt.sign({ sub: phoneOwner!.id })}`;
    const inv2 = (await req(cookie2, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", data: { names: "Той" } })).json();
    await db.update(invitations).set({ unlocked: true }).where(eq(invitations.id, inv2.id));
    await req(cookie2, "POST", `/api/invitations/${inv2.id}/publish`);
    expect((await req(null, "POST", `/api/public/i/${inv2.slug}/rsvp`, { name: "Гость", status: "yes", count: 1 })).statusCode).toBe(200);

    await sleep(200);
    expect(telegram.sent).toHaveLength(1);
  });

  it("ошибка Telegram не мешает ответу гостя", async () => {
    const { cookie, user: owner } = await user();
    const { inv, added } = await personal(cookie, [{ name: "Аня" }], 1);
    telegram.failChats.add(owner.telegramId!);
    const r = await req(null, "POST", `/api/public/g/${added[0]!.token}/rsvp`, { status: "yes", count: 1 });
    expect(r.statusCode).toBe(200);
    await sleep(100);
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().guests[0].rsvp).toBe("yes");
    expect(sentTo(owner.telegramId!)).toHaveLength(0);
  });
});

describe("POST /bot/test", () => {
  it("шлёт пробное сообщение владельцу и пишет событие test", async () => {
    const { cookie, user: owner } = await user();
    const { inv } = await personal(cookie, [{ name: "Аня" }], 1);
    const url = `/api/invitations/${inv.id}/bot/test`;

    const r = await req(cookie, "POST", url);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(sentTo(owner.telegramId!)[0]!.text).toBe(
      `🔔 Проверка уведомлений: «Анна и Тимур». Сюда будут приходить ответы гостей и отметки на входе.\nМои приглашения: ${APP_URL}/app/`,
    );
    expect((await activity(cookie, inv.id)).filter((a) => a.kind === "test")).toHaveLength(1);

    // С выключенными уведомлениями сообщение приходит и говорит об этом.
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { settings: { notify: false } });
    await req(cookie, "POST", url);
    expect(sentTo(owner.telegramId!)[1]!.text).toContain("Сейчас уведомления для этого приглашения выключены");

    // Telegram не принял сообщение (владелец остановил бота).
    telegram.failChats.add(owner.telegramId!);
    const failed = await req(cookie, "POST", url, undefined, { "x-lang": "en" });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe("Could not send the message to Telegram");
    expect((await activity(cookie, inv.id)).filter((a) => a.kind === "test")).toHaveLength(2);

    t.app.ctx.notifier = noopNotifier;
    expect((await req(cookie, "POST", url)).statusCode).toBe(503);

    // Чужое приглашение.
    const { cookie: other } = await user();
    expect((await req(other, "POST", url)).statusCode).toBe(404);
  });

  it("без Telegram у владельца 409", async () => {
    const [u] = await db.insert(users).values({ phone: "998977000003" }).returning();
    const cookie = `session=${t.app.jwt.sign({ sub: u!.id })}`;
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic" })).json();
    const r = await req(cookie, "POST", `/api/invitations/${inv.id}/bot/test`, undefined, { "x-lang": "uz" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("Bildirishnomalarni olish uchun Telegramni ulang");
  });
});

describe("POST /remind", () => {
  it("сначала Telegram, иначе SMS; только гостям без ответа и раз в 12 часов", async () => {
    await smsTemplates(true);
    const { cookie } = await user();
    const { inv, added } = await personal(
      cookie,
      [
        { name: "Аня", phone: "901110001" },
        { name: "Боря", phone: "901110002" },
        { name: "Вика" },
        { name: "Гена", phone: "901110004" },
        { name: "Даша", phone: "901110005" },
      ],
      4,
    );
    const [a, b, c, g, d] = added as [(typeof added)[0], (typeof added)[0], (typeof added)[0], (typeof added)[0], (typeof added)[0]];
    await db.update(guests).set({ telegramChatId: 7001 }).where(eq(guests.id, a.id));
    await req(cookie, "PATCH", `/api/invitations/${inv.id}/guests/${g.id}`, { rsvp: "yes" });

    const url = `/api/invitations/${inv.id}/remind`;
    const r = await req(cookie, "POST", url, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      telegram: 1,
      sms: 1,
      skipped: [
        { guestId: c.id, name: "Вика", reason: "no_phone" },
        { guestId: d.id, name: "Даша", reason: "seat_unpaid" },
      ],
      limited: false,
    });
    const tg = sentTo(7001);
    expect(tg).toHaveLength(1);
    expect(tg[0]!.text).toMatch(/^Аня, напоминаем о приглашении: Анна и Тимур, 26 декабря 2026.*, 18:00\.\nОтветьте, пожалуйста, получится ли у вас прийти\.\n/);
    expect(tg[0]!.text.endsWith(`Открыть приглашение: ${APP_URL}/g/${a.token}`)).toBe(true);
    expect(smsSent).toEqual([{ phone: "998901110002", text: `Боря, напоминаем: Анна и Тимур, 26.12.2026. Ждём ваш ответ: ${APP_URL}/g/${b.token}` }]);
    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.guestId, b.id));
    expect(row).toMatchObject({ purpose: "reminder", invitationId: inv.id, status: "sent" });
    expect((await activity(cookie, inv.id)).filter((x) => x.kind === "reminder").map((x) => x.meta)).toEqual([{ n: 2 }]);

    // Повтор сразу: никому второй раз, событие не пишется.
    const again = (await req(cookie, "POST", url, {})).json();
    expect(again).toMatchObject({ telegram: 0, sms: 0 });
    expect(again.skipped.map((s: { reason: string }) => s.reason)).toEqual(["recently_reminded", "recently_reminded", "no_phone", "seat_unpaid"]);
    expect(sentTo(7001)).toHaveLength(1);
    expect(smsSent).toHaveLength(1);
    expect((await activity(cookie, inv.id)).filter((x) => x.kind === "reminder")).toHaveLength(1);

    // guestIds: только указанные, в том числе ответившие.
    const chosen = (await req(cookie, "POST", url, { guestIds: [g.id] })).json();
    expect(chosen).toEqual({ telegram: 0, sms: 1, skipped: [], limited: false });
    expect(smsSent[1]!.phone).toBe("998901110004");

    expect((await req(cookie, "POST", url, { guestIds: ["nope"] })).statusCode).toBe(400);
  });

  it("если Telegram не принял, уходит SMS; без SMS у шаблона — no_channel", async () => {
    const { cookie } = await user();
    const { inv, added } = await personal(cookie, [{ name: "Аня", phone: "901110011" }, { name: "Боря", phone: "901110012" }], 2);
    await db.update(guests).set({ telegramChatId: 7002 }).where(eq(guests.id, added[0]!.id));
    telegram.failChats.add(7002);

    // SMS для шаблона выключены: Аня (Telegram не принял) и Боря без канала.
    const off = (await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, {})).json();
    expect(off).toEqual({
      telegram: 0,
      sms: 0,
      skipped: [
        { guestId: added[0]!.id, name: "Аня", reason: "send_failed" },
        { guestId: added[1]!.id, name: "Боря", reason: "no_channel" },
      ],
      limited: false,
    });

    // Неудача не ставит отметку «напомнили»: после включения SMS обоим уходит SMS.
    await smsTemplates(true);
    const on = (await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, {})).json();
    expect(on).toEqual({ telegram: 0, sms: 2, skipped: [], limited: false });
    expect(smsSent.map((s) => s.phone)).toEqual(["998901110011", "998901110012"]);

    // Без бота Telegram не пробуется.
    await redis.flushdb();
    telegram.failChats.clear();
    t.app.ctx.notifier = noopNotifier;
    const noBot = (await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, { guestIds: [added[0]!.id] })).json();
    expect(noBot).toMatchObject({ telegram: 0, sms: 1 });
    expect(sentTo(7002)).toHaveLength(0);
  });

  it("неопубликованное приглашение и общий режим", async () => {
    const { cookie } = await user();
    const draft = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "personal" })).json();
    expect((await req(cookie, "POST", `/api/invitations/${draft.id}/remind`, {})).statusCode).toBe(400);

    // В общем приглашении SMS не отправляются: только гости, подключившие бота.
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", data: { names: "Той" } })).json();
    await pay(cookie, { kind: "template", invitationId: inv.id });
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    await req(null, "POST", `/api/public/i/${inv.slug}/rsvp`, { name: "Гость", status: "yes", count: 1 });
    const [self] = await db.select().from(guests).where(eq(guests.invitationId, inv.id));
    await db.update(guests).set({ telegramChatId: 7003 }).where(eq(guests.id, self!.id));
    await smsTemplates(true);
    const r = (await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, { guestIds: [self!.id] })).json();
    expect(r).toEqual({ telegram: 1, sms: 0, skipped: [], limited: false });
    expect(sentTo(7003)[0]!.text).toMatch(/^Гость, напоминаем о приглашении: Той\./);
  });
});

describe("лимиты SMS", () => {
  it("3 на гостя и paidSeats × 3 на приглашение считают приглашения и напоминания вместе", async () => {
    await smsTemplates(true);
    const { cookie } = await user();
    const { inv, added } = await personal(cookie, [{ name: "Аня", phone: "901110021" }, { name: "Боря", phone: "901110022" }], 1);
    const [a, b] = added as [(typeof added)[0], (typeof added)[0]];
    const sms = (body: unknown) => req(cookie, "POST", `/api/invitations/${inv.id}/sms`, body);
    const remind = (body: unknown) => req(cookie, "POST", `/api/invitations/${inv.id}/remind`, body);

    expect((await sms({ guestIds: [a.id] })).json()).toMatchObject({ sent: 1 });
    expect((await sms({ guestIds: [a.id] })).json()).toMatchObject({ sent: 1 });
    expect((await remind({ guestIds: [a.id] })).json()).toMatchObject({ sms: 1 });
    await redis.flushdb();
    expect((await remind({ guestIds: [a.id] })).json().skipped).toEqual([{ guestId: a.id, name: "Аня", reason: "limit_reached" }]);
    // Отказ по лимиту не ставит отметку «напомнили».
    expect((await remind({ guestIds: [a.id] })).json().skipped[0].reason).toBe("limit_reached");
    expect((await sms({ guestIds: [a.id] })).json().skipped).toEqual([{ guestId: a.id, name: "Аня", reason: "limit_reached" }]);

    // Аню удалили: Боря оплачен, но 3 SMS удалённой гостьи исчерпали лимит приглашения (1 место × 3).
    await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${a.id}`);
    expect((await remind({ guestIds: [b.id] })).json().skipped).toEqual([{ guestId: b.id, name: "Боря", reason: "invitation_limit" }]);
    expect((await sms({})).json().skipped).toEqual([{ guestId: b.id, name: "Боря", reason: "invitation_limit" }]);
    expect(smsSent).toHaveLength(3);

    const detail = (await req(cookie, "GET", `/api/invitations/${inv.id}`)).json();
    expect(detail.guests[0]).toMatchObject({ id: b.id, sms: null });
  });

  it("часовой лимит: проверка до рассылки, частичный результат и досылка без дублей", async () => {
    await smsTemplates(true);
    const { cookie, user: owner } = await user();
    const { inv, added } = await personal(
      cookie,
      [{ name: "Аня", phone: "901110031" }, { name: "Боря", phone: "901110032" }, { name: "Вика", phone: "901110033" }],
      3,
    );
    const hourKey = `inv:rl:sms:user:${owner.id}`;
    await redis.set(hourKey, 298, "EX", 3600);
    const r = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json();
    expect(r).toEqual({ sent: 2, skipped: [{ guestId: added[2]!.id, name: "Вика", reason: "rate_limited" }], limited: true });
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}/activity`)).json().filter((x: { kind: string }) => x.kind === "sms")[0].meta).toEqual({ n: 2 });

    // Лимит исчерпан: сразу 429, ничего не отправляется.
    const limited = await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {}, { "x-lang": "en" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("Too many SMS this hour, please try later");

    // Через час: «всем» дошлёт только Вике.
    await redis.del(hourKey);
    const rest = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json();
    expect(rest).toEqual({
      sent: 1,
      skipped: [
        { guestId: added[0]!.id, name: "Аня", reason: "already_sent" },
        { guestId: added[1]!.id, name: "Боря", reason: "already_sent" },
      ],
      limited: false,
    });
    expect(smsSent.map((s) => s.phone)).toEqual(["998901110031", "998901110032", "998901110033"]);

    // Напоминания при исчерпанном лимите: Telegram уходит, SMS помечаются rate_limited.
    await db.update(guests).set({ telegramChatId: 7004 }).where(eq(guests.id, added[0]!.id));
    await redis.set(hourKey, 300, "EX", 3600);
    const rem = (await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, {})).json();
    expect(rem).toMatchObject({ telegram: 1, sms: 0, limited: true });
    expect(rem.skipped.map((s: { reason: string }) => s.reason)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("рассылки одного приглашения идут по одной", async () => {
    await smsTemplates(true);
    const { cookie } = await user();
    const { inv } = await personal(cookie, [{ name: "Аня", phone: "901110041" }, { name: "Боря", phone: "901110042" }, { name: "Вика", phone: "901110043" }], 3);

    const held = await cache.lock(cacheKeys.sendLock(inv.id), 60);
    const busy = await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("Рассылка уже идёт, подождите");
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/remind`, {})).statusCode).toBe(409);
    await held!.release();

    // Двойной клик: каждому гостю ровно одно SMS.
    const results = await Promise.all([1, 2, 3].map(() => req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})));
    expect(results.map((r) => r.statusCode).every((s) => s === 200 || s === 409)).toBe(true);
    expect(results.reduce((n, r) => n + (r.statusCode === 200 ? r.json().sent : 0), 0)).toBe(3);
    expect(smsSent.map((s) => s.phone).sort()).toEqual(["998901110041", "998901110042", "998901110043"]);
    // Блокировка снята.
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).statusCode).toBe(200);
  });

  it("в SMS имена или событие, а не служебные названия", async () => {
    await smsTemplates(true);
    const { cookie } = await user();
    const { inv, added } = await personal(cookie, [{ name: "Аня", phone: "901110051" }], 1, {});
    await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {});
    expect(smsSent[0]!.text).toBe(`Аня, приглашаем вас: Свадьба. Ваше приглашение: ${APP_URL}/g/${added[0]!.token}`);
  });
});
