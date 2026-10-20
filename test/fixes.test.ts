import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/index.js";
import { invitations, orders, subscriptions, templates, users } from "../src/db/schema.js";
import { createMockProvider } from "../src/payments/mock.js";
import { applyPayment } from "../src/services/orders.js";
import { parseUserRef } from "../src/services/user-ref.js";
import { upsertTelegramUser } from "../src/services/users.js";
import { createMockSms } from "../src/sms/mock.js";
import { reminderText } from "../src/sms/texts.js";
import { sessionCookie, testContext } from "./helpers.js";
import { signInitData } from "./telegram.test.js";

const ADMIN_PHONE = "998977100001";
const t = testContext({ ADMIN_PHONES: ADMIN_PHONE });
const { db, redis, cache, config, smsSent, login, req, callback } = t;

let nextUser = 50_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);
const admin = () => login(1);

/** Минимальное окружение для loadConfig. */
const baseEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", JWT_SECRET: "x".repeat(32) };

/** Открывает в пуле несколько соединений, чтобы параллельные транзакции шли одновременно, а не по очереди. */
const warmPool = () => Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.05)`)));

/** Вход по коду из SMS: номер, язык запроса и cookie сессии. */
async function phoneLogin(phone: string) {
  smsSent.length = 0;
  await req(null, "POST", "/api/auth/phone/request", { phone });
  const code = smsSent[0]!.text.match(/\d{6}/)![0];
  const res = await req(null, "POST", "/api/auth/phone/verify", { phone, code });
  expect(res.statusCode, res.body).toBe(200);
  return { res, cookie: sessionCookie(res)! };
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

describe("конфигурация", () => {
  it("TRUST_PROXY: число прокси или их адреса; true запрещён", () => {
    const proxy = (v: string) => loadConfig({ ...baseEnv, TRUST_PROXY: v }).TRUST_PROXY;
    expect(loadConfig(baseEnv).TRUST_PROXY).toBe(false);
    expect(proxy("false")).toBe(false);
    expect(proxy("")).toBe(false);
    expect(proxy("1")).toBe(1);
    expect(proxy(" 2 ")).toBe(2);
    expect(proxy("127.0.0.1, 10.0.0.0/8,::1")).toEqual(["127.0.0.1", "10.0.0.0/8", "::1"]);
    expect(proxy("loopback,uniquelocal")).toEqual(["loopback", "uniquelocal"]);
    expect(() => proxy("true")).toThrow(/TRUST_PROXY=true/);
    expect(() => proxy("11")).toThrow(/TRUST_PROXY/);
    expect(() => proxy("nginx")).toThrow(/неверно: nginx/);
    expect(() => proxy("10.0.0.0/40")).toThrow(/TRUST_PROXY/);
  });

  it("секрет вебхука нужен в любом окружении; пустой AI_MODEL — модель по умолчанию", () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "development", TELEGRAM_MODE: "webhook" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(loadConfig({ ...baseEnv, TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: "s".repeat(16) }).TELEGRAM_MODE).toBe("webhook");
    expect(loadConfig({ ...baseEnv, AI_MODEL: "" }).AI_MODEL).toBe("claude-opus-5-5");
    expect(loadConfig({ ...baseEnv, AI_MODEL: "claude-x" }).AI_MODEL).toBe("claude-x");
  });

  it("IP клиента: только заданное число прокси или доверенные адреса", async () => {
    const ipOf = async (trustProxy: string, remoteAddress: string, xff?: string) => {
      const cfg = loadConfig({ ...configEnv(), TRUST_PROXY: trustProxy });
      const app = await buildApp(
        { config: cfg, db, cache, payments: createMockProvider({ appUrl: cfg.APP_URL, secret: "s" }), sms: createMockSms({ info: () => {} }, []) },
        { logger: false },
      );
      app.get("/ip", async (r) => ({ ip: r.ip }));
      try {
        const res = await app.inject({ url: "/ip", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} });
        return res.json().ip as string;
      } finally {
        await app.close();
      }
    };
    expect(await ipOf("false", "10.0.0.5", "1.1.1.1")).toBe("10.0.0.5");
    // Один прокси: берётся адрес, который добавил он (последний), подделка клиента левее игнорируется.
    expect(await ipOf("1", "10.0.0.5", "6.6.6.6, 1.1.1.1")).toBe("1.1.1.1");
    expect(await ipOf("2", "10.0.0.5", "6.6.6.6, 1.1.1.1")).toBe("6.6.6.6");
    expect(await ipOf("1", "10.0.0.5")).toBe("10.0.0.5");
    // Список: заголовок принимается только от доверенного адреса.
    expect(await ipOf("10.0.0.0/8", "10.0.0.5", "1.1.1.1")).toBe("1.1.1.1");
    expect(await ipOf("10.0.0.0/8", "8.8.8.8", "1.1.1.1")).toBe("8.8.8.8");
  });

  it("ошибка простаивающего соединения Postgres не роняет процесс", async () => {
    const onError = vi.fn();
    const { pool } = createDb("postgres://invite:invite@127.0.0.1:1/none", onError);
    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("error", new Error("terminating connection due to administrator command"));
    expect(onError).toHaveBeenCalledOnce();
    await pool.end();
  });
});

/** Переменные тестового окружения (из helpers) в виде env для loadConfig. */
function configEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_URL: config.APP_URL,
    DATABASE_URL: config.DATABASE_URL,
    REDIS_URL: config.REDIS_URL,
    JWT_SECRET: config.JWT_SECRET,
    MEDIA_DIR: config.MEDIA_DIR,
  };
}

describe("права админа", () => {
  it("пересчитываются по ADMIN_PHONES и ADMIN_TELEGRAM_IDS при входе и сразу после изменения списков", async () => {
    const { res, cookie } = await phoneLogin(ADMIN_PHONE);
    expect(res.json().redirect).toBe("/admin/");
    expect((await req(cookie, "GET", "/api/admin/stats")).statusCode).toBe(200);

    // Обновление из Telegram (бот, мини-апп) больше не снимает права, выданные по телефону.
    const [row] = await db.update(users).set({ telegramId: 50_999 }).where(eq(users.phone, ADMIN_PHONE)).returning();
    const fromBot = await upsertTelegramUser(t.app.ctx, { id: 50_999, first_name: "Admin" });
    expect(fromBot).toMatchObject({ id: row!.id, isAdmin: true });
    expect((await db.select().from(users).where(eq(users.id, row!.id)))[0]!.isAdmin).toBe(true);

    // Номер убрали из ADMIN_PHONES: права пропадают сразу, без нового входа.
    const phones = config.ADMIN_PHONES;
    config.ADMIN_PHONES = [];
    try {
      expect((await req(cookie, "GET", "/api/admin/stats")).statusCode).toBe(403);
      expect((await req(cookie, "GET", "/api/auth/me")).json().user.isAdmin).toBe(false);
      // При следующем входе колонка тоже обновляется.
      await upsertTelegramUser(t.app.ctx, { id: 50_999 });
      expect((await db.select().from(users).where(eq(users.id, row!.id)))[0]!.isAdmin).toBe(false);
    } finally {
      config.ADMIN_PHONES = phones;
    }

    // Колонка устарела (человека добавили в список, а он ещё не входил): админка показывает права по спискам.
    const { cookie: adm } = await admin();
    await db.update(users).set({ isAdmin: false }).where(eq(users.telegramId, 1));
    const list = (await req(adm, "GET", `/api/admin/users?q=${ADMIN_PHONE.slice(3)}`)).json();
    expect(list.items[0]).toMatchObject({ phone: ADMIN_PHONE, isAdmin: true });
    expect((await req(adm, "GET", "/api/admin/stats")).statusCode).toBe(200);
  });
});

describe("бесплатный доступ: телефон или Telegram ID", () => {
  it("parseUserRef не путает девять цифр Telegram ID с номером", () => {
    expect(parseUserRef("901234567")).toEqual({ telegramId: 901234567 });
    expect(parseUserRef("tg:901234567")).toEqual({ telegramId: 901234567 });
    expect(parseUserRef("TG 42")).toEqual({ telegramId: 42 });
    expect(parseUserRef("id:7")).toEqual({ telegramId: 7 });
    expect(parseUserRef("@123456789")).toEqual({ telegramId: 123456789 });
    expect(parseUserRef("5000000001")).toEqual({ telegramId: 5000000001 });
    expect(parseUserRef("+998901234567")).toEqual({ phone: "998901234567" });
    expect(parseUserRef("998901234567")).toEqual({ phone: "998901234567" });
    expect(parseUserRef("+998 90 123-45-67")).toEqual({ phone: "998901234567" });
    expect(parseUserRef("90 123 45 67")).toEqual({ phone: "998901234567" });
    expect(parseUserRef("+7 701 123 45 67")).toBeNull();
    expect(parseUserRef("@username")).toBeNull();
    expect(parseUserRef("tg:0")).toBeNull();
    expect(parseUserRef("tg:9999999999999999")).toBeNull();
    expect(parseUserRef("")).toBeNull();
  });

  it("выдаёт и снимает доступ нужному аккаунту", async () => {
    const { cookie } = await admin();
    const grant = (body: Record<string, unknown>) => req(cookie, "POST", "/api/admin/users/free-access", body);

    // Девять цифр: Telegram ID, а не номер +998 90 123-45-67.
    const r1 = await grant({ who: "901234567", note: "друг" });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ telegramId: 901234567, phone: null, freeAccess: true, freeAccessNote: "друг" });
    expect(await db.select().from(users).where(eq(users.phone, "998901234567"))).toHaveLength(0);

    // Уже существующий пользователь обновляется, а не создаётся заново.
    const { user: existing } = await user();
    const r2 = await grant({ who: `tg:${existing.telegramId}` });
    expect(r2.json()).toMatchObject({ id: existing.id, freeAccess: true });
    expect((await req((await login(existing.telegramId!)).cookie, "GET", "/api/auth/me")).json().access.free).toBe(true);

    const r3 = await grant({ who: "+998 90 123-45-67" });
    expect(r3.json()).toMatchObject({ phone: "998901234567", telegramId: null, freeAccess: true });

    // Снятие.
    const off = await grant({ who: "901234567", free: false });
    expect(off.json()).toMatchObject({ telegramId: 901234567, freeAccess: false });
    expect((await grant({ who: "+998901234567", free: false })).json()).toMatchObject({ phone: "998901234567", freeAccess: false });
    expect((await grant({ who: "tg:777000777", free: false })).statusCode).toBe(404);
    expect(await db.select().from(users).where(eq(users.telegramId, 777000777))).toHaveLength(0);

    const bad = await req(cookie, "POST", "/api/admin/users/free-access", { who: "@username" }, { "x-lang": "en" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("Enter a phone number or Telegram ID");
  });
});

describe("админка", () => {
  it("PATCH шаблона меняет только присланные поля", async () => {
    const { cookie } = await admin();
    // Старый шаблон без события (как invite-cover) идёт после каталога.
    await db.insert(templates).values({ slug: "aaa-legacy", title: "Старый", isActive: false });
    const list = (await req(cookie, "GET", "/api/admin/templates")).json();
    expect(list).toHaveLength(61);
    expect(list[0]).toMatchObject({ slug: "wedding-classic", event: "wedding", style: "classic" });
    expect(list.at(-1)).toMatchObject({ slug: "aaa-legacy", event: null });

    const fields = [{ key: "names", label: "Имена", type: "text" }];
    const translations = { en: { title: "Ivory" } };
    const [tpl] = await db
      .update(templates)
      .set({ smsEnabled: true, isActive: false, fields: fields as any, translations })
      .where(eq(templates.slug, "wedding-botanical"))
      .returning();
    const url = `/api/admin/templates/${tpl!.id}`;

    const r = await req(cookie, "PATCH", url, { price: 150_000_00 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ price: 150_000_00, smsEnabled: true, isActive: false, fields, translations, event: "wedding", style: "botanical" });
    expect((await req(cookie, "PATCH", url, { smsEnabled: false })).json()).toMatchObject({ price: 150_000_00, smsEnabled: false, isActive: false, fields });
    expect((await req(cookie, "PATCH", url, { isActive: true, price: null })).json()).toMatchObject({ price: null, smsEnabled: false, isActive: true, fields });
    expect((await req(cookie, "PATCH", url, {})).json()).toMatchObject({ id: tpl!.id, isActive: true });
    // Поля каталога меняет только сид.
    expect((await req(cookie, "PATCH", url, { fields: [] })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", url, { price: -1 })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", "/api/admin/templates/00000000-0000-0000-0000-000000000000", { price: 1 })).statusCode).toBe(404);
    expect((await req(cookie, "POST", "/api/admin/templates", { slug: "x", title: "X" })).statusCode).toBe(404);

    // Каталог для пользователей сразу видит изменения.
    const catalog = (await req(null, "GET", "/api/templates")).json();
    expect(catalog.find((x: { slug: string }) => x.slug === "wedding-botanical")).toMatchObject({ price: null, smsEnabled: false });
  });

  it("сумма оплат пользователя больше int4", async () => {
    const { cookie } = await admin();
    const { user: rich } = await user();
    const order = { userId: rich.id, kind: "seats" as const, quantity: 1, amount: 2_000_000_000, currency: "UZS", provider: "multicard", status: "paid" as const };
    await db.insert(orders).values([order, order]);
    const r = await req(cookie, "GET", `/api/admin/users?q=${rich.telegramId}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items[0]).toMatchObject({ id: rich.id, paidTotal: 4_000_000_000 });
    const paying = (await req(cookie, "GET", "/api/admin/users?filter=paying")).json();
    expect(paying.items.map((u: { id: string }) => u.id)).toContain(rich.id);
    expect((await req(cookie, "GET", "/api/admin/stats")).json().revenue).toBeGreaterThanOrEqual(4_000_000_000);
  });
});

