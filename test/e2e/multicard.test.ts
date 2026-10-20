import { and, eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, orders, users } from "../../src/db/schema.js";
import { createMulticardProvider, multicardSign } from "../../src/payments/multicard.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Оплата из мини-аппа настоящим кодом Multicard (src/payments/multicard.ts) с подменённой сетью: API Multicard —
 * fetch-заглушка в процессе, платёжная страница — заглушка в браузере (context.route). Как в жизни: мини-апп
 * открывает оплату во внешнем браузере (openLink), Multicard шлёт колбэк серверу и возвращает браузер на
 * return_url — /app/#/paid/<id> (контракт 3.9), а мини-апп узнаёт об оплате, когда снова становится видимым.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const BOT = "invito_e2e_bot";
const STORE = "6";
const SECRET = "mc-e2e-secret";
const CHECKOUT = "https://checkout.multicard.test";
let e: E2E;

/** Счета, созданные через POST /payment/invoice заглушки Multicard: uuid → тело запроса. */
const invoices = new Map<string, Dict>();
const fakeMulticard: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.endsWith("/auth")) return Response.json({ token: "tok", expiry: "2099-01-01 12:00:00" });
  if (url.endsWith("/payment/invoice")) {
    const uuid = `uuid-${body.invoice_id}`;
    invoices.set(uuid, body);
    return Response.json({ success: true, data: { uuid, checkout_url: `${CHECKOUT}/invoice/${uuid}` } });
  }
  return new Response("not found", { status: 404 });
};

beforeAll(async () => {
  e = await startE2E({
    payments: (_config, cache) =>
      createMulticardProvider({ baseUrl: "https://mesh.multicard.test", applicationId: "app", secret: SECRET, storeId: STORE, mxik: "10305008002000000", packageCode: "1545643", cache, fetch: fakeMulticard }),
  });
});

afterAll(async () => {
  await e?.close();
});

beforeEach(async () => {
  await e.redis.flushdb();
});

afterEach(() => {
  e.config.TELEGRAM_MODE = "off";
  e.config.TELEGRAM_BOT_USERNAME = "";
});

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);

