import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guests, invitations, orders, templates } from "../src/db/schema.js";
import { seed } from "../src/db/seed.js";
import { defaultPrices } from "../src/pricing.js";
import { APP_URL, samples, testContext } from "./helpers.js";

const t = testContext();
const { db, redis, login, req, pay } = t;

const INVITATION_KEYS = [
  "accessCode",
  "createdAt",
  "data",
  "event",
  "id",
  "language",
  "links",
  "mode",
  "ogImageUrl",
  "paidSeats",
  "publishedAt",
  "settings",
  "slug",
  "stats",
  "status",
  "template",
  "title",
  "unlocked",
  "updatedAt",
];
const GUEST_KEYS = [
  "checkedIn",
  "checkedInAt",
  "diet",
  "group",
  "id",
  "link",
  "message",
  // Гость сам разрешил показать сообщение в гостевой книге (GuestDto.messagePublic).
  "messagePublic",
  "name",
  "openedAt",
  "paid",
  "phone",
  "plus",
  "respondedAt",
  "rsvp",
  "seat",
  "sms",
  "source",
  "tableNo",
  "telegramLinked",
  "token",
];

let nextUser = 10_000;
/** Новый пользователь на каждый тест, чтобы данные тестов не пересекались. */
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);

async function create(cookie: string, body: Record<string, unknown> = {}) {
  const res = await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function personalWithGuests(cookie: string, names: string[], seats: number) {
  const inv = await create(cookie, { mode: "personal", data: { names: "Той" } });
  const added = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: names.map((name) => ({ name })) })).json();
  if (seats) await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: seats });
  return { inv, added };
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

describe("каталог шаблонов", () => {
  it("отдаёт 60 активных шаблонов Invito в порядке дизайна", async () => {
    const list = (await t.app.inject({ url: "/api/templates" })).json();
    expect(list).toHaveLength(60);
    expect(Object.keys(list[0]).sort()).toEqual(["event", "id", "price", "slug", "smsEnabled", "style", "title"]);
    expect(list[0]).toMatchObject({ slug: "wedding-classic", event: "wedding", style: "classic", title: "Ivory", price: null, smsEnabled: false });
    expect(list[5].slug).toBe("engagement-classic");
    expect(list.at(-1).slug).toBe("iftar-cinema");
  });

  it("сид идемпотентный: не трогает цены и флаги и выключает invite-cover", async () => {
    await db.insert(templates).values({ slug: "invite-cover", title: "Обложка приглашения" });
    await db.update(templates).set({ price: 777, smsEnabled: true, isActive: false, title: "Старое" }).where(eq(templates.slug, "party-neon"));
    await seed(db);
    await seed(db);
    const rows = await db.select().from(templates);
    expect(rows).toHaveLength(61);
    const neon = rows.find((r) => r.slug === "party-neon")!;
    expect(neon).toMatchObject({ price: 777, smsEnabled: true, isActive: false, title: "Voltage", event: "party", style: "neon" });
    expect(rows.find((r) => r.slug === "invite-cover")!.isActive).toBe(false);
    await redis.flushdb();
    const list = (await t.app.inject({ url: "/api/templates" })).json();
    expect(list.map((x: { slug: string }) => x.slug)).not.toContain("invite-cover");
    expect(list.map((x: { slug: string }) => x.slug)).not.toContain("party-neon");
    await db.update(templates).set({ isActive: true, price: null, smsEnabled: false }).where(eq(templates.slug, "party-neon"));
  });
});

