import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guests, invitationEvents, invitations } from "../src/db/schema.js";
import { eventLabel } from "../src/design-data.js";
import { getPublicPage, longDate, SELF_GUESTS_LIMIT } from "../src/services/public.js";
import { APP_URL, samples, testContext } from "./helpers.js";

const t = testContext();
const { db, redis, login, req, pay } = t;

const VIEW_KEYS = ["appUrl", "botUsername", "data", "event", "guestbook", "kind", "language", "slug", "template", "who"];
const BOT_UA = "TelegramBot (like TwitterBot)";
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

let nextUser = 20_000;
const user = () => login(nextUser++);

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ url, headers });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => req(null, "POST", url, payload, headers);

/** Общее приглашение: создано, шаблон оплачен, опубликовано. «Кто придёт» включён, как в данных дизайна по умолчанию. */
async function sharedPublished(data: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) {
  const { cookie } = await user();
  const created = await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", data: { names: "Азиз & Мадина", showGuests: true, ...data } });
  expect(created.statusCode, created.body).toBe(201);
  const inv = created.json();
  await pay(cookie, { kind: "template", invitationId: inv.id });
  if (Object.keys(patch).length) expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, patch)).statusCode).toBe(200);
  expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
  return { cookie, inv };
}

/** Персональное приглашение с гостями и оплаченными местами, опубликованное. */
async function personalPublished(names: string[], seats: number, data: Record<string, unknown> = {}) {
  const { cookie } = await user();
  const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "personal", data: { names: "Той", showGuests: true, ...data } })).json();
  const added = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: names.map((name) => ({ name })) })).json();
  await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: seats });
  expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
  return { cookie, inv, added: added as { id: string; token: string; name: string }[] };
}

const ownerGuests = async (cookie: string, id: string) => (await req(cookie, "GET", `/api/invitations/${id}`)).json().guests as any[];
const activity = async (cookie: string, id: string) => (await req(cookie, "GET", `/api/invitations/${id}/activity`)).json() as any[];