/** Видимость мини-аппа: Telegram прячет его, пока открыт внешний браузер, и показывает снова при возврате. */
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((v) => {
    (window as any).__vis = v ? "visible" : "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);

describe("оплата из мини-аппа через Multicard", () => {
  it("внешний браузер после оплаты — на #/paid/<id> без входа, мини-апп при возврате видит оплату и публикует", async () => {
    // Бот в конфигурации (кнопка «Вернуться в Telegram»); сам бот не запускается.
    e.config.TELEGRAM_MODE = "polling";
    e.config.TELEGRAM_BOT_USERNAME = BOT;
    const tgId = 7_940_000_000 + Math.floor(Math.random() * 1e6);
    const [user] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Темур", locale: "ru" }).returning();
    const created = await e.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie: `session=${e.app.jwt.sign({ sub: user!.id })}`, origin: e.base },
      payload: { template: "wedding-classic", mode: "shared", language: "ru", data: { names: "Оплата Multicard", intro: "none" } },
    });
    const inv = created.json() as Dict;

    // Мини-апп. visibilityState управляется тестом (__vis).
    const mini = await e.newContext();
    await telegramStub(mini, { id: tgId, first_name: "Темур", language_code: "ru" });
    await mini.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window as any).__vis || "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as any).__vis === "hidden" });
    });
    const { page, problems, close } = await e.open("/app/", { context: mini, waitText: "Оплата Multicard" });
    const sent: Dict[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url() === e.base + "/api/orders") sent.push(r.postDataJSON() as Dict); });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.stepsX.sections).click();
    // MainButton на последнем шаге — «Получить ссылку»: сразу лист оплаты.
    expect((await tgState(page)).main.text).toBe(ru.toShare);
    await page.evaluate(() => (window as any).__tg.main.fn());
    // Лист оплаты открыт: MainButton — «Оплатить …» (кнопки в листе в мини-аппе нет).
    await sheet(page, "pay").waitFor();
    await expect.poll(async () => (await tgState(page)).main.text).toMatch(new RegExp("^" + ru.payBtn.replace("{price}", "")));
    expect(await sheet(page, "pay").locator('[data-pay="go"]').count()).toBe(0);
    await page.evaluate(() => (window as any).__tg.main.fn());

    // Заказ: returnTo telegram, Multicard получил return_url на #/paid/<id>; оплата открыта через openLink.
    await page.locator('[data-order-status="pending"]').waitFor();
    const [order] = await e.db.select().from(orders).where(and(eq(orders.invitationId, inv.id), eq(orders.userId, user!.id)));
    expect(sent).toEqual([{ kind: "template", invitationId: inv.id, returnTo: "telegram" }]);
    expect(order).toMatchObject({ provider: "multicard", status: "pending" });
    const invoice = invoices.get(order!.providerRef!)!;
    expect(invoice).toMatchObject({ invoice_id: String(order!.number), amount: order!.amount, return_url: `${e.base}/app/#/paid/${order!.id}`, callback_url: `${e.base}/api/payments/multicard/callback` });
    expect(page.url()).toBe(`${e.base}/app/#/orders/${order!.id}`);
    const checkoutUrl = `${CHECKOUT}/invoice/${order!.providerRef}`;
    expect((await tgState(page)).links).toEqual([["link", checkoutUrl]]);

    // Telegram прячет мини-апп: опрос заказа останавливается.
    await setVisible(page, false);
    await page.waitForTimeout(2500);
    const polls = () => problems.requests.filter((u) => u === `/api/orders/${order!.id}`).length;
    const hiddenPolls = polls();

    // Внешний браузер: без cookie и без Telegram. Платёжная страница Multicard (заглушка): «Оплатить» —
    // колбэк серверу с подписью, затем переход на return_url.
    const browser = await e.newContext();
    let callback: { status: number; body: Dict } | null = null;
    await browser.route(`${CHECKOUT}/**`, async (route) => {
      const url = new URL(route.request().url());
      const uuid = url.pathname.split("/").pop()!;
      const inv = invoices.get(uuid)!;
      if (url.pathname.startsWith("/invoice/")) {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Multicard</title><form method="post" action="/pay/${uuid}"><button>Оплатить ${inv.amount / 100}</button></form>` });
      }
      const body = { store_id: Number(STORE), invoice_id: inv.invoice_id, amount: inv.amount, uuid, sign: multicardSign(STORE, inv.invoice_id, inv.amount, SECRET) };
      const res = await fetch(inv.callback_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      callback = { status: res.status, body: (await res.json()) as Dict };
      return route.fulfill({ status: 302, headers: { location: inv.return_url } });
    });
    const pay = await browser.newPage();
    const extRequests: string[] = [];
    pay.on("request", (r) => { if (r.url().startsWith(e.base)) extRequests.push(r.url().slice(e.base.length)); });
    const extErrors: string[] = [];
    pay.on("pageerror", (err) => extErrors.push(String(err)));
    await pay.goto(checkoutUrl);
    await pay.getByRole("button", { name: /Оплатить/ }).click();
    await pay.waitForURL(`${e.base}/app/#/paid/${order!.id}`);
    await e.waitText(pay, ru.paidTitle);
    expect(callback).toEqual({ status: 200, body: { success: true } });
    const card = pay.locator('[data-screen="paid"]');
    expect(await card.innerText()).toContain(ru.paidText);
    expect(await card.locator("a[data-paid-bot]").getAttribute("href")).toBe(`https://t.me/${BOT}`);
    // Без входа: ни заказа, ни его номера; профиль не открыт.
    expect(extRequests.filter((u) => u.startsWith("/api/orders"))).toEqual([]);
    expect(await card.innerText()).not.toContain(String(order!.number));
    expect((await browser.cookies()).find((c) => c.name === "session")).toBeUndefined();
    expect(extErrors).toEqual([]);
    await e.shot(pay, "multicard-paid-external-ru-390x844.png");
    await browser.close();

    // Оплата пришла колбэком, но скрытый мини-апп заказ не опрашивал.
    expect((await e.db.select().from(orders).where(eq(orders.id, order!.id)))[0]!.status).toBe("paid");
    expect(polls()).toBe(hiddenPolls);

    // Человек вернулся в Telegram: мини-апп снова видим, проверяет заказ и публикует приглашение.
    await setVisible(page, true);
    await e.waitText(page, ru.linkReady);
    expect(polls()).toBeGreaterThan(hiddenPolls);
    expect((await e.db.select().from(invitations).where(eq(invitations.id, inv.id)))[0]).toMatchObject({ status: "active", unlocked: true });
    // Экран ссылки в мини-аппе: MainButton — «Отправить в Telegram», назад — BackButton Telegram; своих
    // «← Назад» и «Отправить в Telegram» на странице нет, «Скопировать» остаётся.
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.sendTg);
    expect((await tgState(page)).back).toBe(true);
    expect(await page.getByRole("button", { name: "← " + ru.back }).count()).toBe(0);
    expect(await page.getByRole("button", { name: ru.sendTg, exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: ru.copy, exact: true }).count()).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__tg.main.fn());
    const shared = (await tgState(page)).links.at(-1)!;
    expect(shared[0]).toBe("tg");
    expect(shared[1]).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
    await e.shot(page, "multicard-miniapp-back-ru-390x844.png");
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });
});
