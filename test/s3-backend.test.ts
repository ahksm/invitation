import { readFileSync } from "node:fs";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logUrl } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { orders, templates, usageEvents, users } from "../src/db/schema.js";
import { multicardSign } from "../src/payments/multicard.js";
import type { SmsProvider } from "../src/sms/types.js";
import { APP_URL, testContext } from "./helpers.js";

// Секрет колбэка SMS с символами, которые в адресе меняют смысл («+» — пробел, «&» — новый параметр).
const SMS_SECRET = "a+b/c=d&e f";
const t = testContext({ SMS_CALLBACK_SECRET: SMS_SECRET });
const { db, redis, calls, login, req } = t;
const template = "wedding-classic";

/** Минимальное окружение для loadConfig. */
const baseEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", JWT_SECRET: "x".repeat(32) };
/** Всё, что production требует помимо APP_URL. */
const prodEnv = {
  ...baseEnv,
  NODE_ENV: "production",
  PAYMENT_PROVIDER: "multicard",
  MULTICARD_APPLICATION_ID: "app",
  MULTICARD_SECRET: "s",
  MULTICARD_STORE_ID: "1234",
  MULTICARD_MXIK: "1",
  MULTICARD_PACKAGE_CODE: "2",
  SMS_PROVIDER: "eskiz",
  ESKIZ_EMAIL: "e@x",
  ESKIZ_PASSWORD: "p",
};