describe("конфигурация и профиль", () => {
  it("GET /api/auth/config", async () => {
    const res = (await t.app.inject({ url: "/api/auth/config" })).json();
    expect(res).toEqual({ telegram: true, botUsername: "invite_test_bot", appUrl: APP_URL, prices: defaultPrices, currency: "UZS", ai: false });
  });

  it("GET /api/auth/me и язык uzc", async () => {
    const { cookie, user: u } = await user({ firstName: "Анна", lastName: "К" });
    const me = (await req(cookie, "GET", "/api/auth/me")).json();
    expect(me).toEqual({
      user: {
        id: u.id,
        phone: u.phone,
        firstName: "Анна",
        lastName: "К",
        username: null,
        telegramId: String(u.telegramId),
        locale: "ru",
        isAdmin: false,
        freeAccess: false,
      },
      access: { free: false, subscribed: false, subscriptionEndsAt: null },
      prices: defaultPrices,
      currency: "UZS",
    });
    expect((await req(cookie, "PATCH", "/api/auth/me", { locale: "uzc" })).json()).toEqual({ ok: true, locale: "uzc" });
    expect((await req(cookie, "GET", "/api/auth/me")).json().user.locale).toBe("uzc");
    // Язык ошибок по заголовку.
    const err = await req(cookie, "GET", "/api/invitations/00000000-0000-4000-8000-000000000000", undefined, { "x-lang": "uzc" });
    expect(err.json().error).toBe("Таклифнома топилмади");
  });

  it("подписка видна в access.subscriptionEndsAt", async () => {
    const { cookie } = await user();
    await pay(cookie, { kind: "subscription", months: 1 });
    const me = (await req(cookie, "GET", "/api/auth/me")).json();
    expect(me.access.subscribed).toBe(true);
    expect(new Date(me.access.subscriptionEndsAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("создание и чтение приглашений", () => {
  it("создаёт черновик с заголовком из data.names и событием created", async () => {
    const { cookie } = await user({ locale: "uz" });
    const inv = await create(cookie, { data: { names: "  Anna va Temur ", font: "Unbounded", extra: 1 } });
    expect(Object.keys(inv).sort()).toEqual(INVITATION_KEYS);
    expect(inv).toMatchObject({
      mode: "shared",
      status: "draft",
      language: "uz",
      template: "wedding-classic",
      event: "wedding",
      title: "Anna va Temur",
      unlocked: false,
      paidSeats: 0,
      accessCode: null,
      ogImageUrl: null,
      publishedAt: null,
      settings: { r1d: true, r3h: true, morning: true, notify: true, tables: 4 },
      stats: { guests: 0, yes: 0, no: 0, maybe: 0, pending: 0, replies: 0, people: 0 },
    });
    // Шрифта Unbounded нет у стиля classic: подставлен первый шрифт стиля.
    expect(inv.data).toEqual({ names: "  Anna va Temur ", font: "Cormorant Garamond" });
    expect(inv.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(inv.links.shared).toBe(`${APP_URL}/i/${inv.slug}`);

    const personal = await create(cookie, { mode: "personal", language: "uzc", data: {} });
    expect(personal.links.shared).toBeNull();
    expect(personal.language).toBe("uzc");
    // Без имён заголовок — название события на языке приглашения.
    expect(personal.title).toBe("Тўй");

    const activity = (await req(cookie, "GET", `/api/invitations/${inv.id}/activity`)).json();
    expect(activity).toEqual([{ id: expect.any(String), kind: "created", guestId: null, guestName: null, meta: {}, createdAt: expect.any(String) }]);
  });

  it("проверяет шаблон и содержимое", async () => {
    const { cookie } = await user();
    expect((await req(cookie, "POST", "/api/invitations", { template: "nope" })).statusCode).toBe(404);
    await db.insert(templates).values({ slug: "old-inactive", title: "Old", isActive: false });
    expect((await req(cookie, "POST", "/api/invitations", { template: "old-inactive" })).statusCode).toBe(404);
    const bad = await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover: "data:image/png;base64,AAAA" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toEqual(["cover"]);
    expect((await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "group" })).statusCode).toBe(400);
    expect((await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", language: "de" })).statusCode).toBe(400);
    expect((await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: "строка" })).statusCode).toBe(400);
  });

  it("список без архивных, последние изменённые первыми, со статистикой", async () => {
    const { cookie } = await user();
    const a = await create(cookie, { data: { names: "A" } });
    const b = await create(cookie, { data: { names: "B" } });
    const { inv: c } = await personalWithGuests(cookie, ["Аня", "Боря"], 1);
    await req(cookie, "PATCH", `/api/invitations/${a.id}`, { data: { message: "обновлено" } });
    await req(cookie, "POST", `/api/invitations/${c.id}/publish`);
    await req(cookie, "DELETE", `/api/invitations/${c.id}`);
    const list = (await req(cookie, "GET", "/api/invitations")).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);

    const { inv: d, added } = await personalWithGuests(cookie, ["Аня", "Боря", "Вика"], 3);
    await req(cookie, "POST", `/api/invitations/${d.id}/publish`);
    await t.app.inject({ method: "POST", url: `/api/public/g/${added[0].token}/rsvp`, payload: { status: "yes", count: 3 }, headers: { origin: APP_URL } });
    await t.app.inject({ method: "POST", url: `/api/public/g/${added[1].token}/rsvp`, payload: { status: "no", count: 2 }, headers: { origin: APP_URL } });
    const first = (await req(cookie, "GET", "/api/invitations")).json()[0];
    expect(first.id).toBe(d.id);
    expect(first.stats).toEqual({ guests: 3, yes: 1, no: 1, maybe: 0, pending: 1, replies: 2, people: 3 });
  });

  it("чужие приглашения недоступны", async () => {
    const a = await user();
    const b = await user();
    const { inv, added } = await personalWithGuests(a.cookie, ["Аня"], 0);
    const base = `/api/invitations/${inv.id}`;
    const attempts: [Parameters<typeof req>[1], string, unknown?][] = [
      ["GET", base],
      ["PATCH", base, { data: { names: "x" } }],
      ["DELETE", base],
      ["POST", `${base}/duplicate`],
      ["POST", `${base}/publish`],
      ["GET", `${base}/activity`],
      ["POST", `${base}/checkin`, { token: added[0].token }],
      ["POST", `${base}/guests`, { guests: [{ name: "x" }] }],
      ["PATCH", `${base}/guests/${added[0].id}`, { name: "x" }],
      ["DELETE", `${base}/guests/${added[0].id}`],
    ];
    for (const [method, url, body] of attempts) expect((await req(b.cookie, method, url, body)).statusCode, `${method} ${url}`).toBe(404);
    const og = await t.app.inject({ method: "PUT", url: `${base}/og`, payload: samples.png, headers: { cookie: b.cookie, origin: APP_URL, "content-type": "image/png" } });
    expect(og.statusCode).toBe(404);
    expect((await req(a.cookie, "GET", base)).json().guests).toHaveLength(1);
  });
});

describe("изменение приглашения", () => {
  it("data сливается по ключам, заголовок следует за именами", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { data: { names: "Анна и Тимур", message: "Ждём" } });
    const r1 = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { message: "Ждём вас" } })).json();
    expect(r1.data).toEqual({ names: "Анна и Тимур", message: "Ждём вас" });
    const r2 = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { names: "Анна и Тимур Каримовы" }, language: "en" })).json();
    expect(r2).toMatchObject({ title: "Анна и Тимур Каримовы", language: "en" });
    const bad = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { gallery: ["https://evil.example/x.jpg"] } });
    expect(bad.statusCode).toBe(400);
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().data.gallery).toBeUndefined();
    // null удаляет ключ.
    const r3 = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { message: null, date: "2026-12-12" } })).json();
    expect(r3.data).toEqual({ names: "Анна и Тимур Каримовы", date: "2026-12-12" });
  });

  it("смена шаблона заново проверяет шрифт", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { data: { font: "Prata" } });
    const r = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "party-neon" })).json();
    expect(r).toMatchObject({ template: "party-neon", event: "party", data: { font: "Unbounded" } });
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "nope" })).statusCode).toBe(404);
  });

  it("после оплаты шаблон меняется только на равный или дешевле", async () => {
    await db.update(templates).set({ price: 100_000_00 }).where(eq(templates.slug, "wedding-luxe"));
    await db.update(templates).set({ price: 10_000_00 }).where(eq(templates.slug, "wedding-boho"));
    const { cookie } = await user();
    const inv = await create(cookie);
    // До оплаты можно любой.
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-luxe" })).statusCode).toBe(200);
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-classic" })).statusCode).toBe(200);
    await pay(cookie, { kind: "template", invitationId: inv.id });
    const pricier = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-luxe" }, { "x-lang": "en" });
    expect(pricier.statusCode).toBe(402);
    expect(pricier.json().error).toBe("This template costs more than the one you paid for");
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-botanical" })).statusCode).toBe(200);
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-boho" })).statusCode).toBe(200);

    // С бесплатным доступом можно на любой.
    const free = await user({ freeAccess: true });
    const inv2 = await create(free.cookie);
    await pay(free.cookie, { kind: "template", invitationId: inv2.id });
    expect((await req(free.cookie, "PATCH", `/api/invitations/${inv2.id}`, { template: "wedding-luxe" })).statusCode).toBe(200);
    await db.update(templates).set({ price: null }).where(sql`slug in ('wedding-luxe', 'wedding-boho')`);
  });

  it("режим меняется только у неоплаченного черновика", async () => {
    const { cookie } = await user();
    const inv = await create(cookie);
    const r = (await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "personal" })).json();
    expect(r).toMatchObject({ mode: "personal", links: { shared: null } });
    await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 1 });
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "shared" })).statusCode).toBe(409);
    // Тот же режим — не изменение.
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { mode: "personal" })).statusCode).toBe(200);

    const free = await user({ freeAccess: true });
    const inv2 = await create(free.cookie);
    await pay(free.cookie, { kind: "template", invitationId: inv2.id });
    expect((await req(free.cookie, "PATCH", `/api/invitations/${inv2.id}`, { mode: "personal" })).statusCode).toBe(409);
  });

  it("ссылка: формат, зарезервированные слова и занятость", async () => {
    const a = await user();
    const b = await user();
    const inv = await create(a.cookie);
    const other = await create(b.cookie);
    for (const slug of ["ab", "-abc", "abc-", "Abc", "a_b_c", "a".repeat(41), "анна"]) {
      expect((await req(a.cookie, "PATCH", `/api/invitations/${inv.id}`, { slug })).statusCode, slug).toBe(400);
    }
    for (const slug of ["app", "admin", "api", "media", "health", "telegram", "static", "vendor"]) {
      expect((await req(a.cookie, "PATCH", `/api/invitations/${inv.id}`, { slug })).statusCode, slug).toBe(400);
    }
    const ok = (await req(a.cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "anna-i-timur" })).json();
    expect(ok).toMatchObject({ slug: "anna-i-timur", links: { shared: `${APP_URL}/i/anna-i-timur` } });
    // Своя же ссылка повторно — не конфликт.
    expect((await req(a.cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "anna-i-timur" })).statusCode).toBe(200);
    const taken = await req(b.cookie, "PATCH", `/api/invitations/${other.id}`, { slug: "anna-i-timur" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("Эта ссылка уже занята");
  });

  it("новая ссылка сразу работает, старая перестаёт", async () => {
    const { cookie } = await user({ freeAccess: true });
    const inv = await create(cookie, { data: { names: "Гости" } });
    await pay(cookie, { kind: "template", invitationId: inv.id });
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    expect((await t.app.inject({ url: `/api/public/i/${inv.slug}` })).statusCode).toBe(200);
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { slug: "new-slug-1" });
    expect((await t.app.inject({ url: `/api/public/i/${inv.slug}` })).statusCode).toBe(404);
    expect((await t.app.inject({ url: "/api/public/i/new-slug-1" })).statusCode).toBe(200);
  });

  it("пароль, настройки и столы", async () => {
    const { cookie } = await user();
    const { inv, added } = await personalWithGuests(cookie, ["Аня", "Боря"], 0);
    const url = `/api/invitations/${inv.id}`;
    expect((await req(cookie, "PATCH", url, { accessCode: "2026" })).json().accessCode).toBe("2026");
    expect((await req(cookie, "PATCH", url, { accessCode: "" })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", url, { accessCode: "x".repeat(65) })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", url, { accessCode: null })).json().accessCode).toBeNull();

    const s = (await req(cookie, "PATCH", url, { settings: { notify: false, tables: 6 } })).json();
    expect(s.settings).toEqual({ r1d: true, r3h: true, morning: true, notify: false, tables: 6 });
    expect((await req(cookie, "PATCH", url, { settings: { tables: 31 } })).statusCode).toBe(400);
    expect((await req(cookie, "PATCH", url, { settings: { tables: 0 } })).statusCode).toBe(400);

    await req(cookie, "PATCH", `${url}/guests/${added[0].id}`, { tableNo: 6 });
    await req(cookie, "PATCH", `${url}/guests/${added[1].id}`, { tableNo: 2 });
    await req(cookie, "PATCH", url, { settings: { tables: 3 } });
    const detail = (await req(cookie, "GET", url)).json();
    expect(detail.settings.tables).toBe(3);
    expect(detail.guests.map((g: { tableNo: number }) => g.tableNo)).toEqual([0, 2]);
  });
});