/** Гости, вставленные напрямую в базу, с ответами. Кэш публичных страниц после этого сбрасывается. */
async function insertGuests(invitationId: string, rows: { name: string; rsvp: "yes" | "no" | "maybe" | "pending"; plus?: number; message?: string; at?: number }[]) {
  const [inv] = await db.select().from(invitations).where(eq(invitations.id, invitationId));
  let seat = inv!.nextSeat;
  const values = rows.map((r) => ({
    invitationId,
    name: r.name,
    rsvp: r.rsvp,
    plus: r.plus ?? 0,
    message: r.message ?? null,
    seat: seat++,
    token: randomBytes(12).toString("base64url"),
    source: "self" as const,
    respondedAt: r.rsvp === "pending" ? null : new Date(Date.UTC(2026, 0, 1) + (r.at ?? 0) * 1000),
  }));
  const inserted = await db.insert(guests).values(values).returning();
  await db.update(invitations).set({ nextSeat: seat }).where(eq(invitations.id, invitationId));
  await redis.flushdb();
  return inserted;
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

describe("общая ссылка", () => {
  it("открывается только у опубликованного оплаченного общего приглашения", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", data: { names: "A & B", date: "2026-12-12", showGuests: true } })).json();
    const url = `/api/public/i/${inv.slug}`;
    expect((await get(url)).statusCode).toBe(404);

    await pay(cookie, { kind: "template", invitationId: inv.id });
    expect((await get(url)).statusCode).toBe(404);

    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const view = res.json();
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(view).toMatchObject({
      kind: "shared",
      slug: inv.slug,
      language: "ru",
      template: "wedding-classic",
      event: "wedding",
      data: { names: "A & B", date: "2026-12-12" },
      who: { count: 0, list: [], more: 0 },
      guestbook: [],
      botUsername: "invite_test_bot",
      appUrl: APP_URL,
    });

    // Архив закрывает ссылку сразу.
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    expect((await get(url)).statusCode).toBe(404);
  });

  it("персональное приглашение, чужой и неверный адрес не открываются по общей ссылке", async () => {
    const { inv } = await personalPublished(["Аня"], 1);
    expect((await get(`/api/public/i/${inv.slug}`)).statusCode).toBe(404);
    const missing = await get("/api/public/i/no-such-invitation");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Приглашение не найдено" });
    expect((await get("/api/public/i/a")).statusCode).toBe(400);
    expect((await get("/api/public/g/short")).statusCode).toBe(400);
  });

  it("«кто придёт»: только yes, сокращённые имена, не больше 14, с учётом спутников", async () => {
    const { inv } = await sharedPublished();
    const yes = Array.from({ length: 16 }, (_, i) => ({ name: `Гость${i + 1} Фамилия`, rsvp: "yes" as const, at: i }));
    await insertGuests(inv.id, [
      ...yes,
      { name: "Анна Каримова Отчество", rsvp: "yes", plus: 2, at: 100 },
      { name: "Мадина", rsvp: "maybe", at: 101 },
      { name: "Борис Петров", rsvp: "no", at: 102 },
      { name: "Вика", rsvp: "pending" },
    ]);
    const { who } = (await get(`/api/public/i/${inv.slug}`)).json();
    expect(who.count).toBe(16 + 3);
    expect(who.list).toHaveLength(14);
    expect(who.more).toBe(3);
    // Сначала ответившие раньше.
    expect(who.list[0]).toEqual({ name: "Гость1 Ф.", plus: 0 });
    expect(who.list.map((g: any) => g.name)).not.toContain("Мадина");
  });

  it("«кто придёт» скрывается флагом showGuests и выключенной секцией", async () => {
    const hidden = await sharedPublished({ showGuests: false });
    const v1 = (await get(`/api/public/i/${hidden.inv.slug}`)).json();
    expect(v1).not.toHaveProperty("who");
    expect(v1).toHaveProperty("guestbook");

    // Без явного showGuests имена гостей не показываются (например, у старых приглашений).
    const unset = await sharedPublished({ showGuests: undefined });
    await insertGuests(unset.inv.id, [{ name: "Анна Каримова", rsvp: "yes" }]);
    expect((await get(`/api/public/i/${unset.inv.slug}`)).json()).not.toHaveProperty("who");

    const off = await sharedPublished({ sections: [{ k: "who", on: false }, { k: "guestbook", on: false }] });
    const v2 = (await get(`/api/public/i/${off.inv.slug}`)).json();
    expect(v2).not.toHaveProperty("who");
    expect(v2).not.toHaveProperty("guestbook");

    const on = await sharedPublished({ sections: [{ k: "guestbook", on: true }] });
    const v3 = (await get(`/api/public/i/${on.inv.slug}`)).json();
    expect(v3).not.toHaveProperty("who");
    expect(v3.guestbook).toEqual([]);
  });

  it("гостевая книга: пожелания yes и maybe, новые первыми, не больше 30", async () => {
    const { inv } = await sharedPublished();
    await insertGuests(inv.id, [
      { name: "Анна Каримова", rsvp: "yes", message: "  Поздравляем!  ", at: 1 },
      { name: "Мадина", rsvp: "maybe", message: "Постараюсь прийти", at: 2 },
      { name: "Борис Петров", rsvp: "no", message: "Не смогу", at: 3 },
      { name: "Вика", rsvp: "yes", message: "   ", at: 4 },
      ...Array.from({ length: 35 }, (_, i) => ({ name: `Друг ${i}`, rsvp: "yes" as const, message: `Текст ${i}`, at: 10 + i })),
    ]);
    const { guestbook } = (await get(`/api/public/i/${inv.slug}`)).json();
    expect(guestbook).toHaveLength(30);
    expect(guestbook[0]).toEqual({ name: "Друг 3.", text: "Текст 34" });
    expect(guestbook.map((g: any) => g.text)).not.toContain("Не смогу");

    const few = await sharedPublished();
    await insertGuests(few.inv.id, [
      { name: "Анна Каримова", rsvp: "yes", message: "  Поздравляем!  ", at: 1 },
      { name: "Мадина", rsvp: "maybe", message: "Постараюсь прийти", at: 2 },
      { name: "Борис Петров", rsvp: "no", message: "Не смогу", at: 3 },
      { name: "Вика", rsvp: "yes", message: "   ", at: 4 },
    ]);
    expect((await get(`/api/public/i/${few.inv.slug}`)).json().guestbook).toEqual([
      { name: "Мадина", text: "Постараюсь прийти" },
      { name: "Анна К.", text: "Поздравляем!" },
    ]);
  });
});