let nextUser = 80_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);
const admin = () => login(1);
const bearerOf = (cookie: string) => ({ authorization: `Bearer ${cookie.replace(/^session=/, "")}` });
const lastInvoice = () => calls.filter((c) => c.url.endsWith("/payment/invoice")).at(-1)!.body;

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("заказы", () => {
  it("оплата из мини-аппа возвращает на экран без входа, с сайта — на экран заказа", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "shared" })).json();

    // Сайт: сессия в cookie, возврат на экран заказа.
    const web = (await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1 })).json();
    expect(lastInvoice().return_url).toBe(`${APP_URL}/app/#/orders/${web.order.id}`);

    // Мини-апп входит по токену в Authorization: браузер, где откроется оплата, сессии не имеет.
    const tg = (await req(null, "POST", "/api/orders", { kind: "template", invitationId: inv.id }, bearerOf(cookie))).json();
    expect(lastInvoice().return_url).toBe(`${APP_URL}/app/#/paid/${tg.order.id}`);

    // Явный returnTo важнее способа входа.
    const explicit = (await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1, returnTo: "telegram" })).json();
    expect(lastInvoice().return_url).toBe(`${APP_URL}/app/#/paid/${explicit.order.id}`);
    const back = (await req(null, "POST", "/api/orders", { kind: "subscription", months: 1, returnTo: "app" }, bearerOf(cookie))).json();
    expect(lastInvoice().return_url).toBe(`${APP_URL}/app/#/orders/${back.order.id}`);
    expect((await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1, returnTo: "x" })).statusCode).toBe(400);
  });

  it("клиент не получает meta заказа, а из уведомления не сохраняются номер и токен карты, подпись и телефон", async () => {
    const { cookie } = await user();
    const created = (await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1 })).json();
    expect(created.order).not.toHaveProperty("meta");
    const { number, amount, id } = created.order;
    const cb = await t.app.inject({
      method: "POST",
      url: "/api/payments/multicard/callback",
      payload: {
        store_id: 6,
        invoice_id: String(number),
        amount,
        uuid: `uuid-${number}`,
        billing_id: "b-1",
        payment_time: "2026-10-19 20:00:00",
        ps: "uzcard",
        card_pan: "860002******1234",
        card_token: "tok-secret-abc",
        phone: "998901234567",
        receipt_url: "https://receipt.test/1",
        sign: multicardSign(6, String(number), amount, "mc-secret"),
      },
    });
    expect(cb.statusCode).toBe(200);

    const list = (await req(cookie, "GET", "/api/orders")).json();
    expect(list[0]).toEqual({
      id,
      number,
      kind: "subscription",
      invitationId: null,
      quantity: 1,
      amount,
      currency: "UZS",
      status: "paid",
      checkoutUrl: `https://checkout.test/${number}`,
      paidAt: expect.any(String),
      createdAt: expect.any(String),
      template: null,
    });
    const one = (await req(cookie, "GET", `/api/orders/${id}`)).json();
    expect(one).not.toHaveProperty("meta");
    expect(JSON.stringify(one)).not.toContain("tok-secret");

    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    expect(row!.meta.notification).toEqual({
      uuid: `uuid-${number}`,
      invoice_id: String(number),
      amount,
      billing_id: "b-1",
      payment_time: "2026-10-19 20:00:00",
      ps: "uzcard",
      receipt_url: "https://receipt.test/1",
    });
    expect(JSON.stringify(row!.meta)).not.toMatch(/860002|\*{6}|tok-secret|998901234567/);
  });

  it("в заказе шаблона — оплаченный шаблон, даже если шаблон приглашения потом сменили", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "shared" })).json();
    const created = (await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id })).json();
    expect(created.order.template).toBe("wedding-classic");
    await t.callback(created.order.number, created.order.amount);
    // Шаблон не дороже оплаченного: сменить можно без доплаты.
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-botanical" })).json().template).toBe("wedding-botanical");
    const sub = (await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1 })).json();
    const list = (await req(cookie, "GET", "/api/orders")).json();
    expect(list.map((o: any) => [o.kind, o.template])).toEqual([["subscription", null], ["template", "wedding-classic"]]);
    expect((await req(cookie, "GET", `/api/orders/${created.order.id}`)).json()).toMatchObject({ status: "paid", template: "wedding-classic" });
    expect((await req(cookie, "GET", `/api/orders/${sub.order.id}`)).json().template).toBeNull();
    // Места: шаблон не оплачивается.
    const pers = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal" })).json();
    expect((await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: pers.id, quantity: 2 })).json().order.template).toBeNull();
    // Испорченный templateId в meta не ломает историю: шаблона просто нет.
    await db.update(orders).set({ meta: { templateId: "not-a-uuid" } }).where(eq(orders.id, created.order.id));
    const res = await req(cookie, "GET", "/api/orders");
    expect(res.statusCode).toBe(200);
    expect(res.json().find((o: any) => o.id === created.order.id).template).toBeNull();
  });

  it("заказ шаблона, который не дошёл до платёжной системы, сохраняет шаблон", async () => {
    const { cookie } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-luxe", mode: "shared" })).json();
    const payments = t.app.ctx.payments;
    const create = payments.createCheckout;
    payments.createCheckout = async () => {
      throw new Error("Multicard: HTTP 503");
    };
    try {
      const res = await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id });
      expect(res.statusCode).toBe(502);
    } finally {
      payments.createCheckout = create;
    }
    const [row] = await db.select().from(orders).where(eq(orders.invitationId, inv.id));
    expect(row).toMatchObject({ status: "failed", meta: { templateId: expect.any(String), error: "Error: Multicard: HTTP 503" } });
    // Шаблон приглашения потом сменили: в истории — тот, за который выставляли счёт.
    await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-classic" });
    const list = (await req(cookie, "GET", "/api/orders")).json();
    expect(list.map((o: any) => [o.kind, o.status, o.template])).toEqual([["template", "failed", "wedding-luxe"]]);
    expect((await req(cookie, "GET", `/api/orders/${row!.id}`)).json()).toMatchObject({ status: "failed", template: "wedding-luxe" });
  });

  it("миграция 0007 убирает из сохранённых уведомлений номер карты и прочие лишние поля, остальное не трогает", async () => {
    const { user: u } = await user();
    const kept = { uuid: "u-1", invoice_id: "1001", billing_id: "b-1", payment_time: "2026-10-01 12:00:00", ps: "humo", receipt_url: "https://receipt.test/1", amount: 5_000_000 };
    const metas: Record<string, unknown>[] = [
      // Заказ, оплаченный до fdba585: список полей уже был, но с card_pan.
      { templateId: "t-1", notification: { ...kept, card_pan: "986001******4321" } },
      // Самые старые заказы: уведомление целиком, с токеном карты, подписью и телефоном плательщика.
      { duplicate: true, notification: { ...kept, card_pan: "860002******1234", card_token: "tok-old", sign: "abc", phone: "998901234567", store_id: 6 } },
      { templateId: "t-2", notification: kept },
      { templateId: "t-3" },
      {},
    ];
    const ids: string[] = [];
    for (const meta of metas) {
      const [o] = await db.insert(orders).values({ userId: u.id, kind: "template", amount: 5_000_000, currency: "UZS", status: "paid", provider: "multicard", meta }).returning();
      ids.push(o!.id);
    }
    const migration = readFileSync(new URL("../drizzle/0007_order_card_data.sql", import.meta.url), "utf8");
    const expected = [{ templateId: "t-1", notification: kept }, { duplicate: true, notification: kept }, metas[2], metas[3], {}];
    for (let run = 0; run < 2; run++) {
      await db.execute(sql.raw(migration));
      for (const [i, id] of ids.entries()) {
        const [row] = await db.select({ meta: orders.meta }).from(orders).where(eq(orders.id, id));
        expect(row!.meta, `запуск ${run + 1}, заказ ${i}`).toEqual(expected[i]);
      }
    }
    const left = await db.select({ n: count() }).from(orders).where(sql`${orders.meta}->'notification' ? 'card_pan'`);
    expect(left[0]!.n).toBe(0);
  });
});