describe("вход", () => {
  it("попытки ввода кода считаются атомарно, верный код срабатывает один раз", async () => {
    const phone = "998977100010";
    smsSent.length = 0;
    await req(null, "POST", "/api/auth/phone/request", { phone });
    const code = smsSent[0]!.text.match(/\d{6}/)![0];
    const verify = (c: string) => req(null, "POST", "/api/auth/phone/verify", { phone, code: c });

    // Параллельно три верных: сессию получает один запрос.
    const ok = await Promise.all([verify(code), verify(code), verify(code)]);
    expect(ok.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);

    // Новый код и 8 параллельных неверных попыток: код сгорает, ключ не остаётся без срока жизни.
    await redis.flushdb();
    smsSent.length = 0;
    await req(null, "POST", "/api/auth/phone/request", { phone });
    const code2 = smsSent[0]!.text.match(/\d{6}/)![0];
    const bad2 = code2 === "000000" ? "111111" : "000000";
    await Promise.all(Array.from({ length: 8 }, () => verify(bad2)));
    expect(await redis.exists(`inv:otp:${phone}`)).toBe(0);
    expect((await verify(code2)).statusCode).toBe(400);
    expect(await redis.exists(`inv:otp:${phone}`)).toBe(0);
  });

  it("сообщения схем о телефоне и коде доходят до пользователя на его языке", async () => {
    const phone = await req(null, "POST", "/api/auth/phone/request", { phone: "+7 701 123 45 67" }, { "x-lang": "en" });
    expect(phone.statusCode).toBe(400);
    expect(phone.json().error).toBe("Enter an Uzbek number: +998 XX XXX-XX-XX");
    const code = await req(null, "POST", "/api/auth/phone/verify", { phone: "998901234567", code: "12345" }, { "x-lang": "uz" });
    expect(code.json().error).toBe("Kod 6 ta raqamdan iborat");
    // Неизвестные сообщения zod по-прежнему дают общее «Неверные данные».
    expect((await req(null, "POST", "/api/auth/phone/request", {}, { "x-lang": "en" })).json().error).toBe("Invalid data");

    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "personal" })).json();
    const guests = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Аня", phone: "901234567" }, { name: "Боря", phone: "12" }] });
    expect(guests.json().error).toBe("Введите узбекский номер: +998 XX XXX-XX-XX");
    expect(guests.json().issues[0].path).toEqual(["guests", 1, "phone"]);
  });

  it("мини-апп может опрашивать /webapp раз в 3 секунды (40 в минуту)", async () => {
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 50_998, first_name: "Mini" }) });
    for (let i = 0; i < 40; i++) expect((await req(null, "POST", "/api/auth/webapp", { initData })).json()).toEqual({ status: "phone_required" });
    expect((await req(null, "POST", "/api/auth/webapp", { initData })).statusCode).toBe(429);
  });
});