describe("удаление, копия и публикация", () => {
  it("черновик удаляется, оплаченное и опубликованное уходит в архив", async () => {
    const { cookie } = await user({ freeAccess: true });
    const draft = await create(cookie);
    expect((await req(cookie, "DELETE", `/api/invitations/${draft.id}`)).statusCode).toBe(204);
    expect((await req(cookie, "GET", `/api/invitations/${draft.id}`)).statusCode).toBe(404);

    const paid = await create(cookie, { data: { names: "Опубликовано" } });
    await pay(cookie, { kind: "template", invitationId: paid.id });
    await req(cookie, "POST", `/api/invitations/${paid.id}/publish`);
    expect((await t.app.inject({ url: `/api/public/i/${paid.slug}` })).statusCode).toBe(200);
    expect((await req(cookie, "DELETE", `/api/invitations/${paid.id}`)).statusCode).toBe(204);
    expect((await req(cookie, "GET", `/api/invitations/${paid.id}`)).json().status).toBe("archived");
    expect((await t.app.inject({ url: `/api/public/i/${paid.slug}` })).statusCode).toBe(404);
  });

  it("черновик с начатой оплатой не удаляется насовсем", async () => {
    const { cookie } = await user();
    const inv = await create(cookie);
    const order = (await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id })).json();
    expect(order.status).toBe("pending");
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().status).toBe("archived");
    // Оплата после удаления не теряется.
    await t.callback(order.order.number, order.order.amount);
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().unlocked).toBe(true);
  });

  it("копия: новый черновик без ссылки, оплат, гостей и пароля", async () => {
    const { cookie } = await user({ freeAccess: true });
    const { inv } = await personalWithGuests(cookie, ["Аня"], 2);
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { accessCode: "secret", language: "en", data: { message: "Hi" }, template: "party-riso" });
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    const res = await req(cookie, "POST", `/api/invitations/${inv.id}/duplicate`);
    expect(res.statusCode).toBe(201);
    const copy = res.json();
    expect(copy).toMatchObject({
      mode: "personal",
      status: "draft",
      language: "en",
      template: "party-riso",
      data: { names: "Той", message: "Hi" },
      unlocked: false,
      paidSeats: 0,
      accessCode: null,
      publishedAt: null,
    });
    expect(copy.id).not.toBe(inv.id);
    expect(copy.slug).not.toBe(inv.slug);
    expect((await req(cookie, "GET", `/api/invitations/${copy.id}`)).json().guests).toEqual([]);
    const act = (await req(cookie, "GET", `/api/invitations/${copy.id}/activity`)).json();
    expect(act.map((a: { kind: string }) => a.kind)).toEqual(["created"]);
  });

  it("публикация требует оплаты и пишет событие один раз", async () => {
    const { cookie } = await user();
    const shared = await create(cookie);
    const r402 = await req(cookie, "POST", `/api/invitations/${shared.id}/publish`);
    expect(r402.statusCode).toBe(402);
    expect(r402.json().error).toBe("Сначала оплатите шаблон или оформите подписку");
    const { inv: personal } = await personalWithGuests(cookie, ["Аня"], 0);
    expect((await req(cookie, "POST", `/api/invitations/${personal.id}/publish`)).statusCode).toBe(402);

    await pay(cookie, { kind: "template", invitationId: shared.id });
    const p1 = (await req(cookie, "POST", `/api/invitations/${shared.id}/publish`)).json();
    expect(p1.status).toBe("active");
    expect(p1.publishedAt).toEqual(expect.any(String));
    const p2 = (await req(cookie, "POST", `/api/invitations/${shared.id}/publish`)).json();
    expect(p2.publishedAt).toBe(p1.publishedAt);
    const kinds = (await req(cookie, "GET", `/api/invitations/${shared.id}/activity`)).json().map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(["published", "paid", "created"]);
    const paid = (await req(cookie, "GET", `/api/invitations/${shared.id}/activity?limit=2`)).json()[1];
    expect(paid.meta).toMatchObject({ kind: "template", amount: defaultPrices.sharedTemplate, quantity: 1 });
    expect((await req(cookie, "GET", `/api/invitations/${shared.id}/activity?limit=500`)).statusCode).toBe(400);
  });
});