describe("журнал и активность", () => {
  it("автосохранение пишет в журнал одно «изменил приглашение» за 30 минут", async () => {
    const { cookie, user: u } = await user();
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "shared" })).json();
    for (let i = 0; i < 5; i++) {
      expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { message: `текст ${i}` } })).statusCode).toBe(200);
    }
    const events = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, u.id), eq(usageEvents.type, "invitation_updated")));
    expect(events).toHaveLength(1);
  });

  it("«Был» обновляется при работе в открытой сессии, не чаще раза в час", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const { cookie, user: u } = await user({ lastSeenAt: old });
    await db.update(users).set({ lastSeenAt: old }).where(eq(users.id, u.id));
    const seen = async () => (await db.select({ at: users.lastSeenAt }).from(users).where(eq(users.id, u.id)))[0]!.at!;

    expect((await req(cookie, "GET", "/api/invitations")).statusCode).toBe(200);
    const first = await seen();
    expect(Date.now() - first.getTime()).toBeLessThan(60_000);

    // В течение часа база не трогается.
    await db.update(users).set({ lastSeenAt: old }).where(eq(users.id, u.id));
    await req(cookie, "GET", "/api/invitations");
    expect((await seen()).getTime()).toBe(old.getTime());
  });
});

describe("админка", () => {
  it("ищет по «@username», «tg:ID» и полному имени", async () => {
    const { cookie } = await admin();
    const [target] = await db
      .insert(users)
      .values({ telegramId: 555000020, phone: "998905550020", username: "ivan_tg", firstName: "Иван", lastName: "Петров" })
      .returning();
    const find = async (q: string) =>
      (await req(cookie, "GET", `/api/admin/users?${new URLSearchParams({ q })}`)).json().items.map((u: { id: string }) => u.id);
    for (const q of ["ivan_tg", "@ivan_tg", "555000020", "tg:555000020", "TG: 555000020", "Иван", "Иван Петров", "петров", "+998 90 555-00-20"]) {
      expect(await find(q), q).toEqual([target!.id]);
    }
    // «tg:» ищет только по Telegram ID, не по телефону с теми же цифрами.
    expect(await find("tg:905550020")).toEqual([]);
  });

  it("листает пользователей по 50, считает всего и не повторяет строки на соседних страницах", async () => {
    const { cookie } = await admin();
    await db.insert(users).values(Array.from({ length: 60 }, (_, i) => ({ phone: `99890600${String(i).padStart(4, "0")}`, firstName: "Пачка" })));
    const page = async (n: number) => (await req(cookie, "GET", `/api/admin/users?q=Пачка&page=${n}`)).json();
    const [p1, p2] = [await page(1), await page(2)];
    expect(p1).toMatchObject({ page: 1, pageSize: 50, total: 60 });
    expect(p1.items).toHaveLength(50);
    expect(p2.items).toHaveLength(10);
    const ids = new Set([...p1.items, ...p2.items].map((u: { id: string }) => u.id));
    expect(ids.size).toBe(60);
  });

  it("дата подписки в списке пользователей — в ISO", async () => {
    const { cookie: adm } = await admin();
    const { cookie, user: u } = await user();
    await t.pay(cookie, { kind: "subscription", months: 1 });
    const list = (await req(adm, "GET", "/api/admin/users?filter=subscribed")).json();
    const row = list.items.find((x: { id: string }) => x.id === u.id);
    expect(row.subscriptionEndsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(row.subscriptionEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("«пользователей» не считает тех, кому доступ выдан заранее, пока они не вошли", async () => {
    const { cookie } = await admin();
    const before = (await req(cookie, "GET", "/api/admin/stats")).json();
    for (const who of ["tg:777000222", "777000333", "+998903000006"]) {
      expect((await req(cookie, "POST", "/api/admin/users/free-access", { who })).statusCode).toBe(200);
    }
    const after = (await req(cookie, "GET", "/api/admin/stats")).json();
    expect(after.users).toBe(before.users);
    expect(after.freeAccessUsers).toBe(before.freeAccessUsers + 3);
    expect(after.pendingFreeAccess).toBe(before.pendingFreeAccess + 3);
  });

  it("платежи листаются по 50", async () => {
    const { cookie: adm } = await admin();
    const p1 = (await req(adm, "GET", "/api/admin/orders?page=1")).json();
    const far = (await req(adm, "GET", "/api/admin/orders?page=1000")).json();
    expect(p1.length).toBeGreaterThan(0);
    expect(far).toEqual([]);
  });
});

describe("SMS", () => {
  it("секрет в адресе колбэка о доставке кодируется и принимается обратно", async () => {
    const urls: (string | undefined)[] = [];
    const orig = t.app.ctx.sms;
    const recording: SmsProvider = {
      name: orig.name,
      parseDelivery: (b) => orig.parseDelivery(b),
      send: (phone, text, opts) => (urls.push(opts?.callbackUrl), orig.send(phone, text, opts)),
    };
    t.app.ctx.sms = recording;
    try {
      const { cookie } = await user();
      const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal", data: { names: "A & B" } })).json();
      await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Aziz", phone: "+998 90 555-77-01" }] });
      await t.pay(cookie, { kind: "seats", invitationId: inv.id, quantity: 1 });
      await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);
      await db.update(templates).set({ smsEnabled: true });
      expect((await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json().sent).toBe(1);
    } finally {
      t.app.ctx.sms = orig;
      await db.update(templates).set({ smsEnabled: false });
    }
    const url = urls[0]!;
    expect(url).toBe(`${APP_URL}/api/sms/mock/callback?secret=${encodeURIComponent(SMS_SECRET)}`);
    const path = url.slice(APP_URL.length);
    expect((await t.app.inject({ method: "POST", url: path, payload: { request_id: "x", status: "DELIVRD" } })).statusCode).toBe(200);
  });
});

describe("сервер", () => {
  it("в лог не попадают пароль приглашения, код входа и секрет колбэка", () => {
    expect(logUrl("/i/abc?code=Secret")).toBe("/i/abc?code=***");
    expect(logUrl("/api/auth/link?code=vcode123&x=1")).toBe("/api/auth/link?code=***&x=1");
    expect(logUrl("/api/sms/eskiz/callback?secret=a+b/c=d")).toBe("/api/sms/eskiz/callback?secret=***");
    expect(logUrl("/api/admin/users?q=ivan&page=2")).toBe("/api/admin/users?q=ivan&page=2");
  });

  it("сжимает ответы API и файлы админки", async () => {
    for (const url of ["/api/templates", "/admin/admin.js", "/shared/i18n.js"]) {
      const res = await t.app.inject({ url, headers: { "accept-encoding": "gzip" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-encoding"], url).toBe("gzip");
    }
    // Файлы под /app/ по-прежнему отдаются заранее сжатыми копиями.
    const app = await t.app.inject({ url: "/app/support.js", headers: { "accept-encoding": "br" } });
    expect(app.headers["content-encoding"]).toBe("br");
  });

  it("ссылка гостя с «/» в конце ведёт на ссылку, неизвестная страница — «не найдено» в стиле сайта", async () => {
    const html = { accept: "text/html,application/xhtml+xml" };
    const slash = await t.app.inject({ url: "/i/abcdef/?code=x1", headers: html });
    expect(slash.statusCode).toBe(301);
    expect(slash.headers.location).toBe("/i/abcdef?code=x1");
    const guest = await t.app.inject({ url: "/g/tok123/" });
    expect(guest.statusCode).toBe(301);
    expect(guest.headers.location).toBe("/g/tok123");

    for (const url of ["/foo", "/admin/x", "/index.php/x"]) {
      const res = await t.app.inject({ url, headers: html });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toContain("text/html");
      expect(res.body, url).toContain('"mode":"notfound"');
    }
    // API, файлы и запросы не за HTML — JSON, как раньше.
    for (const [url, headers] of [["/api/nope", html], ["/app/missing.js", html], ["/foo", {}], ["/media/none.png", html]] as const) {
      const res = await t.app.inject({ url, headers });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toContain("application/json");
    }
  });

  it("/health проверяет и Redis, и Postgres", async () => {
    expect((await t.app.inject({ url: "/health" })).json()).toEqual({ ok: true });
  });
});

describe("конфигурация", () => {
  it("MULTICARD_STORE_ID — только числовой ID кассы", () => {
    const multicard = { ...baseEnv, PAYMENT_PROVIDER: "multicard" };
    expect(() => loadConfig({ ...multicard, MULTICARD_STORE_ID: "3f0b6c1e-6f4a-4c11-9d1e-5b8f2a7c9e01" })).toThrow(/MULTICARD_STORE_ID: укажите числовой ID/);
    expect(loadConfig({ ...multicard, MULTICARD_STORE_ID: "1234" }).MULTICARD_STORE_ID).toBe("1234");
  });

  it("в production APP_URL — публичный https-адрес", () => {
    expect(() => loadConfig(prodEnv)).toThrow(/APP_URL: публичный https-адрес/);
    expect(() => loadConfig({ ...prodEnv, APP_URL: "http://invito.uz" })).toThrow(/APP_URL/);
    expect(() => loadConfig({ ...prodEnv, APP_URL: "https://localhost:3000" })).toThrow(/APP_URL/);
    expect(loadConfig({ ...prodEnv, APP_URL: "https://invito.uz" }).APP_URL).toBe("https://invito.uz");
    // Вне production локальный адрес по-прежнему подходит.
    expect(loadConfig(baseEnv).APP_URL).toBe("http://localhost:3000");
  });

  it("название по умолчанию — Invito", () => {
    expect(loadConfig(baseEnv).APP_NAME).toBe("Invito");
  });
});