describe("пароль общей ссылки", () => {
  it("без пароля отдаёт только внешний вид, неверный пароль отклоняется, верный открывает", async () => {
    const { inv } = await sharedPublished({ font: "Cormorant Garamond", palette: 2, message: "секрет" }, { accessCode: "1234" });
    const url = `/api/public/i/${inv.slug}`;

    const locked = await get(url);
    expect(locked.statusCode).toBe(401);
    expect(locked.headers["cache-control"]).toBe("private, no-store");
    const body = locked.json();
    expect(body).toEqual({ locked: true, look: { template: "wedding-classic", font: expect.any(String), palette: 2, language: "ru" }, error: "Приглашение защищено паролем" });
    expect(locked.body).not.toContain("секрет");
    expect(locked.body).not.toContain("Азиз");

    const wrong = await get(`${url}?code=0000`);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ locked: true, error: "Неверный пароль" });
    expect((await get(`${url}?code=0000`, { "accept-language": "en-US,en;q=0.9" })).json().error).toBe("Wrong password");

    const ok = await get(`${url}?code=1234`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.message).toBe("секрет");
  });

  it("после 10 неверных попыток за минуту отклоняются и верные", async () => {
    const { inv } = await sharedPublished({}, { accessCode: "1234" });
    const url = `/api/public/i/${inv.slug}`;
    // Верные попытки не расходуют лимит.
    for (let i = 0; i < 3; i++) expect((await get(`${url}?code=1234`)).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await get(`${url}?code=wrong${i}`)).statusCode).toBe(401);
    const blocked = await get(`${url}?code=1234`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "Слишком много попыток, попробуйте через минуту" });
    // Ответ по ссылке тоже заблокирован.
    const rsvp = await post(`${url}/rsvp`, { name: "Гость", status: "yes", code: "1234" });
    expect(rsvp.statusCode).toBe(429);

    // Через минуту (здесь: после сброса счётчика) пароль снова принимается.
    await redis.flushdb();
    expect((await get(`${url}?code=1234`)).statusCode).toBe(200);
  });

  it("снятие пароля открывает страницу сразу", async () => {
    const { cookie, inv } = await sharedPublished({}, { accessCode: "1234" });
    expect((await get(`/api/public/i/${inv.slug}`)).statusCode).toBe(401);
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { accessCode: null });
    expect((await get(`/api/public/i/${inv.slug}`)).statusCode).toBe(200);
  });
});

