import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { attachPhoneToTelegramUser } from "../src/services/phone.js";
import { upsertTelegramUser } from "../src/services/users.js";
import { sessionCookie, testContext } from "./helpers.js";
import { signInitData } from "./telegram.test.js";

/** Профиль: имя и фамилия (PATCH /api/auth/me), Telegram их не перезаписывает, ссылка входа для другого браузера. */
const t = testContext();
const { db, redis, cache, config, login, req } = t;

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

const row = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;

describe("имя в профиле", () => {
  it("PATCH /me сохраняет имя и фамилию, пустая фамилия стирается, в ответе — сохранённое", async () => {
    const { user, cookie } = await login(3100, { firstName: null, lastName: null });
    const r = await req(cookie, "PATCH", "/api/auth/me", { firstName: "  Abdurahmon ", lastName: " Karimov  " });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, firstName: "Abdurahmon", lastName: "Karimov" });
    expect((await req(cookie, "GET", "/api/auth/me")).json().user).toMatchObject({ firstName: "Abdurahmon", lastName: "Karimov" });
    expect((await row(user.id)).nameEdited).toBe(true);
    // Фамилия необязательна: "" и null её стирают; имя остаётся.
    expect((await req(cookie, "PATCH", "/api/auth/me", { lastName: "" })).json()).toEqual({ ok: true, firstName: "Abdurahmon", lastName: null });
    await req(cookie, "PATCH", "/api/auth/me", { lastName: "Karimov" });
    expect((await req(cookie, "PATCH", "/api/auth/me", { firstName: "Abdu", lastName: null })).json()).toEqual({ ok: true, firstName: "Abdu", lastName: null });
    // Язык по-прежнему отдельно и вместе с именем.
    expect((await req(cookie, "PATCH", "/api/auth/me", { locale: "uz" })).json()).toEqual({ ok: true, locale: "uz" });
    expect((await req(cookie, "PATCH", "/api/auth/me", { locale: "ru", firstName: "Abdurahmon" })).json()).toEqual({ ok: true, locale: "ru", firstName: "Abdurahmon", lastName: null });
  });

  it("неверное имя — 400 с понятным текстом на языке запроса, ничего не меняется", async () => {
    const { user, cookie } = await login(3101, { firstName: "Ali", lastName: null });
    const bad = async (body: unknown, lang = "ru") => {
      const r = await req(cookie, "PATCH", "/api/auth/me", body, { "x-lang": lang });
      expect(r.statusCode).toBe(400);
      return r.json().error as string;
    };
    expect(await bad({ firstName: "   " })).toBe("Введите имя");
    expect(await bad({ firstName: "   " }, "uz")).toBe("Ismingizni kiriting");
    expect(await bad({ firstName: "x".repeat(65) })).toBe("Имя и фамилия: до 64 символов, без переносов строк");
    expect(await bad({ firstName: "Ali\nVali" }, "en")).toBe("First and last name: up to 64 characters, no line breaks");
    expect(await bad({ lastName: "a\u0000b" })).toBe("Имя и фамилия: до 64 символов, без переносов строк");
    expect(await bad({ firstName: 5 })).toBe("Неверные данные");
    // Пустое тело и только неизвестные поля — тоже 400, а не «успех без изменений».
    expect(await bad({})).toBe("Неверные данные");
    expect(await bad({ first_name: "Ali" })).toBe("Неверные данные");
    expect(await row(user.id)).toMatchObject({ firstName: "Ali", nameEdited: false });
    // Фамилия без имени у аккаунта без имени (вход по SMS): имя нужно ввести.
    const { cookie: sms } = await login(3102, { firstName: null });
    expect((await req(sms, "PATCH", "/api/auth/me", { lastName: "Karimov" })).json().error).toBe("Введите имя");
    expect((await req(null, "PATCH", "/api/auth/me", { firstName: "X" })).statusCode).toBe(401);
  });

  it("Telegram (бот и мини-апп) не перезаписывает имя, изменённое в профиле; неизменённое — обновляет", async () => {
    const { user, cookie } = await login(3103, { firstName: "Old", lastName: "Name", username: "old" });
    // Пока имя не меняли, данные Telegram его обновляют.
    await upsertTelegramUser(t.app.ctx, { id: 3103, first_name: "Tg", last_name: "Last", username: "tg3103" });
    expect(await row(user.id)).toMatchObject({ firstName: "Tg", lastName: "Last", username: "tg3103" });
    await req(cookie, "PATCH", "/api/auth/me", { firstName: "Мадина", lastName: null });
    // Обновление от бота: имя и стёртая фамилия остаются, username обновляется.
    await upsertTelegramUser(t.app.ctx, { id: 3103, first_name: "Tg", last_name: "Last", username: "tg_new" });
    expect(await row(user.id)).toMatchObject({ firstName: "Мадина", lastName: null, username: "tg_new" });
    // Вход из мини-аппа (POST /webapp) — тот же путь.
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 3103, first_name: "Other", last_name: "Person" }) });
    const ok = await req(null, "POST", "/api/auth/webapp", { initData });
    expect(ok.json().status).toBe("ok");
    expect((await req(sessionCookie(ok), "GET", "/api/auth/me")).json().user).toMatchObject({ firstName: "Мадина", lastName: null });
  });

  it("объединение с аккаунтом по номеру сохраняет имя, изменённое в профиле этого аккаунта", async () => {
    const [phoneUser] = await db.insert(users).values({ phone: "998977773101", firstName: "Zarina", lastName: null, nameEdited: true }).returning();
    const [tgUser] = await db.insert(users).values({ telegramId: 3104, firstName: "Tg", lastName: "Surname" }).returning();
    const merged = await attachPhoneToTelegramUser({ db, cache, config }, tgUser!, "998977773101");
    expect(merged).toMatchObject({ id: phoneUser!.id, telegramId: 3104, firstName: "Zarina", lastName: null, nameEdited: true });
    // Без правки в профиле пустые поля по-прежнему берутся из Telegram.
    const [plain] = await db.insert(users).values({ phone: "998977773102" }).returning();
    const [tg2] = await db.insert(users).values({ telegramId: 3105, firstName: "Bek", lastName: "Aliyev" }).returning();
    expect(await attachPhoneToTelegramUser({ db, cache, config }, tg2!, "998977773102")).toMatchObject({ id: plain!.id, firstName: "Bek", lastName: "Aliyev", nameEdited: false });
  });
});