describe("OG-картинка", () => {
  const put = (cookie: string, id: string, body: Buffer, type = "image/png") =>
    t.app.inject({ method: "PUT", url: `/api/invitations/${id}/og`, payload: body, headers: { cookie, origin: APP_URL, "content-type": type } });

  it("принимает PNG и JPEG до 3 МБ и заменяет прежнюю", async () => {
    const { cookie } = await user();
    const inv = await create(cookie);
    const r1 = await put(cookie, inv.id, samples.png);
    expect(r1.statusCode).toBe(200);
    const { ogImageUrl } = r1.json();
    expect(ogImageUrl).toMatch(/^\/media\/[0-9a-f-]{36}\.png$/);
    const file = await t.app.inject({ url: ogImageUrl });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.rawPayload.equals(samples.png)).toBe(true);
    expect((await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().ogImageUrl).toBe(ogImageUrl);

    const r2 = (await put(cookie, inv.id, samples.jpeg, "image/jpeg")).json();
    expect(r2.ogImageUrl).toMatch(/\.jpg$/);
    expect((await t.app.inject({ url: ogImageUrl })).statusCode).toBe(404);
    expect(existsSync(join(t.mediaDir, ogImageUrl.slice("/media/".length)))).toBe(false);
  });

  it("отклоняет другие типы и большие файлы", async () => {
    const { cookie } = await user();
    const inv = await create(cookie);
    // Сигнатура важнее заголовка: GIF под видом PNG не проходит.
    expect((await put(cookie, inv.id, samples.gif)).statusCode).toBe(415);
    expect((await put(cookie, inv.id, samples.gif, "image/gif")).statusCode).toBe(415);
    expect((await put(cookie, inv.id, samples.svg, "text/plain")).statusCode).toBe(415);
    const big = Buffer.concat([samples.png, Buffer.alloc(3 * 1024 * 1024)]);
    const r = await t.app.inject({
      method: "PUT",
      url: `/api/invitations/${inv.id}/og`,
      payload: big,
      headers: { cookie, origin: APP_URL, "content-type": "image/png", "x-lang": "en" },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe("The file is too large");
  });
});

describe("гости и места", () => {
  it("гости добавляются только в персональное приглашение", async () => {
    const { cookie } = await user();
    const inv = await create(cookie);
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Аня" }] })).statusCode).toBe(400);
  });

  it("форма гостя и оплаченность по порядку мест", async () => {
    const { cookie } = await user();
    const inv = await create(cookie, { mode: "personal" });
    const res = await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, {
      guests: [{ name: "Анна Каримова", phone: "+998 90 111-22-33", group: "family", plus: 1 }, { name: "Боря" }, { name: "Вика" }],
    });
    expect(res.statusCode).toBe(201);
    const added = res.json();
    expect(Object.keys(added[0]).sort()).toEqual(GUEST_KEYS);
    expect(added[0]).toMatchObject({
      name: "Анна Каримова",
      phone: "998901112233",
      seat: 1,
      link: `${APP_URL}/g/${added[0].token}`,
      rsvp: "pending",
      plus: 1,
      group: "family",
      tableNo: 0,
      checkedIn: false,
      checkedInAt: null,
      message: "",
      messagePublic: false,
      diet: [],
      source: "owner",
      openedAt: null,
      respondedAt: null,
      telegramLinked: false,
      paid: false,
      sms: null,
    });
    expect(added.map((g: { seat: number }) => g.seat)).toEqual([1, 2, 3]);
    expect(added[1]).toMatchObject({ group: "other", plus: 0 });

    await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 2 });
    const more = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Гена" }] })).json();
    expect(more[0]).toMatchObject({ seat: 4, paid: false });
    const detail = (await req(cookie, "GET", `/api/invitations/${inv.id}`)).json();
    expect(detail.guests.map((g: { paid: boolean }) => g.paid)).toEqual([true, true, false, false]);
    expect(detail.stats.guests).toBe(4);

    for (const bad of [{ guests: [] }, { guests: [{ name: "" }] }, { guests: [{ name: "x", plus: 11 }] }, { guests: [{ name: "x", group: "vip" }] }, { guests: [{ name: "x", phone: "123" }] }]) {
      expect((await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("удаление гостя сдвигает следующих в оплаченные, номера мест не переиспользуются", async () => {
    const { cookie } = await user();
    const { inv, added } = await personalWithGuests(cookie, ["Аня", "Боря", "Вика"], 2);
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
    // Ссылка третьего гостя не открывается, пока место не оплачено.
    expect((await t.app.inject({ url: `/api/public/g/${added[2].token}` })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/api/public/g/${added[1].token}` })).statusCode).toBe(200);

    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${added[0].id}`)).statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/public/g/${added[0].token}` })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/api/public/g/${added[2].token}` })).statusCode).toBe(200);
    const after = (await req(cookie, "GET", `/api/invitations/${inv.id}`)).json().guests;
    expect(after.map((g: { seat: number; paid: boolean }) => [g.seat, g.paid])).toEqual([
      [2, true],
      [3, true],
    ]);

    // Удаляем последнего и добавляем нового: номер места новый.
    await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${added[2].id}`);
    const next = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Дима" }] })).json();
    expect(next[0]).toMatchObject({ seat: 4, paid: true });
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${added[2].id}`)).statusCode).toBe(404);
  });

  it("изменение гостя с проверкой полей", async () => {
    const { cookie } = await user();
    const { inv, added } = await personalWithGuests(cookie, ["Аня"], 1);
    const url = `/api/invitations/${inv.id}/guests/${added[0].id}`;
    const g = (await req(cookie, "PATCH", url, { name: "Анна", phone: "90 123 45 67", group: "work", plus: 2, tableNo: 4 })).json();
    expect(g).toMatchObject({ name: "Анна", phone: "998901234567", group: "work", plus: 2, tableNo: 4, paid: true });
    expect((await req(cookie, "PATCH", url, { phone: null })).json().phone).toBeNull();
    const table = await req(cookie, "PATCH", url, { tableNo: 5 });
    expect(table.statusCode).toBe(400);
    expect(table.json().error).toBe("Такого стола нет");
    for (const bad of [{ plus: 11 }, { plus: -1 }, { tableNo: -1 }, { name: " " }, { rsvp: "later" }, { group: "vip" }, { checkedIn: "yes" }]) {
      expect((await req(cookie, "PATCH", url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }

    const yes = (await req(cookie, "PATCH", url, { rsvp: "yes" })).json();
    expect(yes.rsvp).toBe("yes");
    expect(yes.respondedAt).toEqual(expect.any(String));
    expect((await req(cookie, "PATCH", url, { rsvp: "pending" })).json().respondedAt).toBeNull();

    const inside = (await req(cookie, "PATCH", url, { checkedIn: true })).json();
    expect(inside.checkedIn).toBe(true);
    const again = (await req(cookie, "PATCH", url, { checkedIn: true })).json();
    expect(again.checkedInAt).toBe(inside.checkedInAt);
    expect((await req(cookie, "PATCH", url, { checkedIn: false })).json()).toMatchObject({ checkedIn: false, checkedInAt: null });
    const kinds = (await req(cookie, "GET", `/api/invitations/${inv.id}/activity`)).json().map((a: { kind: string }) => a.kind);
    expect(kinds.filter((k: string) => k === "checkin")).toHaveLength(1);
  });

  it("отметка на входе по токену", async () => {
    const { cookie } = await user();
    const { inv, added } = await personalWithGuests(cookie, ["Аня Иванова", "Боря"], 2);
    const other = await personalWithGuests(cookie, ["Чужой"], 0);
    const url = `/api/invitations/${inv.id}/checkin`;
    expect((await req(cookie, "POST", url, { token: other.added[0].token })).statusCode).toBe(404);
    expect((await req(cookie, "POST", url, { token: "short" })).statusCode).toBe(400);
    const r = await req(cookie, "POST", url, { token: added[0].token });
    expect(r.statusCode).toBe(200);
    expect(r.json().guest).toMatchObject({ id: added[0].id, checkedIn: true, paid: true });
    const r2 = (await req(cookie, "POST", url, { token: added[0].token })).json();
    expect(r2.guest.checkedInAt).toBe(r.json().guest.checkedInAt);
    const act = (await req(cookie, "GET", `/api/invitations/${inv.id}/activity`)).json();
    expect(act[0]).toMatchObject({ kind: "checkin", guestId: added[0].id, guestName: "Аня Иванова" });
    expect(act.filter((a: { kind: string }) => a.kind === "checkin")).toHaveLength(1);
  });
});

describe("SMS по модели мест", () => {
  it("оплаченность по порядку и лимит paidSeats × 3 на приглашение", async () => {
    await db.update(templates).set({ smsEnabled: true }).where(eq(templates.slug, "wedding-classic"));
    const { cookie } = await user();
    const inv = await create(cookie, { mode: "personal", language: "ru", data: { names: "Анна и Тимур", date: "2026-12-26" } });
    const add = async (name: string, phone: string) => (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name, phone }] })).json()[0];
    const a = await add("Аня", "901110001");
    const b = await add("Боря", "901110002");
    await pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 1 });
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);

    t.smsSent.length = 0;
    const r1 = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json();
    expect(r1).toEqual({ sent: 1, skipped: [{ guestId: b.id, name: "Боря", reason: "seat_unpaid" }], limited: false });
    expect(t.smsSent[0]!.text).toBe(`Аня, приглашаем вас: Анна и Тимур, 26.12.2026. Ваше приглашение: ${APP_URL}/g/${a.token}`);
    await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, { guestIds: [a.id] });
    await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, { guestIds: [a.id] });

    // Удаляем Аню: Боря становится оплаченным, но SMS удалённой гостьи считаются в лимите приглашения.
    await req(cookie, "DELETE", `/api/invitations/${inv.id}/guests/${a.id}`);
    const r2 = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json();
    expect(r2).toEqual({ sent: 0, skipped: [{ guestId: b.id, name: "Боря", reason: "invitation_limit" }], limited: false });

    const detail = (await req(cookie, "GET", `/api/invitations/${inv.id}`)).json();
    expect(detail.guests[0]).toMatchObject({ id: b.id, paid: true, sms: null });
    const act = (await req(cookie, "GET", `/api/invitations/${inv.id}/activity`)).json();
    expect(act.filter((x: { kind: string }) => x.kind === "sms").map((x: { meta: unknown }) => x.meta)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
    await db.update(templates).set({ smsEnabled: false }).where(eq(templates.slug, "wedding-classic"));
  });
});

describe("миграция мест", () => {
  it("счётчик next_seat продолжает существующую нумерацию", async () => {
    const { cookie } = await user();
    const { inv } = await personalWithGuests(cookie, ["Аня", "Боря"], 0);
    const [row] = await db.select({ next: invitations.nextSeat }).from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.next).toBe(3);
    const n = await db.select().from(guests).where(eq(guests.invitationId, inv.id));
    expect(n).toHaveLength(2);
    expect(await db.select().from(orders).where(eq(orders.invitationId, inv.id))).toHaveLength(0);
  });
});
