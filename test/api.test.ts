import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveTelegramLogin } from "../src/auth/telegram.js";
import { templates, users } from "../src/db/schema.js";
import { defaultPrices } from "../src/pricing.js";
import { applySmsDelivery } from "../src/services/sms.js";
import { APP_URL, phoneOf, sessionCookie, testContext } from "./helpers.js";
import { signInitData } from "./telegram.test.js";

const t = testContext();
const { db, redis, cache, config, smsSent, calls, login, req, callback } = t;
const template = "wedding-classic";

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("защита", () => {
  it("без входа API закрыт", async () => {
    expect((await req(null, "GET", "/api/invitations")).statusCode).toBe(401);
  });

  it("изменяющие запросы с чужого сайта отклоняются", async () => {
    const { cookie } = await login(100);
    const res = await t.app.inject({ method: "POST", url: "/api/invitations", headers: { cookie, origin: "https://evil.example" }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("неверные данные дают 400", async () => {
    const { cookie } = await login(100);
    expect((await req(cookie, "POST", "/api/invitations", { mode: "x" })).statusCode).toBe(400);
  });

  it("чужое приглашение не видно", async () => {
    const a = await login(101);
    const b = await login(102);
    const inv = (await req(a.cookie, "POST", "/api/invitations", { template, mode: "shared" })).json();
    expect((await req(b.cookie, "GET", `/api/invitations/${inv.id}`)).statusCode).toBe(404);
  });

  it("админка только для админа", async () => {
    const { cookie } = await login(103);
    expect((await req(cookie, "GET", "/api/admin/stats")).statusCode).toBe(403);
  });
});

describe("оплата общего шаблона", () => {
  it("создаёт счёт Multicard, проверяет подпись и открывает шаблон один раз", async () => {
    const { cookie } = await login(200);
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "shared", data: { names: "A & B" } })).json();
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(402);

    calls.length = 0;
    const orderRes = await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id });
    expect(orderRes.statusCode).toBe(201);
    const { order, checkoutUrl } = orderRes.json();
    expect(order.amount).toBe(defaultPrices.sharedTemplate);
    expect(checkoutUrl).toBe(`https://checkout.test/${order.number}`);
    const invoiceCall = calls.find((c) => c.url.endsWith("/payment/invoice"))!;
    expect(invoiceCall.body).toMatchObject({ store_id: 6, amount: order.amount, invoice_id: String(order.number) });
    expect(invoiceCall.body.callback_url).toBe(`${APP_URL}/api/payments/multicard/callback`);
    expect(invoiceCall.body.lang).toBe("ru");
    expect(invoiceCall.body.ofd).toEqual([
      { name: "Шаблон «Ivory»", qty: 1, price: order.amount, total: order.amount, mxik: "10305008002000000", package_code: "1545643" },
    ]);

    expect((await callback(order.number, order.amount, "wrong")).statusCode).toBe(400);
    const mismatch = await callback(order.number, order.amount - 1);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toEqual({ success: false, message: "Сумма оплаты не совпадает с заказом" });
    const ok = await callback(order.number, order.amount);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ success: true });
    expect((await callback(order.number, order.amount)).statusCode).toBe(200);

    const paid = (await req(cookie, "GET", `/api/orders/${order.id}`)).json();
    expect(paid.status).toBe("paid");

    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);
    const pub = await t.app.inject({ url: `/api/public/i/${inv.slug}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ kind: "shared", template, event: "wedding", data: { names: "A & B" } });
    expect(pub.json()).not.toHaveProperty("title");

    // Повторно платить за открытый шаблон нельзя.
    expect((await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: inv.id })).statusCode).toBe(409);
  });
});

describe("персональные приглашения", () => {
  it("открываются только ссылки оплаченных гостей", async () => {
    const { cookie } = await login(300);
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal" })).json();
    const added = (await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Аня" }, { name: "Боря" }, { name: "Вика" }] })).json();
    expect(added.map((g: any) => g.seat)).toEqual([1, 2, 3]);

    const { order } = (await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: inv.id, quantity: 2 })).json();
    expect(order.amount).toBe(2 * defaultPrices.seat);
    await callback(order.number, order.amount);
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/publish`)).statusCode).toBe(200);

    const g1 = await t.app.inject({ url: `/api/public/g/${added[0].token}` });
    expect(g1.json()).toMatchObject({ guest: { name: "Аня" } });
    expect((await t.app.inject({ url: `/api/public/g/${added[2].token}` })).statusCode).toBe(404);

    const rsvp = await t.app.inject({ method: "POST", url: `/api/public/g/${added[0].token}/rsvp`, payload: { status: "yes" }, headers: { origin: APP_URL } });
    expect(rsvp.statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/public/g/${added[0].token}` })).json().guest.rsvp).toBe("yes");
  });
});

describe("подписка и бесплатный доступ", () => {
  it("подписка открывает шаблон бесплатно, но места платные", async () => {
    const { cookie } = await login(400);
    const { order } = (await req(cookie, "POST", "/api/orders", { kind: "subscription", months: 1 })).json();
    expect(order.amount).toBe(defaultPrices.subscriptionMonth);
    await callback(order.number, order.amount);
    const me = (await req(cookie, "GET", "/api/auth/me")).json();
    expect(me.access.subscribed).toBe(true);

    const shared = (await req(cookie, "POST", "/api/invitations", { template, mode: "shared" })).json();
    const t = await req(cookie, "POST", "/api/orders", { kind: "template", invitationId: shared.id });
    expect(t.json()).toMatchObject({ status: "fulfilled" });

    const personal = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal" })).json();
    const s = await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: personal.id, quantity: 5 });
    expect(s.json().order.amount).toBe(5 * defaultPrices.seat);
  });

  it("с бесплатным доступом всё открывается без оплаты", async () => {
    const admin = await login(1);
    const grant = await req(admin.cookie, "POST", "/api/admin/users/free-access", { who: "500", note: "друг" });
    expect(grant.statusCode).toBe(200);

    const { cookie } = await login(500);
    const personal = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal" })).json();
    const s = await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: personal.id, quantity: 50 });
    expect(s.json()).toMatchObject({ status: "fulfilled" });
    expect((await req(cookie, "GET", `/api/invitations/${personal.id}`)).json().paidSeats).toBe(50);
  });
});

describe("админка", () => {
  it("видит пользователей, платежи и меняет цены", async () => {
    const admin = await login(1);
    const stats = (await req(admin.cookie, "GET", "/api/admin/stats")).json();
    expect(stats.users).toBeGreaterThan(3);
    expect(stats.paidOrders).toBeGreaterThan(0);

    const list = (await req(admin.cookie, "GET", "/api/admin/users?filter=free")).json();
    expect(list.items.some((u: any) => u.telegramId === 500)).toBe(true);
    const paying = (await req(admin.cookie, "GET", "/api/admin/users?filter=paying")).json();
    expect(paying.items.every((u: any) => u.paidTotal > 0)).toBe(true);

    const detail = (await req(admin.cookie, "GET", `/api/admin/users/${paying.items[0].id}`)).json();
    expect(detail.orders.length).toBeGreaterThan(0);
    expect(detail.events.length).toBeGreaterThan(0);

    const newPrices = { sharedTemplate: 1000, seat: 10, subscriptionMonth: 5000 };
    expect((await req(admin.cookie, "PUT", "/api/admin/prices", newPrices)).statusCode).toBe(200);
    const { cookie } = await login(600);
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal" })).json();
    const o = (await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: inv.id, quantity: 3 })).json();
    expect(o.order.amount).toBe(30);
  });

  it("блокировка закрывает доступ сразу", async () => {
    const admin = await login(1);
    const target = await login(700);
    expect((await req(target.cookie, "GET", "/api/auth/me")).statusCode).toBe(200);
    await req(admin.cookie, "PATCH", `/api/admin/users/${target.user.id}`, { blocked: true });
    expect((await req(target.cookie, "GET", "/api/auth/me")).statusCode).toBe(403);
  });
});

describe("вход по телефону", () => {
  it("отправляет код по SMS, пускает по верному коду и создаёт аккаунт с номером", async () => {
    smsSent.length = 0;
    const r1 = await req(null, "POST", "/api/auth/phone/request", { phone: "+998 93 111-22-33" }, { "x-lang": "uz" });
    expect(r1.statusCode).toBe(200);
    expect(smsSent[0]!.phone).toBe("998931112233");
    expect(smsSent[0]!.text).toMatch(/^localhost saytiga kirish uchun tasdiqlash kodi: \d{6}\. Kodni hech kimga bermang\.$/);
    const code = smsSent[0]!.text.match(/\d{6}/)![0];

    // Повторный запрос в ту же минуту запрещён.
    expect((await req(null, "POST", "/api/auth/phone/request", { phone: "998931112233" })).statusCode).toBe(429);

    const wrong = await req(null, "POST", "/api/auth/phone/verify", { phone: "998931112233", code: code === "000000" ? "111111" : "000000" }, { "x-lang": "en" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("Wrong or expired code");

    const ok = await req(null, "POST", "/api/auth/phone/verify", { phone: "+998931112233", code }, { "x-lang": "uz" });
    expect(ok.statusCode).toBe(200);
    const me = (await req(sessionCookie(ok), "GET", "/api/auth/me")).json();
    expect(me.user).toMatchObject({ phone: "998931112233", telegramId: null, locale: "uz" });

    // Код одноразовый.
    expect((await req(null, "POST", "/api/auth/phone/verify", { phone: "998931112233", code })).statusCode).toBe(400);
  });

  it("код сгорает после 5 неверных попыток", async () => {
    smsSent.length = 0;
    await req(null, "POST", "/api/auth/phone/request", { phone: "998931112244" });
    const code = smsSent[0]!.text.match(/\d{6}/)![0];
    const bad = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await req(null, "POST", "/api/auth/phone/verify", { phone: "998931112244", code: bad });
    expect((await req(null, "POST", "/api/auth/phone/verify", { phone: "998931112244", code })).statusCode).toBe(400);
  });

  it("без номера телефона кабинет закрыт", async () => {
    const [u] = await db.insert(users).values({ telegramId: 800 }).returning();
    const res = await req(`session=${t.app.jwt.sign({ sub: u!.id })}`, "GET", "/api/invitations");
    expect(res.statusCode).toBe(428);
  });
});

describe("вход через Telegram", () => {
  it("сессию получает только браузер, начавший вход, после подтверждения в боте", async () => {
    const start = await req(null, "POST", "/api/auth/telegram/start");
    const { nonce, url } = start.json();
    expect(url).toBe(`https://t.me/invite_test_bot?start=auth_${nonce}`);
    const browser = `tglogin=${start.cookies.find((c) => c.name === "tglogin")!.value}`;

    expect((await req(browser, "POST", "/api/auth/telegram/poll", { nonce })).json().status).toBe("pending");
    const { user } = await login(900);
    expect(await approveTelegramLogin(cache, nonce, user.id)).toBe(true);

    // Чужой браузер без секрета ничего не получает.
    expect((await req("tglogin=wrong", "POST", "/api/auth/telegram/poll", { nonce })).json().status).toBe("expired");
    const ok = await req(browser, "POST", "/api/auth/telegram/poll", { nonce });
    expect(ok.json().status).toBe("ok");
    expect((await req(sessionCookie(ok), "GET", "/api/auth/me")).json().user.id).toBe(user.id);
    // Повторно забрать нельзя.
    expect((await req(browser, "POST", "/api/auth/telegram/poll", { nonce })).json().status).toBe("expired");
  });

  it("мини-апп требует номер, а после привязки пускает", async () => {
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 901, first_name: "Mini", language_code: "en" }) });
    expect((await req(null, "POST", "/api/auth/webapp", { initData })).json()).toEqual({ status: "phone_required" });
    await db.update(users).set({ phone: phoneOf(901) }).where(sql`telegram_id = 901`);
    await redis.flushdb();
    const ok = await req(null, "POST", "/api/auth/webapp", { initData });
    expect(ok.json().status).toBe("ok");
    expect((await req(sessionCookie(ok), "GET", "/api/auth/me")).json().user.locale).toBe("en");
    // Внутри фрейма Telegram Web cookie не доходит: тот же вход работает по токену в заголовке.
    const bearer = { authorization: `Bearer ${ok.json().token}` };
    expect((await req(null, "GET", "/api/auth/me", undefined, bearer)).json().user.locale).toBe("en");
    expect((await req(null, "PATCH", "/api/auth/me", { locale: "uz" }, bearer)).json()).toEqual({ ok: true, locale: "uz" });
    expect((await req(null, "GET", "/api/auth/me", undefined, { authorization: "Bearer nope" })).statusCode).toBe(401);
    const forged = initData.replace("Mini", "Evil");
    expect((await req(null, "POST", "/api/auth/webapp", { initData: forged })).statusCode).toBe(401);
  });
});