describe("ответ по общей ссылке", () => {
  it("создаёт гостя source=self, а с guestToken обновляет его ответ", async () => {
    const { cookie, inv } = await sharedPublished();
    const url = `/api/public/i/${inv.slug}/rsvp`;

    const first = await post(url, { name: "  Анна Каримова ", status: "yes", count: 3, diet: ["veg", "halal", "veg"], msg: " Будем! " });
    expect(first.statusCode, first.body).toBe(200);
    const { guestToken } = first.json();
    expect(guestToken).toMatch(/^[\w-]{8,64}$/);

    let list = await ownerGuests(cookie, inv.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Анна Каримова", source: "self", rsvp: "yes", plus: 2, diet: ["veg", "halal"], message: "Будем!", seat: 1, token: guestToken });
    expect(list[0].respondedAt).toEqual(expect.any(String));

    const view = (await get(`/api/public/i/${inv.slug}`)).json();
    expect(view.who).toEqual({ count: 3, list: [{ name: "Анна К.", plus: 2 }], more: 0 });
    expect(view.guestbook).toEqual([{ name: "Анна К.", text: "Будем!" }]);

    // Повторный ответ тем же гостем: «нет» обнуляет спутников, гость не дублируется.
    const again = await post(url, { name: "Анна Каримова", status: "no", count: 3, guestToken });
    expect(again.json()).toEqual({ guestToken });
    list = await ownerGuests(cookie, inv.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rsvp: "no", plus: 0, message: "", diet: [] });
    expect((await get(`/api/public/i/${inv.slug}`)).json().who).toEqual({ count: 0, list: [], more: 0 });

    // Чужой или выдуманный токен не трогает существующих гостей, а создаёт нового.
    const other = await post(url, { name: "Борис", status: "maybe", guestToken: "unknown-token-123" });
    expect(other.json().guestToken).not.toBe(guestToken);
    list = await ownerGuests(cookie, inv.id);
    expect(list.map((g) => [g.name, g.seat])).toEqual([
      ["Анна Каримова", 1],
      ["Борис", 2],
    ]);

    const kinds = (await activity(cookie, inv.id)).map((e) => [e.kind, e.guestName]);
    expect(kinds.slice(0, 3)).toEqual([
      ["maybe", "Борис"],
      ["no", "Анна Каримова"],
      ["yes", "Анна Каримова"],
    ]);

    // Личная ссылка гостя, ответившего сам, тоже открывается.
    const personal = (await get(`/api/public/g/${guestToken}`)).json();
    expect(personal).toMatchObject({ kind: "personal", slug: inv.slug, guest: { name: "Анна Каримова", rsvp: "no", count: 1 } });
  });

  it("проверяет данные", async () => {
    const { cookie, inv } = await sharedPublished();
    const url = `/api/public/i/${inv.slug}/rsvp`;
    expect((await post(url, { status: "yes" })).statusCode).toBe(400);
    expect((await post(url, { name: "   ", status: "yes" })).statusCode).toBe(400);
    expect((await post(url, { name: "A", status: "pending" })).statusCode).toBe(400);
    expect((await post(url, { name: "A", status: "yes", count: 9 })).statusCode).toBe(400);
    expect((await post(url, { name: "A", status: "yes", diet: ["meat"] })).statusCode).toBe(400);
    expect((await post(url, { name: "A", status: "yes", msg: "x".repeat(501) })).statusCode).toBe(400);
    expect(await ownerGuests(cookie, inv.id)).toEqual([]);
  });

  it("без Origin своего сайта отклоняется", async () => {
    const { inv } = await sharedPublished();
    const res = await t.app.inject({ method: "POST", url: `/api/public/i/${inv.slug}/rsvp`, payload: { name: "A", status: "yes" } });
    expect(res.statusCode).toBe(403);
  });

  it("с паролем требует code", async () => {
    const { cookie, inv } = await sharedPublished({}, { accessCode: "1234" });
    const url = `/api/public/i/${inv.slug}/rsvp`;
    const none = await post(url, { name: "A", status: "yes" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: "Приглашение защищено паролем" });
    const wrong = await post(url, { name: "A", status: "yes", code: "0000" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "Неверный пароль" });
    expect((await post(url, { name: "A", status: "yes", code: "1234" })).statusCode).toBe(200);
    expect(await ownerGuests(cookie, inv.id)).toHaveLength(1);
  });

  it("неопубликованное приглашение не принимает ответы", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared" })).json();
    const res = await post(`/api/public/i/${inv.slug}/rsvp`, { name: "A", status: "yes" });
    expect(res.statusCode).toBe(404);
  });

  it("не больше 6 ответов в минуту с одного адреса", async () => {
    const { inv } = await sharedPublished();
    const url = `/api/public/i/${inv.slug}/rsvp`;
    for (let i = 0; i < 6; i++) expect((await post(url, { name: `Гость ${i}`, status: "yes" })).statusCode).toBe(200);
    expect((await post(url, { name: "Ещё", status: "yes" })).statusCode).toBe(429);
  });

  it(`не больше ${SELF_GUESTS_LIMIT} гостей, ответивших сами`, async () => {
    const { cookie, inv } = await sharedPublished();
    await insertGuests(
      inv.id,
      Array.from({ length: SELF_GUESTS_LIMIT }, (_, i) => ({ name: `Гость ${i}`, rsvp: "yes" as const })),
    );
    const res = await post(`/api/public/i/${inv.slug}/rsvp`, { name: "Лишний", status: "yes" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Для этого приглашения собрано слишком много ответов" });
    // Номер места не расходуется на отклонённый ответ.
    const [row] = await db.select({ nextSeat: invitations.nextSeat }).from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.nextSeat).toBe(SELF_GUESTS_LIMIT + 1);

    // Прежний гость по-прежнему может изменить ответ.
    const [g] = await db.select().from(guests).where(and(eq(guests.invitationId, inv.id), eq(guests.seat, 1)));
    const update = await post(`/api/public/i/${inv.slug}/rsvp`, { name: g!.name, status: "no", guestToken: g!.token });
    expect(update.statusCode).toBe(200);
    expect((await ownerGuests(cookie, inv.id)).find((x) => x.id === g!.id).rsvp).toBe("no");
  });
});