describe("заказы", () => {
  it("бесплатные заказы отвечают на языке запроса и отменяют начатые оплаты шаблона", async () => {
    const { cookie, user: u } = await user();
    const shared = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared" })).json();
    const pending = (await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: shared.id })).json();
    expect(pending.status).toBe("pending");

    await db.update(users).set({ freeAccess: true }).where(eq(users.id, u.id));
    await redis.flushdb();
    const free = await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: shared.id }, { "x-lang": "uz" });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toEqual({ status: "fulfilled", order: null, message: "Shablon to‘lovsiz ochildi" });
    expect((await db.select().from(orders).where(eq(orders.id, pending.order.id)))[0]!.status).toBe("cancelled");

    // Старый счёт всё же оплатили: оплата отклоняется, Multicard её отменит.
    const late = await callback(pending.order.number, pending.order.amount);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual({ success: false, message: "Шаблон уже оплачен" });
    const [cancelled] = await db.select().from(orders).where(eq(orders.id, pending.order.id));
    expect(cancelled).toMatchObject({ status: "cancelled", paidAt: null, meta: { duplicate: true } });

    const personal = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "personal" })).json();
    const seats = (body: unknown, lang: string) => req(cookie, "POST", "/api/orders", body, { "x-lang": lang });
    expect((await seats({ kind: "seats", invitationId: personal.id, quantity: 3 }, "en")).json().message).toBe("Seats added: 3");
    expect((await seats({ kind: "seats", invitationId: personal.id, quantity: 2 }, "ru")).json().message).toBe("Добавлено мест: 2");
    expect((await seats({ kind: "seats", invitationId: personal.id, quantity: 1 }, "uzc")).json().message).toBe("Қўшилган жойлар: 1");
  });

  it("второй оплаченный счёт за тот же шаблон отклоняется", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared" })).json();
    const list = [];
    for (let i = 0; i < 3; i++) list.push((await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id })).json().order);
    const paid = { status: "paid" as const, raw: {} };
    await warmPool();
    const outcomes = await Promise.all(list.map((o) => applyPayment(t.app.ctx, { ...paid, orderNumber: o.number, amount: o.amount })));
    expect(outcomes.sort()).toEqual(["duplicate", "duplicate", "paid"]);
    const rows = await db.select().from(orders).where(eq(orders.invitationId, inv.id));
    expect(rows.map((o) => o.status).sort()).toEqual(["cancelled", "cancelled", "paid"]);
    expect((await db.select().from(invitations).where(eq(invitations.id, inv.id)))[0]!.unlocked).toBe(true);
    // Повторный колбэк по отклонённому счёту ничего не меняет.
    const dup = rows.find((o) => o.status === "cancelled")!;
    expect((await callback(dup.number, dup.amount)).statusCode).toBe(400);
    expect((await db.select().from(orders).where(and(eq(orders.invitationId, inv.id), eq(orders.status, "paid"))))).toHaveLength(1);
  });

  it("оплаченные одновременно подписки продлевают друг друга", async () => {
    const { cookie, user: u } = await user();
    const list = [];
    for (let i = 0; i < 3; i++) list.push((await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1 })).json().order);
    const paid = { status: "paid" as const, raw: {} };
    await warmPool();
    const results = await Promise.all(list.map((o) => applyPayment(t.app.ctx, { ...paid, orderNumber: o.number, amount: o.amount })));
    expect(results).toEqual(["paid", "paid", "paid"]);
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id)).orderBy(subscriptions.startsAt);
    expect(subs).toHaveLength(3);
    expect(subs[1]!.startsAt.getTime()).toBe(subs[0]!.endsAt.getTime());
    expect(subs[2]!.startsAt.getTime()).toBe(subs[1]!.endsAt.getTime());
  });

  it("подписку не продают тем, у кого бесплатный доступ", async () => {
    const free = await user({ freeAccess: true });
    const sub = (cookie: string, lang: string) => req(cookie, "POST", "/api/orders", { kind: "subscription", months: 3 }, { "x-lang": lang });
    const ru = await sub(free.cookie, "ru");
    expect(ru.statusCode).toBe(400);
    expect(ru.json().error).toBe("У вас бесплатный доступ: подписка не нужна");
    expect((await sub(free.cookie, "uz")).json().error).toBe("Sizda bepul foydalanish huquqi bor: obuna kerak emas");
    expect((await sub(free.cookie, "uzc")).json().error).toBe("Сизда бепул фойдаланиш ҳуқуқи бор: обуна керак эмас");
    expect((await sub(free.cookie, "en")).json().error).toBe("You have free access: no subscription needed");
    // Администратору тоже всё бесплатно.
    expect((await sub((await admin()).cookie, "ru")).statusCode).toBe(400);
    expect(await db.select().from(orders).where(eq(orders.userId, free.user.id))).toHaveLength(0);
    // Обычный пользователь подписку оформляет.
    const paying = await user();
    const ok = await sub(paying.cookie, "ru");
    expect(ok.statusCode).toBe(201);
    expect(ok.json().order).toMatchObject({ kind: "subscription", quantity: 3, status: "pending" });
  });
});

describe("тексты SMS", () => {
  it("напоминание короткое, латиница в GSM", () => {
    const link = "https://invito.uz/g/abcdefghijklmnop";
    expect(reminderText("ru", { guestName: "Аня", event: "Свадьба", date: "26.12.2026", link })).toBe(`Аня, напоминаем: Свадьба, 26.12.2026. Ждём ваш ответ: ${link}`);
    const uz = reminderText("uz", { guestName: "G‘ayrat", event: "To‘y", link });
    expect(uz).toBe(`G'ayrat, eslatma: To'y. Javobingizni kutamiz: ${link}`);
    expect(/^[\x20-\x7e]*$/.test(uz)).toBe(true);
    expect(reminderText("en", { guestName: "Ann", event: "Wedding", date: "26.12.2026", link }).length).toBeLessThanOrEqual(160);
    expect(reminderText("uzc", { guestName: "Аня", event: "Тўй", link })).toBe(`Аня, эслатма: Тўй. Жавобингизни кутамиз: ${link}`);
  });
});