describe("ссылка входа для другого браузера (POST /handoff)", () => {
  it("одноразовая ссылка /link для этой сессии: вход в том браузере, повтор не работает", async () => {
    expect((await req(null, "POST", "/api/auth/handoff", {})).statusCode).toBe(401);
    const { user, cookie } = await login(3106);
    const r = await req(cookie, "POST", "/api/auth/handoff", {});
    expect(r.statusCode).toBe(200);
    const url = new URL(r.json().url);
    expect(url.origin + url.pathname).toBe(config.APP_URL + "/api/auth/link");
    const open = await t.app.inject({ url: url.pathname + url.search });
    expect(open.statusCode).toBe(302);
    expect(open.headers.location).toBe("/app/");
    expect((await req(sessionCookie(open), "GET", "/api/auth/me")).json().user.id).toBe(user.id);
    // Второй раз ссылка не входит.
    expect((await t.app.inject({ url: url.pathname + url.search })).headers.location).toBe("/app/#/login-expired");
    // Админ попадает в админку.
    const { cookie: adm } = await login(1);
    const a = new URL((await req(adm, "POST", "/api/auth/handoff", {})).json().url);
    expect((await t.app.inject({ url: a.pathname + a.search })).headers.location).toBe("/admin/");
  });
});

describe("история платежей (GET /api/orders)", () => {
  it("только свои заказы, новые сверху, без meta", async () => {
    const { cookie: a } = await login(3107);
    const { cookie: b } = await login(3108);
    const first = (await req(a, "POST", "/api/orders", { kind: "subscription", months: 1 })).json().order;
    const second = (await req(a, "POST", "/api/orders", { kind: "subscription", months: 3 })).json().order;
    await req(b, "POST", "/api/orders", { kind: "subscription", months: 1 });
    const list = (await req(a, "GET", "/api/orders")).json();
    expect(list.map((o: { id: string }) => o.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({ kind: "subscription", quantity: 3, status: "pending", currency: "UZS" });
    expect(list[0]).not.toHaveProperty("meta");
    expect((await req(null, "GET", "/api/orders")).statusCode).toBe(401);
  });
});