describe("SMS гостям и язык приглашения", () => {
  it("шлёт SMS только оплаченным гостям с номером, на языке приглашения", async () => {
    const { cookie } = await login(1000);
    const inv = (await req(cookie, "POST", "/api/invitations", { template, mode: "personal", language: "uz", data: { names: "Anvar va Malika", date: "2026-12-12" } })).json();
    const added = (
      await req(cookie, "POST", `/api/invitations/${inv.id}/guests`, {
        guests: [{ name: "Aziz", phone: "+998 90 555-11-22" }, { name: "Bek" }, { name: "Dilnoza", phone: "905551133" }],
      })
    ).json();
    expect(added[0].phone).toBe("998905551122");
    const { order } = (await req(cookie, "POST", "/api/orders", { kind: "seats", invitationId: inv.id, quantity: 2 })).json();
    await callback(order.number, order.amount);
    await req(cookie, "POST", `/api/invitations/${inv.id}/publish`);

    // Пока для шаблона SMS не включены, рассылка запрещена.
    expect((await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).statusCode).toBe(403);
    await db.update(templates).set({ smsEnabled: true });

    smsSent.length = 0;
    const r = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, {})).json();
    expect(r.sent).toBe(1);
    expect(r.skipped.map((x: any) => x.reason).sort()).toEqual(["no_phone", "seat_unpaid"]);
    expect(smsSent[0]!.phone).toBe("998905551122");
    expect(smsSent[0]!.text).toBe(`Aziz, sizni taklif qilamiz: Anvar va Malika, 12.12.2026. Taklifnomangiz: ${APP_URL}/g/${added[0].token}`);

    // Не больше трёх SMS одному гостю.
    await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, { guestIds: [added[0].id] });
    await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, { guestIds: [added[0].id] });
    const fourth = (await req(cookie, "POST", `/api/invitations/${inv.id}/sms`, { guestIds: [added[0].id] })).json();
    expect(fourth.skipped[0].reason).toBe("limit_reached");

    const view = (await t.app.inject({ url: `/api/public/g/${added[0].token}` })).json();
    expect(view.language).toBe("uz");
    const detail = (await req(cookie, "GET", `/api/invitations/${inv.id}`)).json();
    expect(detail.guests[0].sms).toMatchObject({ status: "sent", count: 3 });
  });

  it("колбэк о доставке принимается только с секретом", async () => {
    const [row] = await db.execute(sql`select provider_ref from sms_messages where purpose = 'invite' limit 1`).then((r) => r.rows as { provider_ref: string }[]);
    const ref = row!.provider_ref;
    const bad = await t.app.inject({ method: "POST", url: "/api/sms/mock/callback?secret=nope", payload: { request_id: ref, status: "DELIVRD" } });
    expect(bad.statusCode).toBe(404);
    const ok = await t.app.inject({ method: "POST", url: "/api/sms/mock/callback?secret=sms-cb-secret", payload: { request_id: ref, status: "DELIVRD" } });
    expect(ok.statusCode).toBe(200);
  });

  it("поздний промежуточный статус SMS не затирает итоговый", async () => {
    const [row] = await db.execute(sql`select provider_ref from sms_messages where purpose = 'invite' limit 1`).then((r) => r.rows as { provider_ref: string }[]);
    const ref = row!.provider_ref;
    const status = async () =>
      (await db.execute(sql`select status from sms_messages where provider_ref = ${ref}`)).rows[0]!.status;
    await applySmsDelivery({ db }, ref, "delivered");
    await applySmsDelivery({ db }, ref, "sent");
    expect(await status()).toBe("delivered");
  });

  it("язык интерфейса сохраняется в профиле", async () => {
    const { cookie } = await login(1100);
    expect((await req(cookie, "PATCH", "/api/auth/me", { locale: "uz" })).statusCode).toBe(200);
    expect((await req(cookie, "GET", "/api/auth/me")).json().user.locale).toBe("uz");
    expect((await req(cookie, "PATCH", "/api/auth/me", { locale: "de" })).statusCode).toBe(400);
  });
});

describe("привязка номера из Telegram", () => {
  it("объединяет Telegram-аккаунт с аккаунтом, созданным по SMS", async () => {
    const { attachPhoneToTelegramUser } = await import("../src/services/phone.js");
    const [phoneUser] = await db.insert(users).values({ phone: "998977770001", freeAccess: true }).returning();
    const [tgUser] = await db.insert(users).values({ telegramId: 1200, username: "tg1200" }).returning();
    const { cookie } = { cookie: `session=${t.app.jwt.sign({ sub: phoneUser!.id })}` };
    const ctxLike = { db, cache, config, log: t.app.log };
    const merged = await attachPhoneToTelegramUser(ctxLike, tgUser!, "998977770001");
    expect(merged).toMatchObject({ id: phoneUser!.id, telegramId: 1200, username: "tg1200", freeAccess: true });
    expect((await req(cookie, "GET", "/api/auth/me")).json().user.telegramId).toBe("1200");

    const [other] = await db.insert(users).values({ telegramId: 1201 }).returning();
    await expect(attachPhoneToTelegramUser(ctxLike, other!, "998977770001")).rejects.toThrow("другому Telegram");
  });
});