describe("личная ссылка", () => {
  it("форма гостя, ответ и закрытые неоплаченные места", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня Смирнова", "Боря"], 1);
    const [a, b] = added;
    const res = await get(`/api/public/g/${a!.token}`, { "user-agent": BROWSER_UA });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const view = res.json();
    expect(Object.keys(view).sort()).toEqual([...VIEW_KEYS, "guest"].sort());
    expect(view).toMatchObject({ kind: "personal", slug: inv.slug, data: { names: "Той" } });
    expect(view.guest).toEqual({ name: "Аня Смирнова", token: a!.token, rsvp: "pending", count: 1, diet: [], msg: "", checkedIn: false });

    expect((await get(`/api/public/g/${b!.token}`)).statusCode).toBe(404);
    expect((await post(`/api/public/g/${b!.token}/rsvp`, { status: "yes" })).statusCode).toBe(404);

    const rsvp = await post(`/api/public/g/${a!.token}/rsvp`, { status: "yes", count: 2, diet: ["halal"], msg: "Спасибо!" });
    expect(rsvp.json()).toEqual({ ok: true });
    const after = (await get(`/api/public/g/${a!.token}`)).json();
    expect(after.guest).toMatchObject({ rsvp: "yes", count: 2, diet: ["halal"], msg: "Спасибо!" });
    expect(after.who).toEqual({ count: 2, list: [{ name: "Аня С.", plus: 1 }], more: 0 });

    expect((await post(`/api/public/g/${a!.token}/rsvp`, { status: "maybe", count: 0 })).statusCode).toBe(400);
    const g = (await ownerGuests(cookie, inv.id)).find((x) => x.id === a!.id);
    expect(g).toMatchObject({ rsvp: "yes", plus: 1, message: "Спасибо!", diet: ["halal"] });
    expect(g.respondedAt).toEqual(expect.any(String));

    // Оплата ещё одного места открывает второго гостя.
    await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 1 });
    expect((await get(`/api/public/g/${b!.token}`)).statusCode).toBe(200);
  });

  it("открытие отмечается один раз, сборщики превью не считаются", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня"], 1);
    const token = added[0]!.token;
    const opened = async () => (await activity(cookie, inv.id)).filter((e) => e.kind === "opened");

    expect((await get(`/api/public/g/${token}`, { "user-agent": BOT_UA })).statusCode).toBe(200);
    expect((await get(`/api/public/g/${token}`, { "user-agent": "WhatsApp/2.23.20.0" })).statusCode).toBe(200);
    expect(await opened()).toEqual([]);
    expect((await ownerGuests(cookie, inv.id))[0].openedAt).toBeNull();

    await get(`/api/public/g/${token}`, { "user-agent": BROWSER_UA });
    await get(`/api/public/g/${token}`, { "user-agent": BROWSER_UA });
    const events = await opened();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guestId: added[0]!.id, guestName: "Аня" });
    expect((await ownerGuests(cookie, inv.id))[0].openedAt).toEqual(expect.any(String));
  });

  it("гость видит себя первым в «кто придёт»", async () => {
    const names = Array.from({ length: 16 }, (_, i) => `Гость${i} Ф`);
    const { inv, added } = await personalPublished(names, 16);
    // Ответы пишем в базу напрямую: лимит ответов по ссылке — 10 в минуту.
    for (const [i, g] of added.entries()) {
      await db.update(guests).set({ rsvp: "yes", respondedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }).where(eq(guests.id, g.id));
    }
    await redis.flushdb();
    expect(inv.mode).toBe("personal");
    const last = added.at(-1)!;
    const { who } = (await get(`/api/public/g/${last.token}`)).json();
    expect(who.count).toBe(16);
    expect(who.list).toHaveLength(14);
    expect(who.list[0].name).toBe("Гость15 Ф.");
    expect(who.more).toBe(2);
  });

  it("ответ виден другим гостям сразу (сброс кэша)", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня", "Боря"], 2);
    const [a, b] = added;
    expect((await get(`/api/public/g/${a!.token}`)).json().who.count).toBe(0);
    await post(`/api/public/g/${b!.token}/rsvp`, { status: "yes", count: 3 });
    expect((await get(`/api/public/g/${a!.token}`)).json().who).toEqual({ count: 3, list: [{ name: "Боря", plus: 2 }], more: 0 });

    // Изменения владельца тоже видны сразу.
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { names: "Новые имена" } });
    expect((await get(`/api/public/g/${a!.token}`)).json().data.names).toBe("Новые имена");

    // Удалённый гость теряет ссылку.
    await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${b!.id}`);
    expect((await get(`/api/public/g/${b!.token}`)).statusCode).toBe(404);
    expect((await get(`/api/public/g/${a!.token}`)).json().who.count).toBe(0);
  });
});

describe("getPublicPage: мета-теги", () => {
  const ctx = () => t.app.ctx;

  it("заголовок из имён и даты, описание до 160 символов, абсолютная картинка", async () => {
    const message = `${"Дорогие друзья,\n\n приглашаем   вас ".repeat(10)}конец`;
    const cover = "https://images.unsplash.com/photo-1519741497674-611481863552?w=1600&q=80";
    const { cookie, inv } = await sharedPublished({ date: "2026-12-12", message, cover });

    const page = await getPublicPage(ctx(), { kind: "shared", key: inv.slug });
    expect(page.status).toBe(200);
    if (page.status !== 200) return;
    expect(page.meta.title).toBe(`Азиз & Мадина — ${longDate("2026-12-12", "ru")}`);
    expect(page.meta.title).toContain("2026");
    expect(Array.from(page.meta.description)).toHaveLength(160);
    expect(page.meta.description.endsWith("…")).toBe(true);
    expect(page.meta.description).not.toMatch(/\s{2}|\n/);
    expect(page.meta.image).toBe(cover);
    expect(page.meta.url).toBe(`${APP_URL}/i/${inv.slug}`);
    expect(page.view.kind).toBe("shared");

    // Своя OG-картинка важнее обложки и отдаётся абсолютным адресом.
    const og = await req(cookie, "PUT", `/api/invitations/${inv.id}/og`, samples.png, { "content-type": "image/png" });
    expect(og.statusCode, og.body).toBe(200);
    const withOg = await getPublicPage(ctx(), { kind: "shared", key: inv.slug });
    expect(withOg.meta.image).toBe(`${APP_URL}${og.json().ogImageUrl}`);
  });

  it("без имён и даты заголовок по событию, короткое описание без многоточия", async () => {
    const { inv } = await sharedPublished({ names: "", message: "Ждём вас" });
    const page = await getPublicPage(ctx(), { kind: "shared", key: inv.slug });
    expect(page.meta).toEqual({ title: eventLabel("wedding", "ru"), description: "Ждём вас", image: null, url: `${APP_URL}/i/${inv.slug}` });
  });

  it("закрытая паролем и несуществующая страницы не раскрывают содержимое", async () => {
    const { inv } = await sharedPublished({ message: "секрет", cover: "https://images.unsplash.com/photo-1?w=1" }, { accessCode: "1234" });
    const locked = await getPublicPage(ctx(), { kind: "shared", key: inv.slug });
    expect(locked.status).toBe(401);
    expect(locked.meta).toEqual({ title: eventLabel("wedding", "ru"), description: "", image: null, url: `${APP_URL}/i/${inv.slug}` });
    if (locked.status === 401) expect(locked.locked.look).toMatchObject({ template: "wedding-classic", palette: 0 });
    expect(JSON.stringify(locked)).not.toContain("секрет");

    const open = await getPublicPage(ctx(), { kind: "shared", key: inv.slug, code: "1234", ip: "10.0.0.1" });
    expect(open.status).toBe(200);
    const wrong = await getPublicPage(ctx(), { kind: "shared", key: inv.slug, code: "1", ip: "10.0.0.1" });
    expect(wrong.status).toBe(401);

    const missing = await getPublicPage(ctx(), { kind: "shared", key: "nothing-here" });
    expect(missing).toEqual({ status: 404, meta: { title: "Invito", description: "", image: null, url: `${APP_URL}/i/nothing-here` } });
    const badToken = await getPublicPage(ctx(), { kind: "personal", key: "../../etc" });
    expect(badToken.status).toBe(404);
  });

  it("личная ссылка: адрес гостя, открытие только не от сборщика превью", async () => {
    const { cookie, inv, added } = await personalPublished(["Аня"], 1, { names: "Азиз & Мадина", date: "2026-05-01" });
    const token = added[0]!.token;
    const preview = await getPublicPage(ctx(), { kind: "personal", key: token, userAgent: BOT_UA });
    expect(preview.status).toBe(200);
    expect(preview.meta).toMatchObject({ title: `Азиз & Мадина — ${longDate("2026-05-01", "ru")}`, url: `${APP_URL}/g/${token}` });
    expect((await db.select().from(invitationEvents).where(eq(invitationEvents.invitationId, inv.id))).map((e) => e.kind)).not.toContain("opened");

    await getPublicPage(ctx(), { kind: "personal", key: token });
    expect((await activity(cookie, inv.id)).filter((e) => e.kind === "opened")).toHaveLength(1);
  });
});
