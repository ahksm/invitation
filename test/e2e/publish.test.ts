import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guests, invitations, orders, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { signInitData, startE2E, uniquePhone, type E2E } from "./helpers.js";

/**
 * Публикация, оплата, «Поделиться», страница гостя и экран гостей в браузере вместе с API
 * (docs/invito-integration.md, раздел 4, пункты 7–10). Оплата — тестовый провайдер (mock),
 * SMS — в память. Во всех сценариях нет ошибок консоли и нарушений CSP; ожидаемые ответы 4xx,
 * которые Chromium сам пишет в консоль, перечислены в каждом сценарии.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const uzc = I18N.uzc as Dict;
const en = I18N.en as Dict;
const D = INVITO as Dict;
let e: E2E;

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.close();
});

// Лимиты запросов и кэш шаблонов и публичных страниц не переходят из сценария в сценарий.
beforeEach(async () => {
  await e.redis.flushdb();
});

const failed = (code: number, text: string) => `Failed to load resource: the server responded with a status of ${code} (${text})`;
const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

/** Запрос к API от имени пользователя (как его сделала бы страница). */
async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}

async function createInvitation(userId: string, body: Dict) {
  return apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
}

const invOf = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const guestsOf = (id: string) => e.db.select().from(guests).where(eq(guests.invitationId, id)).orderBy(guests.seat);
const ordersOf = (id: string) => e.db.select().from(orders).where(eq(orders.invitationId, id)).orderBy(orders.createdAt);

/** Опубликованное приглашение без интерфейса (как после оплаты). */
async function activate(id: string, values: Partial<typeof invitations.$inferInsert> = {}) {
  await e.db.update(invitations).set({ status: "active", publishedAt: new Date(), ...values }).where(eq(invitations.id, id));
}

/** Персональное опубликованное приглашение с оплаченными местами и гостями. */
async function personalWith(userId: string, list: Dict[], body: Dict = {}, paidSeats = list.length) {
  const inv = await createInvitation(userId, { mode: "personal", ...body });
  await activate(inv.id, { paidSeats });
  const added = list.length ? ((await apiAs(userId, "POST", `/api/invitations/${inv.id}/guests`, { guests: list })) as unknown as Dict[]) : [];
  return { inv, added };
}

/** Цены, которые возьмёт сервер, и цена шаблона приглашения. */
async function pricesFor(userId: string, template = "wedding-classic") {
  const me = await apiAs(userId, "GET", "/api/auth/me");
  const [tpl] = await e.db.select().from(templates).where(eq(templates.slug, template));
  return { ...(me.prices as { sharedTemplate: number; seat: number; subscriptionMonth: number }), template: tpl!.price ?? me.prices.sharedTemplate };
}

/** Сумма так, как её пишет приложение: Intl браузера, тийины в сумы. */
const money = (page: Page, amount: number, locale = "ru-RU", sum: string = ru.sum) =>
  page.evaluate(([a, l, c]) => new Intl.NumberFormat(l as string, { maximumFractionDigits: 2 }).format((a as number) / 100) + " " + c, [amount, locale, sum]);

/** Все запросы контекста, в том числе к чужим адресам (они заглушены, но видны). */
function allRequests(context: BrowserContext) {
  const list: string[] = [];
  context.on("request", (r) => list.push(r.url()));
  return list;
}

/** «Мои приглашения» → конструктор → последний шаг → редактор на странице гостя. tg — кнопка MainButton мини-аппа. */
async function toRefine(page: Page, t: Dict = ru, tg = false) {
  await page.locator("#my-inv").getByRole("button", { name: t.edit }).first().click();
  await page.getByTitle(t.stepsX.sections).click();
  if (tg) await page.evaluate(() => (window as any).__main());
  else await page.getByRole("button", { name: t.toEditor + " →" }).click();
}

/** Редактор → «Получить ссылку». */
async function toShare(page: Page, t: Dict = ru, tg = false) {
  await toRefine(page, t, tg);
  await page.getByRole("button", { name: new RegExp("^" + t.toShare) }).first().click();
}

/** Текст в DOM (innerText учитывает text-transform: uppercase у подписей шаблона). */
const waitContent = (page: Page, text: string, timeout = 20_000) =>
  page.waitForFunction((x) => (document.body.textContent || "").includes(x), text, { timeout });

/** Экран гостей приглашения из «Моих приглашений». */
async function toManage(page: Page, t: Dict = ru) {
  await page.locator("#my-inv").getByRole("button", { name: t.guests, exact: true }).first().click();
  await e.waitText(page, t.guestList);
}

const tab = (page: Page, label: string) => page.getByRole("button", { name: new RegExp("^" + label) }).first();

describe("публикация и оплата", () => {
  it("общая ссылка: лист с ценами сервера, тестовая оплата, заказ, публикация и «Поделиться»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Лола и Тимур", intro: "none" } });
    const P = await pricesFor(user.id);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Лола и Тимур" });
    await toShare(page);
    const pay = sheet(page, "pay");
    await pay.waitFor();
    const tplPrice = await money(page, P.template);
    // Цены — из ответов сервера: шаблон, место, подписка на 1, 3 и 12 месяцев.
    await expect.poll(() => pay.locator('[data-price="shared"]').innerText()).toBe(tplPrice);
    expect(await pay.locator('[data-price="personal"]').innerText()).toBe(ru.perGuest.replace("{price}", await money(page, P.seat)));
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(tplPrice);
    expect(await pay.locator('[data-pay="go"]').innerText()).toContain(ru.payBtn.replace("{price}", tplPrice));
    const sub = pay.locator("[data-sub]");
    for (const [i, m] of [1, 3, 12].entries()) expect(await sub.innerText()).toContain(ru.subMonths[i] + " · " + (await money(page, m * P.subscriptionMonth)));
    await e.shot(page, "pay-sheet-ru-390x844.png");
    // Персональные: 10 мест по цене места; назад к общей ссылке.
    await pay.locator('[data-mode="personal"]').click();
    expect(await pay.locator("input[name=seats]").inputValue()).toBe("10");
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(await money(page, 10 * P.seat));
    await pay.locator('[data-mode="shared"]').click();
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(tplPrice);

    await pay.locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    const [order] = await ordersOf(inv.id);
    expect(order).toMatchObject({ kind: "template", amount: P.template, status: "pending" });
    // На сайте — переход на checkoutUrl: тестовый провайдер перенаправляет на #/mock-pay/<id>.
    expect(page.url()).toBe(`${e.base}/app/#/mock-pay/${order!.id}`);
    expect(problems.requests).toContain(`/api/payments/mock/checkout/${order!.id}`);
    await expect.poll(() => page.locator('[data-screen="mock-pay"]').innerText()).toContain(tplPrice);
    expect(await page.locator('[data-screen="mock-pay"]').innerText()).toContain("№ " + order!.number);
    await e.shot(page, "mock-pay-ru-390x844.png");
    await page.locator('[data-mock="paid"]').click();
    // Заказ оплачен: приглашение опубликовано, открыт экран «Поделиться» с настоящей ссылкой.
    await e.waitText(page, ru.linkReady);
    await e.waitText(page, ru.published);
    expect(problems.requests).toContain(`/api/orders/${order!.id}`);
    const saved = await invOf(inv.id);
    expect(saved).toMatchObject({ status: "active", unlocked: true });
    expect((await ordersOf(inv.id))[0]!.status).toBe("paid");
    expect(page.url()).toBe(`${e.base}/app/`);
    expect(await page.locator("input[name=slug]").inputValue()).toBe(saved.slug);
    expect(await page.locator("pre").innerText()).toContain(`content="${e.base}/i/${saved.slug}"`);
    // Превью ссылки уходит на сервер (PUT /og) и становится og:image страницы.
    await expect.poll(async () => (await invOf(inv.id)).ogImageUrl ?? "", { timeout: 15_000 }).toMatch(/^\/media\/[0-9a-f-]{36}\.jpg$/);
    // Повторно «Получить ссылку» у опубликованного: сразу «Поделиться», без листа оплаты.
    await page.getByRole("button", { name: "← " + ru.back }).first().click();
    await page.getByRole("button", { name: new RegExp("^" + ru.toShare) }).first().click();
    await e.waitText(page, ru.linkReady);
    expect(await sheet(page, "pay").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("отказ в оплате: экран заказа с ошибкой и повтором; ожидание оплаты и опрос заказа", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Отказ тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Отказ тест" });
    await toShare(page);
    await sheet(page, "pay").locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await page.locator('[data-mock="failed"]').click();
    await page.locator('[data-order-status="failed"]').waitFor();
    const [order] = await ordersOf(inv.id);
    expect(order!.status).toBe("failed");
    expect(page.url()).toBe(`${e.base}/app/#/orders/${order!.id}`);
    expect(await page.locator('[data-screen="order"]').innerText()).toContain(ru.orderFailed);
    await e.shot(page, "order-failed-ru-390x844.png");
    expect((await invOf(inv.id)).status).toBe("draft");
    // «Попробовать снова» открывает лист оплаты того же приглашения.
    await page.getByRole("button", { name: new RegExp("^" + ru.orderRetry) }).click();
    await sheet(page, "pay").waitFor();
    expect(page.url()).toBe(`${e.base}/app/`);
    await sheet(page, "pay").getByRole("button", { name: ru.close, exact: true }).click();
    await sheet(page, "pay").waitFor({ state: "detached" });

    // Заказ ждёт оплаты: экран опрашивает GET /api/orders/:id и публикует приглашение после оплаты.
    const r = await apiAs(user.id, "POST", "/api/orders", { kind: "template", invitationId: inv.id });
    expect(r.status).toBe("pending");
    await page.evaluate((id) => { location.hash = "#/orders/" + id; }, r.order.id);
    await page.locator('[data-order-status="pending"]').waitFor();
    expect(await page.locator('[data-screen="order"]').innerText()).toContain(ru.orderWait);
    await e.shot(page, "order-pending-ru-390x844.png");
    await apiAs(user.id, "POST", `/api/payments/mock/checkout/${r.order.id}`, { status: "paid" });
    await e.waitText(page, ru.linkReady, 15_000);
    expect((await invOf(inv.id)).status).toBe("active");
    // Чужой или несуществующий заказ: текст сервера.
    await page.evaluate(() => { location.hash = "#/orders/00000000-0000-4000-8000-000000000000"; });
    await e.waitText(page, "Заказ не найден");
    expect(problems.console).toEqual([failed(404, "Not Found")]);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("бесплатный доступ: публикация без оплаты, суммы «Бесплатно»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { freeAccess: true });
    const inv = await createInvitation(user.id, { data: { names: "Бесплатно тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Бесплатно тест" });
    await toShare(page);
    const pay = sheet(page, "pay");
    await expect.poll(() => pay.locator('[data-price="shared"]').innerText()).toBe(ru.free);
    expect(await pay.locator('[data-price="personal"]').innerText()).toBe(ru.free);
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(ru.free);
    // Подписка не нужна тому, у кого всё бесплатно.
    expect(await pay.locator("[data-sub]").count()).toBe(0);
    await pay.locator('[data-pay="go"]').click();
    await e.waitText(page, ru.linkReady);
    expect((await invOf(inv.id)).status).toBe("active");
    expect(await ordersOf(inv.id)).toEqual([]);
    expect(problems.requests.filter((u) => u.startsWith("/api/payments/"))).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });

  it("402 от API открывает лист оплаты: шаблон дороже оплаченного, подписка, шаблон снова выбирается", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Дороже тест", intro: "none" } });
    await activate(inv.id, { unlocked: true });
    const P = await pricesFor(user.id);
    const [botanical] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-botanical"));
    await e.db.update(templates).set({ price: P.template + 10_000_00 }).where(eq(templates.id, botanical!.id));
    try {
      const { page, problems, close } = await e.open("/app/", { context, waitText: "Дороже тест" });
      await toRefine(page);
      // Шаблон Sage (wedding-botanical) дороже оплаченного: автосохранение получает 402.
      await page.getByRole("button", { name: D.EVENTS.wedding.names[1], exact: true }).click();
      const pay = sheet(page, "pay");
      await pay.waitFor({ timeout: 10_000 });
      expect(await pay.innerText()).toContain("Этот шаблон дороже оплаченного");
      expect(await pay.innerText()).toContain(ru.payUpTitle);
      // Оплаченный шаблон не продаётся второй раз: только подписка.
      expect(await pay.locator('[data-pay="go"]').count()).toBe(0);
      expect(await pay.locator("[data-mode]").count()).toBe(0);
      await pay.getByRole("button", { name: new RegExp("^" + ru.subMonths[1]) }).click();
      await expect.poll(() => pay.locator('[data-pay="sub"]').innerText()).toBe(ru.subBtn.replace("{price}", await money(page, 3 * P.subscriptionMonth)));
      await page.waitForTimeout(400);
      await e.shot(page, "pay-402-ru-390x844.png");
      expect((await invOf(inv.id)).templateId).not.toBe(botanical!.id);
      await pay.locator('[data-pay="sub"]').click();
      await page.locator('[data-screen="mock-pay"]').waitFor();
      const [order] = await e.db.select().from(orders).where(eq(orders.userId, user.id));
      expect(order).toMatchObject({ kind: "subscription", quantity: 3, amount: 3 * P.subscriptionMonth, invitationId: null });
      await page.locator('[data-mock="paid"]').click();
      // После подписки — снова редактор; шаблон подороже теперь сохраняется.
      await e.waitText(page, ru.subDone);
      await page.getByRole("button", { name: D.EVENTS.wedding.names[1], exact: true }).click();
      await expect.poll(async () => (await invOf(inv.id)).templateId, { timeout: 10_000 }).toBe(botanical!.id);
      expect(problems.console).toEqual([failed(402, "Payment Required")]);
      problems.console = [];
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ price: botanical!.price }).where(eq(templates.id, botanical!.id));
    }
  });
});

describe("публикация и оплата: подписка и профиль", () => {
  it("подписка при выбранных «Личных приглашениях»: тип уходит до оплаты, после неё — лист мест", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Подписка тест", intro: "none" } });
    const P = await pricesFor(user.id);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Подписка тест" });
    await toShare(page);
    const pay = sheet(page, "pay");
    await pay.locator('[data-mode="personal"]').click();
    await pay.locator("input[name=seats]").fill("3");
    await pay.locator('[data-pay="sub"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    // Тип приглашения сохранён до заказа подписки.
    expect((await invOf(inv.id)).mode).toBe("personal");
    await page.locator('[data-mock="paid"]').click();
    await e.waitText(page, ru.subDone);
    // Подписка не публикует общую ссылку: открыт лист мест персонального приглашения с выбранным числом.
    await pay.waitFor();
    await expect.poll(() => pay.locator("input[name=seats]").inputValue()).toBe("3");
    expect(await invOf(inv.id)).toMatchObject({ mode: "personal", status: "draft", unlocked: false });
    expect((await ordersOf(inv.id)).map((o) => o.kind)).toEqual([]);
    await page.waitForTimeout(400);
    await e.shot(page, "pay-seats-after-sub-ru-390x844.png");
    await pay.locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    expect((await ordersOf(inv.id))[0]).toMatchObject({ kind: "seats", quantity: 3, amount: 3 * P.seat });
    await page.locator('[data-mock="paid"]').click();
    await e.waitText(page, ru.linkReady);
    expect(await invOf(inv.id)).toMatchObject({ mode: "personal", status: "active", paidSeats: 3 });
    await e.expectClean(page, problems);
    await close();
  });

  it("сбой фонового обновления профиля (503) не выходит из аккаунта", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await personalWith(user.id, [{ name: "Гость Профиль" }], { data: { names: "Профиль тест", intro: "none" } }, 1);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Профиль тест" });
    await toManage(page);
    // Дальше /api/auth/me отвечает 503: лист оплаты перечитывает профиль и цены в фоне.
    const before = problems.requests.filter((u) => u === "/api/auth/me").length;
    await context.route(e.base + "/api/auth/me", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    await page.getByRole("button", { name: new RegExp("^" + ru.buySeats + " · ") }).click();
    await sheet(page, "pay").waitFor();
    await expect.poll(() => problems.requests.filter((u) => u === "/api/auth/me").length).toBe(before + 1);
    await page.waitForTimeout(600);
    // Человек по-прежнему вошёл: лист оплаты открыт, листа входа нет, в шапке не «Войти».
    expect(await sheet(page, "login").count()).toBe(0);
    expect(await sheet(page, "pay").count()).toBe(1);
    expect(await page.locator("[data-account]").first().innerText()).not.toContain(ru.login);
    // В консоли — ответ 503 и сбой сервера, который приложение пишет само (logErr); выхода нет.
    expect(problems.console[0]).toBe(failed(503, "Service Unavailable"));
    expect(problems.console.slice(1).every((m) => m.startsWith("Error: HTTP 503"))).toBe(true);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("лист оплаты на узбекском (латиница и кириллица) на 390 px: цена не наезжает на название", async () => {
    for (const [lang, t] of [["uz", uz], ["uzc", uzc]] as const) {
      const context = await e.newContext();
      const user = await e.signIn(context, { locale: lang });
      await createInvitation(user.id, { language: lang, data: { names: "Narx " + lang, intro: "none" } });
      const { page, problems, close } = await e.open("/app/", { context, waitText: "Narx " + lang });
      await toShare(page, t);
      const pay = sheet(page, "pay");
      await pay.locator('[data-price="personal"]').waitFor();
      await page.waitForTimeout(400);
      for (const key of ["shared", "personal"]) {
        // Название и цена в одной строке или цена под названием — но не поверх него.
        const boxes = await pay.locator(`[data-price="${key}"]`).evaluate((el) => {
          const r = (x: Element) => { const b = x.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
          return { price: r(el), title: r(el.previousElementSibling!), row: r(el.parentElement!) };
        });
        const overlap = boxes.price.l < boxes.title.r && boxes.title.l < boxes.price.r && boxes.price.t < boxes.title.b && boxes.title.t < boxes.price.b;
        expect(overlap, `${lang} ${key}: ${JSON.stringify(boxes)}`).toBe(false);
        expect(boxes.price.r).toBeLessThanOrEqual(boxes.row.r + 0.5);
      }
      // Суммы с пробелами в разрядах, как в боте и SMS (не «5,000 so‘m»); «Уже оплачено: N» не отрывает число.
      const P = await pricesFor(user.id);
      expect(await pay.locator('[data-price="personal"]').innerText()).toBe(t.perGuest.replace("{price}", await money(page, P.seat, "ru-RU", t.sum)));
      expect(await pay.innerText()).not.toMatch(/\d,\d{3}/);
      await pay.locator('[data-mode="personal"]').click();
      await expect.poll(async () => (await pay.textContent()) || "").toContain(t.paySeatsPaid.replace(" {n}", "\u00a00"));
      await e.shot(page, `pay-sheet-${lang}-390x844.png`);
      await e.expectClean(page, problems);
      await close();
    }
  });
});

describe("персональные приглашения", () => {
  it("места, гости списком, неоплаченные ссылки, «Докупить места» и личная ссылка гостя", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Нигора и Сардор", intro: "none" } });
    const P = await pricesFor(user.id);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Нигора и Сардор" });
    await toShare(page);
    const pay = sheet(page, "pay");
    await pay.locator('[data-mode="personal"]').click();
    // Мест 2: кнопка «−» до 2, сумма — 2 × цена места.
    const seats = pay.locator("input[name=seats]");
    await seats.fill("3");
    await pay.getByRole("button", { name: "−" }).click();
    expect(await seats.inputValue()).toBe("2");
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(await money(page, 2 * P.seat));
    await pay.locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    const [order] = await ordersOf(inv.id);
    expect(order).toMatchObject({ kind: "seats", quantity: 2, amount: 2 * P.seat });
    expect((await invOf(inv.id)).mode).toBe("personal");
    await page.locator('[data-mock="paid"]').click();
    await e.waitText(page, ru.linkReady);
    expect(await invOf(inv.id)).toMatchObject({ status: "active", paidSeats: 2 });
    // Персональное: общей ссылки, адреса и QR нет; список личных ссылок пуст.
    expect(await page.locator("input[name=slug]").count()).toBe(0);
    const links = page.locator("[data-personal-links]");
    await expect.poll(() => links.innerText()).toContain(ru.noGuests);
    // Мест больше, чем гостей: сколько свободно, а не «2 из 0».
    expect(await links.innerText()).toContain(ru.seatsLeft.replace("{paid}", "2").replace("{left}", "2"));
    await e.shot(page, "share-personal-empty-ru-390x844.png");

    // «Добавить гостей»: по гостю на строку, «Имя, телефон».
    await links.getByRole("button", { name: "+ " + ru.addGuests }).click();
    const add = sheet(page, "guests");
    await add.locator("textarea[name=guest-list]").fill("Анна Каримова, +998 90 111-22-33\nБобур\nСевара, 901112234");
    await expect.poll(() => add.locator('[data-add="list"]').innerText()).toContain("· 3");
    await e.shot(page, "add-guests-ru-390x844.png");
    await add.locator('[data-add="list"]').click();
    await expect.poll(async () => (await guestsOf(inv.id)).length).toBe(3);
    const list = await guestsOf(inv.id);
    expect(list.map((g) => [g.name, g.phone])).toEqual([["Анна Каримова", "998901112233"], ["Бобур", null], ["Севара", "998901112234"]]);
    await add.getByRole("button", { name: ru.close, exact: true }).click();
    await add.waitFor({ state: "detached" });
    // Ссылки гостей — настоящие /g/<token>; третий гость сверх оплаченных мест отмечен.
    await expect.poll(() => links.locator("[data-guest-link]").count()).toBe(3);
    expect(await links.locator('[data-guest-link="Бобур"]').innerText()).toContain(`${e.base.replace(/^https?:\/\//, "")}/g/${list[1]!.token}`);
    expect(await links.locator("[data-unpaid]").count()).toBe(1);
    expect(await links.locator('[data-guest-link="Севара"] [data-unpaid]').count()).toBe(1);
    expect(await links.innerText()).toContain(ru.seatsLine.replace("{paid}", "2").replace("{n}", "3"));
    await e.shot(page, "share-personal-ru-390x844.png");
    // Неоплаченная личная ссылка не открывается.
    const unpaid = await e.open(`/g/${list[2]!.token}`, { context, status: 404, waitText: ru.nfTitle });
    await unpaid.page.close();

    // «Докупить места»: одно место за неоплаченного гостя.
    await links.getByRole("button", { name: ru.buySeats }).click();
    await expect.poll(() => pay.locator("input[name=seats]").inputValue()).toBe("1");
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(await money(page, P.seat));
    expect(await pay.locator('[data-mode="shared"]').count()).toBe(0);
    await pay.locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await page.locator('[data-mock="paid"]').click();
    await e.waitText(page, ru.linkReady);
    await expect.poll(async () => (await invOf(inv.id)).paidSeats).toBe(3);
    await expect.poll(() => page.locator("[data-personal-links] [data-unpaid]").count()).toBe(0);

    // Личная ссылка гостя: конверт «Кому», имя в ответе, ответ уходит на /g/<token>/rsvp.
    const g = await e.open(`/g/${list[0]!.token}`, { context, waitText: "Нигора и Сардор" });
    expect(g.problems.requests.filter((u) => u.startsWith("/api/"))).toEqual([]);
    await waitContent(g.page, ru.personal.replace("{name}", "Анна"));
    await e.expectClean(g.page, g.problems);
    await g.page.close();
    expect(problems.console).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("страница гостя", () => {
  it("личная ссылка: конверт «Кому», ответ с QR для входа, ответ сохраняется; на узбекском", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { added } = await personalWith(user.id, [{ name: "Дильшод Рахимов", phone: "+998901234567" }], { data: { names: "Камола и Улугбек", showGuests: true } });
    const token = added[0]!.token as string;
    const { page, problems, close } = await e.open(`/g/${token}`, { waitText: "Камола и Улугбек" });
    // Конверт подписан гостю; открывается касанием.
    await e.waitText(page, "Дильшод Рахимов");
    await e.shot(page, "guest-personal-envelope-ru-390x844.png");
    await page.mouse.click(195, 420);
    await page.waitForTimeout(2800);
    await waitContent(page, ru.personal.replace("{name}", "Дильшод"));
    await page.locator("#rsvp").scrollIntoViewIfNeeded();
    // Имя не спрашивается: отвечает гость личной ссылки.
    expect(await page.locator("#rsvp").innerText()).toContain(ru.replying);
    expect(await page.locator(`#rsvp input[placeholder="${ru.yourName}"]`).count()).toBe(0);
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.locator("#rsvp").getByRole("button", { name: "+" }).click();
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await page.locator("[data-entry-qr]").waitFor();
    const [guest] = await e.db.select().from(guests).where(eq(guests.token, token));
    expect(guest).toMatchObject({ rsvp: "yes", plus: 1 });
    // QR для входа нарисован на странице: ссылка гостя /g/<token>.
    expect(await page.locator("[data-entry-qr] img").getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    // Бота нет (TELEGRAM_MODE=off): кнопки «Ответить через бота» нет.
    expect(await page.getByRole("button", { name: ru.viaBot }).count()).toBe(0);
    await page.locator("[data-entry-qr]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await e.shot(page, "guest-personal-ru-390x844.png");
    // После перезагрузки ответ на месте: из представления сервера.
    await page.reload();
    await e.waitText(page, "Камола и Улугбек");
    await page.mouse.click(195, 420);
    await page.waitForTimeout(2800);
    await e.waitText(page, ru.thanks);
    await page.locator("[data-entry-qr]").waitFor();
    // Язык меняет только просмотр гостя: ничего не сохраняется на сервере.
    const before = problems.requests.length;
    const lb = page.getByRole("button", { name: D.LANGS.find((l: Dict) => l.code === "ru").label, exact: true }).first();
    await lb.click();
    await expect.poll(() => page.locator("body").innerText()).not.toContain(ru.thanks);
    expect(problems.requests.slice(before).filter((u) => u.startsWith("/api/"))).toEqual([]);
    await e.expectClean(page, problems);
    await close();

    // Приглашение на узбекском: страница на языке приглашения.
    const uzInv = await personalWith(user.id, [{ name: "Jasur Karimov" }], { language: "uz", data: { names: "Malika va Jasur", intro: "none", showGuests: true } });
    const p2 = await e.open(`/g/${uzInv.added[0]!.token}`, { waitText: "Malika va Jasur" });
    await waitContent(p2.page, uz.personal.replace("{name}", "Jasur"));
    await p2.page.waitForTimeout(600);
    await e.shot(p2.page, "guest-personal-uz-390x844.png");
    await p2.page.locator("#rsvp").scrollIntoViewIfNeeded();
    await p2.page.locator("#rsvp").getByRole("button", { name: uz.no }).click();
    await p2.page.locator("#rsvp").getByRole("button", { name: uz.send }).click();
    await e.waitText(p2.page, uz.thanks);
    // На «нет» QR для входа не нужен.
    expect(await p2.page.locator("[data-entry-qr]").count()).toBe(0);
    expect((await guestsOf(uzInv.inv.id))[0]!.rsvp).toBe("no");
    await p2.page.waitForTimeout(800);
    await e.shot(p2.page, "guest-personal-uz-answered-390x844.png");
    await e.expectClean(p2.page, p2.problems);
    await p2.close();
  });

  it("общая ссылка: ответ с именем, токен гостя в браузере, смена ответа; «кто придёт» и гостевая книга", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Зарина и Акмаль", intro: "none", showGuests: true } });
    await activate(inv.id, { unlocked: true });
    const slug = inv.slug as string;
    // Другой гость уже ответил и оставил пожелание.
    const r0 = await e.app.inject({ method: "POST", url: `/api/public/i/${slug}/rsvp`, headers: { origin: e.base }, payload: { name: "Феруза Алиева", status: "yes", count: 2, diet: [], msg: "Счастья вам!" } });
    expect(r0.statusCode).toBe(200);
    const { page, problems, close } = await e.open(`/i/${slug}`, { waitText: "Зарина и Акмаль" });
    expect(await page.locator("body").innerText()).toContain("Счастья вам!");
    expect(await page.locator("body").innerText()).toContain("Феруза А.");
    await page.locator("#rsvp").scrollIntoViewIfNeeded();
    await page.locator(`#rsvp input[placeholder="${ru.yourName}"]`).fill("Отабек Юсупов");
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.locator("#rsvp").locator("textarea").fill("Обязательно будем!");
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    await expect.poll(async () => (await guestsOf(inv.id)).length).toBe(2);
    const mine = (await guestsOf(inv.id)).find((g) => g.name === "Отабек Юсупов")!;
    expect(mine).toMatchObject({ rsvp: "yes", source: "self", message: "Обязательно будем!" });
    const saved = await page.evaluate((s) => JSON.parse(localStorage.getItem("invito.rsvp." + s) || "null"), slug);
    expect(saved.token).toBe(mine.token);
    // После ответа: «кто придёт» с отметкой «вы», пожелание в гостевой книге, QR для входа.
    await expect.poll(() => page.locator("body").innerText()).toContain("Отабек Ю. (" + ru.you + ")");
    await expect.poll(() => page.locator("body").innerText()).toContain("Обязательно будем!");
    await page.locator("[data-entry-qr]").waitFor();
    await page.locator("[data-entry-qr]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await e.shot(page, "guest-shared-ru-390x844.png");
    // Ответ можно изменить: тот же гость (guestToken), не новый.
    await page.reload();
    await e.waitText(page, ru.thanks);
    await page.getByRole("button", { name: ru.change }).click();
    await page.locator("#rsvp").getByRole("button", { name: ru.maybe }).click();
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await expect.poll(async () => (await guestsOf(inv.id)).find((g) => g.id === mine.id)!.rsvp).toBe("maybe");
    expect(await guestsOf(inv.id)).toHaveLength(2);
    await e.expectClean(page, problems);
    // Кнопка «Создать своё» ведёт в приложение.
    await page.getByRole("button", { name: ru.makeOwn + " →" }).click();
    await page.waitForURL(e.base + "/app/");
    await close();

    // Общая ссылка на узбекском.
    const uzInv = await createInvitation(user.id, { language: "uz", data: { names: "Dilnoza va Bobur", intro: "none", showGuests: true } });
    await activate(uzInv.id, { unlocked: true });
    const p2 = await e.open(`/i/${uzInv.slug}`, { locale: "ru-RU", waitText: "Dilnoza va Bobur" });
    await waitContent(p2.page, uz.youreInvited);
    await p2.page.waitForTimeout(600);
    await e.shot(p2.page, "guest-shared-uz-390x844.png");
    await p2.page.locator("#rsvp").scrollIntoViewIfNeeded();
    await p2.page.waitForTimeout(600);
    await e.shot(p2.page, "guest-shared-uz-rsvp-390x844.png");
    await e.expectClean(p2.page, p2.problems);
    await p2.close();
  });

  it("приглашение без даты и программы: на странице только то, что сохранил владелец", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    // Так выглядят старые приглашения после миграции 0004: даты нет, остальное — имена, место и текст.
    const inv = await createInvitation(user.id, { data: { names: "Олег и Ира", host: "Семья", venue: "Кафе «Ромашка»", address: "ул. Навои, 1", message: "Ждём вас!", intro: "none" } });
    await activate(inv.id, { unlocked: true });
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { waitText: "Олег и Ира" });
    await page.locator("#rsvp").scrollIntoViewIfNeeded();
    const body = await page.locator("body").innerText();
    const W = D.EVENTS.wedding, L = W.text.ru;
    // Ни выдуманной даты, ни программы, ни телефона, ни дресс-кода, подарков и «Ответьте до».
    for (const made of [L.contact, L.dress, L.gifts, L.notes, ...W.program.map((x: Dict) => x.ru), ru.replyBy]) expect(body).not.toContain(made);
    expect(body).not.toMatch(/\d{4} г\./);
    expect(body).not.toMatch(/^\s*·|·\s*$/m);
    for (const own of ["Кафе «Ромашка»", "ул. Навои, 1", "Ждём вас!"]) expect(body).toContain(own);
    // Мета-теги «Поделиться» совпадают с теми, что отдаёт сервер: без даты и без выдуманного описания.
    const html = (await e.app.inject({ method: "GET", url: `/i/${inv.slug}` })).body;
    expect(html).toContain('<meta property="og:title" content="Олег и Ира">');
    await page.waitForTimeout(400);
    await e.shot(page, "guest-legacy-nodate-ru-390x844.png");
    // Ответ: кнопки «В календарь» без даты нет.
    await page.locator(`#rsvp input[placeholder="${ru.yourName}"]`).fill("Гость");
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    expect(await page.getByRole("button", { name: ru.addCal }).count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("календарь (.ics) — время события по Ташкенту, где бы ни был гость", async () => {
    const context = await e.newContext({ timezoneId: "America/New_York" });
    const user = await e.signIn(context);
    const { added } = await personalWith(user.id, [{ name: "Гость Нью-Йорк" }], { data: { names: "Календарь тест", date: "2026-12-26", time: "17:00", intro: "none" } });
    const { page, problems, close } = await e.open(`/g/${added[0]!.token}`, { context, waitText: "Календарь тест" });
    // Дата на странице — по календарю события, не гостя.
    await e.waitText(page, "26 декабря 2026 г.");
    await page.locator("#rsvp").scrollIntoViewIfNeeded();
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ru.addCal }).click()]);
    const ics = Buffer.concat((await (await download.createReadStream()).toArray()) as Buffer[]).toString("utf8");
    // 17:00 в Ташкенте (UTC+5) — 12:00 UTC, а не 17:00 по Нью-Йорку.
    expect(ics).toContain("DTSTART:20261226T120000Z");
    expect(ics).toContain("DTEND:20261226T160000Z");
    await e.expectClean(page, problems);
    await close();
  });

  it("даты на всех языках: страница гостя и мета-теги «Поделиться» как у сервера", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    // Ожидаемая длинная дата: так её пишет сервер (Intl Node) — Chromium узбекских месяцев не знает.
    const want: Record<string, [Dict, string]> = { ru: [ru, "26 декабря 2026 г."], uz: [uz, "26-dekabr, 2026"], uzc: [uzc, "26 декабр, 2026"], en: [en, "26 December 2026"] };
    for (const [lang, [t, date]] of Object.entries(want)) {
      const names = { ru: "Анна и Тимур", uz: "Malika va Jasur", uzc: "Малика ва Жасур", en: "Anna and Tim" }[lang]!;
      const inv = await createInvitation(user.id, { language: lang, data: { names, date: "2026-12-26", time: "17:00", intro: "none", message: "♥" } });
      await activate(inv.id, { unlocked: true });
      const html = (await e.app.inject({ method: "GET", url: `/i/${inv.slug}` })).body;
      expect(html).toContain(`<meta property="og:title" content="${names} — ${date}">`);
      const g = await e.open(`/i/${inv.slug}`, { locale: "ru-RU", waitText: names });
      await waitContent(g.page, t.youreInvited);
      await e.waitText(g.page, date);
      expect(await g.page.locator("body").innerText()).not.toMatch(/M12/);
      await g.page.waitForTimeout(600);
      await e.shot(g.page, `guest-shared-${lang}-390x844.png`);
      await g.page.locator("#rsvp").scrollIntoViewIfNeeded();
      await g.page.waitForTimeout(600);
      await e.shot(g.page, `guest-shared-${lang}-rsvp-390x844.png`);
      await e.expectClean(g.page, g.problems);
      await g.page.close();
    }
    // «Поделиться» узбекского приглашения: og:title тот же, что у сервера.
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Malika va Jasur" });
    await page.locator("#my-inv [data-rv]").filter({ hasText: "Malika va Jasur" }).getByRole("button", { name: ru.edit }).click();
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: ru.toEditor + " →" }).click();
    await page.getByRole("button", { name: new RegExp("^" + ru.toShare) }).first().click();
    await e.waitText(page, ru.linkReady);
    await expect.poll(() => page.locator("pre").innerText()).toContain('<meta property="og:title" content="Malika va Jasur — 26-dekabr, 2026">');
    // Превью ссылки — тоже на языке приглашения (интерфейс здесь русский).
    const og = page.locator('img[src^="data:image"]:not([data-qr]):not([alt="QR"])').first();
    await og.waitFor();
    await og.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await e.shot(page, "share-og-uz-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("пароль: страница закрыта, неверный пароль, верный открывает, ответ уходит с паролем", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Секрет тест", intro: "none" } });
    await activate(inv.id, { unlocked: true, accessCode: "tulip-26" });
    const slug = inv.slug as string;
    const locked = await e.open(`/i/${slug}`, { waitText: ru.unlock });
    // До пароля содержимого на странице нет.
    expect(await locked.page.locator("body").innerText()).not.toContain("Секрет тест");
    await e.shot(locked.page, "guest-locked-ru-390x844.png");
    await locked.page.locator(`input[type=password]`).fill("wrong");
    await locked.page.getByRole("button", { name: ru.unlock }).click();
    await locked.page.waitForURL(`${e.base}/i/${slug}?code=wrong`);
    await e.waitText(locked.page, ru.unlock);
    expect(await locked.page.locator("body").innerText()).not.toContain("Секрет тест");
    expect(await locked.page.getByRole("alert").innerText()).toBe(ru.wrongPw);
    await locked.page.locator(`input[type=password]`).fill("tulip-26");
    await locked.page.getByRole("button", { name: ru.unlock }).click();
    await e.waitText(locked.page, "Секрет тест");
    // Пароль подошёл: из адреса он убран (ссылку копируют дальше), а ответ гостя всё равно уходит с ним.
    expect(locked.page.url()).toBe(`${e.base}/i/${slug}`);
    await locked.page.locator("#rsvp").scrollIntoViewIfNeeded();
    await locked.page.locator(`#rsvp input[placeholder="${ru.yourName}"]`).fill("Гость с паролем");
    await locked.page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await locked.page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await e.waitText(locked.page, ru.thanks);
    expect((await guestsOf(inv.id)).map((g) => g.name)).toEqual(["Гость с паролем"]);
    await e.expectClean(locked.page, locked.problems);
    await locked.close();

    // Попытки кончились (10 неверных за минуту): верный пароль не проходит, и форма говорит именно это.
    for (let i = 0; i < 10; i++) await e.app.inject({ method: "GET", url: `/api/public/i/${slug}?code=nope-${i}` });
    const limited = await e.open(`/i/${slug}?code=tulip-26`, { status: 429, waitText: ru.unlock });
    expect(await limited.page.getByRole("alert").innerText()).toBe(ru.tooManyPw);
    expect(await limited.page.locator("body").innerText()).not.toContain("Секрет тест");
    expect(limited.problems.console).toEqual([failed(429, "Too Many Requests")]);
    limited.problems.console = [];
    await e.expectClean(limited.page, limited.problems);
    await limited.close();
    await e.redis.flushdb();

    // Приглашение на узбекском: форма пароля на языке приглашения, а не браузера.
    const uzInv = await createInvitation(user.id, { language: "uz", data: { names: "Sir tekshiruv", intro: "none" } });
    await activate(uzInv.id, { unlocked: true, accessCode: "lola" });
    const uzLocked = await e.open(`/i/${uzInv.slug}`, { locale: "ru-RU", waitText: uz.unlock });
    expect(await uzLocked.page.evaluate(() => document.documentElement.lang)).toBe("uz-Latn");
    expect(await uzLocked.page.locator("body").innerText()).not.toContain(ru.unlock);
    await e.shot(uzLocked.page, "guest-locked-uz-390x844.png");
    await e.expectClean(uzLocked.page, uzLocked.problems);
    await uzLocked.close();
  });
});

describe("«Поделиться»", () => {
  it("адрес ссылки с проверкой, занятый адрес, QR в браузере, пароль и мета-теги", async () => {
    const context = await e.newContext();
    const all = allRequests(context);
    const user = await e.signIn(context);
    // Чужой адрес занят приглашением, созданным раньше (в «Моих приглашениях» оно ниже).
    const other = await createInvitation(user.id, { data: { names: "Занято" } });
    const taken = "zanyato-" + other.slug;
    await e.db.update(invitations).set({ slug: taken }).where(eq(invitations.id, other.id));
    const inv = await createInvitation(user.id, { data: { names: "Шахзода и Анвар", intro: "none", message: "Ждём вас на нашей свадьбе!" } });
    await activate(inv.id, { unlocked: true });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Шахзода и Анвар" });
    await toShare(page);
    await e.waitText(page, ru.linkReady);
    const slugIn = page.locator("input[name=slug]");
    expect(await slugIn.inputValue()).toBe(inv.slug);
    // QR — PNG из canvas страницы, без внешних сервисов.
    await expect.poll(() => page.locator('img[data-qr="share"]').getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(all.filter((u) => u.includes("qrserver"))).toEqual([]);
    // Неверный формат — подсказка сразу, запроса нет.
    await slugIn.fill("ab");
    await e.waitText(page, ru.slugBad);
    // Занятый адрес — текст сервера.
    await slugIn.fill(taken);
    await e.waitText(page, "Эта ссылка уже занята");
    // Свободный — сохраняется, ссылка и мета-теги меняются.
    const fresh = "shahzoda-" + inv.slug;
    await slugIn.fill(fresh);
    await expect.poll(async () => (await invOf(inv.id)).slug, { timeout: 10_000 }).toBe(fresh);
    await expect.poll(() => page.locator("pre").innerText()).toContain(`${e.base}/i/${fresh}`);
    expect(await page.locator("pre").innerText()).toContain("Ждём вас на нашей свадьбе!");
    expect(await page.locator("pre").innerText()).not.toContain("invito.app");
    // Пароль страницы: включение и ввод сохраняют accessCode.
    await page.getByRole("button", { name: new RegExp("^" + ru.pw) }).click();
    await page.locator("input[name=access-code]").fill("2026");
    await e.waitText(page, ru.pwSaved);
    expect((await invOf(inv.id)).accessCode).toBe("2026");
    // Пустое поле не снимает пароль: после ухода из поля в нём снова сохранённый (снимает переключатель).
    await page.locator("input[name=access-code]").fill("");
    await slugIn.click();
    await expect.poll(() => page.locator("input[name=access-code]").inputValue()).toBe("2026");
    expect((await invOf(inv.id)).accessCode).toBe("2026");
    await page.waitForTimeout(400);
    await e.shot(page, "share-shared-ru-390x844.png");
    await page.getByRole("button", { name: new RegExp("^" + ru.pw) }).click();
    await e.waitText(page, ru.pwRemoved);
    expect((await invOf(inv.id)).accessCode).toBeNull();
    // Новая ссылка открывается, старая — нет.
    const live = await e.open(`/i/${fresh}`, { waitText: "Шахзода и Анвар" });
    await e.expectClean(live.page, live.problems);
    await live.close();
    expect(all.filter((u) => u.includes("qrserver"))).toEqual([]);
    expect(problems.console).toEqual([failed(409, "Conflict")]);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("на широком экране", async () => {
    const context = await e.newContext({ viewport: { width: 1280, height: 800 } });
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Широкий экран", intro: "none" } });
    await activate(inv.id, { unlocked: true });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Широкий экран" });
    await toShare(page);
    await e.waitText(page, ru.linkReady);
    await page.waitForTimeout(800);
    await e.shot(page, "share-shared-ru-1280x800.png");
    await page.getByRole("button", { name: ru.guests, exact: true }).first().click();
    await e.waitText(page, ru.guestList);
    await page.waitForTimeout(600);
    await e.shot(page, "manage-list-ru-1280x800.png");
    await e.expectClean(page, problems);
    await close();
  });
});

describe("экран гостей", () => {
  it("список, SMS через тестовый провайдер, столы, ручной чек-ин, активность и бот", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { inv, added } = await personalWith(user.id, [
      { name: "Азиза Саидова", phone: "+998901000001", group: "family" },
      { name: "Рустам Ахмедов", phone: "+998901000002" },
      { name: "Ойбек Наримов" },
    ], { data: { names: "Гости тест", intro: "none" } });
    // Ответ одного гостя: «да» с +1.
    const r = await e.app.inject({ method: "POST", url: `/api/public/g/${added[0]!.token}/rsvp`, headers: { origin: e.base }, payload: { status: "yes", count: 2, diet: [], msg: "" } });
    expect(r.statusCode).toBe(200);
    const [tpl] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    await e.db.update(templates).set({ smsEnabled: true }).where(eq(templates.id, tpl!.id));
    try {
      const { page, problems, close } = await e.open("/app/", { context, waitText: "Гости тест" });
      await toManage(page);
      const row = (name: string) => page.locator(`[data-guest="${name}"]`);
      await row("Азиза Саидова").waitFor();
      // Номер переносится только между группами: неразрывный пробел после +998 и неразрывные дефисы.
      expect(await row("Азиза Саидова").textContent()).toContain("+998\u00a090 100\u201100\u201101");
      expect(await page.locator("[data-guest]").count()).toBe(3);
      // SMS одному гостю, затем всем: у гостя без телефона — причина пропуска.
      const sent0 = e.sms.length;
      await row("Рустам Ахмедов").getByRole("button", { name: "✉ " + ru.smsOne }).click();
      await e.waitText(page, ru.smsSent.replace("{n}", "1"));
      await expect.poll(() => row("Рустам Ахмедов").locator("[data-sms]").getAttribute("data-sms")).toMatch(/^(queued|sent|delivered)$/);
      expect(e.sms.slice(sent0).map((m) => m.phone)).toEqual(["998901000002"]);
      expect(e.sms[e.sms.length - 1]!.text).toContain(`${e.base}/g/${added[1]!.token}`);
      // «SMS всем» отправляет только после подтверждения: получатель один (у Рустама SMS уже есть, у Ойбека нет телефона).
      const confirm = sheet(page, "confirm");
      await page.getByRole("button", { name: "✉ " + ru.smsAll }).click();
      await confirm.waitFor();
      expect(await confirm.innerText()).toContain(ru.smsAllQ.replace("{n}", "1"));
      await e.shot(page, "confirm-sms-ru-390x844.png");
      expect(e.sms.slice(sent0)).toHaveLength(1);
      await confirm.getByRole("button", { name: ru.sendNow }).click();
      await e.waitText(page, ru.skip.no_phone);
      expect(e.sms.slice(sent0).map((m) => m.phone).sort()).toEqual(["998901000001", "998901000002"]);
      await expect.poll(() => page.locator("[data-guest] [data-sms]").count()).toBe(2);
      // «Напомнить ожидающим»: подтверждение с числом ждущих ответа; «Отмена» ничего не отправляет.
      const sent1 = e.sms.length;
      await page.getByRole("button", { name: new RegExp("^" + ru.remind + " · ") }).click();
      await confirm.waitFor();
      expect(await confirm.innerText()).toContain(ru.remindQ.replace("{n}", "2"));
      await confirm.getByRole("button", { name: ru.cancel }).click();
      await confirm.waitFor({ state: "detached" });
      expect(e.sms.length).toBe(sent1);
      await page.getByRole("button", { name: new RegExp("^" + ru.remind + " · ") }).click();
      await confirm.getByRole("button", { name: ru.sendNow }).click();
      // Бота нет (TELEGRAM_MODE=off): напоминание уходит по SMS тому, у кого есть телефон.
      await e.waitText(page, ru.remindDone.replace("{tg}", "0").replace("{sms}", "1"));
      expect(e.sms.slice(sent1).map((m) => m.phone)).toEqual(["998901000002"]);
      // Группа гостя — PATCH.
      await row("Рустам Ахмедов").locator("select").first().selectOption("work");
      await expect.poll(async () => (await guestsOf(inv.id)).find((g) => g.name === "Рустам Ахмедов")!.group).toBe("work");
      await page.waitForTimeout(500);
      await e.shot(page, "manage-list-ru-390x844.png");

      // Рассадка: число столов из settings.tables, кнопки «−» и «+».
      await tab(page, ru.seating).click();
      const n0 = Number(await page.locator("[data-tables]").innerText());
      await page.getByRole("button", { name: "+", exact: true }).first().click();
      await expect.poll(async () => (await invOf(inv.id)).settings.tables).toBe(n0 + 1);
      await expect.poll(() => page.locator("[data-tables]").innerText()).toBe(String(n0 + 1));
      await page.locator("[data-rv]").last().scrollIntoViewIfNeeded();
      await page.locator("[data-tables]").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await e.shot(page, "manage-seat-ru-390x844.png");
      // Стол гостя из списка — PATCH tableNo.
      await tab(page, ru.guestList).click();
      await row("Азиза Саидова").locator("select").last().selectOption(String(n0 + 1));
      await expect.poll(async () => (await guestsOf(inv.id)).find((g) => g.name === "Азиза Саидова")!.tableNo).toBe(n0 + 1);

      // Чек-ин: ручная отметка по ссылке гостя; неверный код — подсказка.
      await tab(page, ru.checkin).click();
      const manual = page.locator("input[name=checkin]");
      await manual.fill("не ссылка");
      await page.getByRole("button", { name: ru.checkIn, exact: true }).first().click();
      await e.waitText(page, ru.manualBad);
      await manual.fill(`${e.base}/g/${added[2]!.token}`);
      await manual.press("Enter");
      await expect.poll(async () => (await guestsOf(inv.id)).find((g) => g.name === "Ойбек Наримов")!.checkedInAt).not.toBeNull();
      await expect.poll(() => manual.inputValue()).toBe("");
      // Отметка из списка ответивших «да».
      await page.getByRole("button", { name: ru.checkIn, exact: true }).last().click();
      await expect.poll(async () => (await guestsOf(inv.id)).find((g) => g.name === "Азиза Саидова")!.checkedInAt).not.toBeNull();
      await page.waitForTimeout(500);
      await e.shot(page, "manage-checkin-ru-390x844.png");

      // Активность — события сервера.
      await tab(page, ru.activity).click();
      await expect.poll(() => page.locator("body").innerText()).toContain(ru.act.checkin.replace("{name}", "Ойбек Наримов"));
      expect(await page.locator("body").innerText()).toContain(ru.act.yes.replace("{name}", "Азиза Саидова"));
      await page.waitForTimeout(800);
      await e.shot(page, "manage-activity-ru-390x844.png");

      // Бот: переключатели — PATCH settings; без Telegram — подсказка и ответ сервера на тест.
      await tab(page, ru.bot).click();
      await e.waitText(page, ru.botTg);
      await page.getByRole("button", { name: new RegExp("^" + ru.botT.r3h) }).click();
      await expect.poll(async () => (await invOf(inv.id)).settings.r3h).toBe(false);
      await page.getByRole("button", { name: ru.botT.test }).click();
      await e.waitText(page, "Подключите Telegram, чтобы получать уведомления");
      await page.waitForTimeout(400);
      await e.shot(page, "manage-bot-ru-390x844.png");

      // CSV с телефонами и ссылками.
      await tab(page, ru.guestList).click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ru.csv + " ↓" }).click()]);
      const csv = await (await download.createReadStream()).toArray();
      const text = Buffer.concat(csv as Buffer[]).toString("utf8");
      expect(text).toContain("name,phone,status,plus_ones,group,table,checked_in,paid,link");
      expect(text).toContain(`Азиза Саидова,+998901000001,yes,1,family,${n0 + 1},yes,yes,${e.base}/g/${added[0]!.token}`);
      // Удаление гостя с подтверждением.
      await row("Ойбек Наримов").getByRole("button", { name: ru.removeG }).click();
      await sheet(page, "confirm").getByRole("button", { name: ru.removeG }).click();
      await expect.poll(async () => (await guestsOf(inv.id)).length).toBe(2);
      expect(problems.console).toEqual([failed(409, "Conflict")]);
      problems.console = [];
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ smsEnabled: tpl!.smsEnabled }).where(eq(templates.id, tpl!.id));
    }
  });

  it("удалённый гость освобождает место: отметки «не оплачено» перечитываются с сервера", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    // Три гостя на два места: третий без места.
    await personalWith(user.id, [{ name: "Гость Один" }, { name: "Гость Два" }, { name: "Гость Три" }], { data: { names: "Места тест", intro: "none" } }, 2);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Места тест" });
    await toManage(page);
    const row = (name: string) => page.locator(`[data-guest="${name}"]`);
    await expect.poll(() => row("Гость Три").locator("[data-unpaid]").count()).toBe(1);
    await row("Гость Один").getByRole("button", { name: ru.removeG }).click();
    await sheet(page, "confirm").getByRole("button", { name: ru.removeG }).click();
    await expect.poll(() => row("Гость Один").count()).toBe(0);
    // Место первого гостя перешло третьему: строка без отметки, как на сервере.
    await expect.poll(() => row("Гость Три").locator("[data-unpaid]").count()).toBe(0);
    expect(await page.locator("[data-guest] [data-unpaid]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("общее приглашение: пустой список с подсказкой, ответы по ссылке, CSV без формул", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Ответы тест", intro: "none" } });
    await activate(inv.id, { unlocked: true });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Ответы тест" });
    await toManage(page);
    // Ответов нет: подсказка, откуда возьмутся гости.
    await page.locator('[data-empty="replies"]').waitFor();
    expect(await page.locator('[data-empty="replies"]').innerText()).toBe(ru.noReplies);
    await page.waitForTimeout(400);
    await e.shot(page, "manage-list-shared-empty-ru-390x844.png");
    // Имя пишет гость: значение, похожее на формулу, в CSV начинается с апострофа.
    for (const name of ['=HYPERLINK("https://evil.example";"x")', "@SUM(A1)", "-2+3"]) {
      const r = await e.app.inject({ method: "POST", url: `/api/public/i/${inv.slug}/rsvp`, headers: { origin: e.base }, payload: { name, status: "yes", count: 1, diet: [], msg: "" } });
      expect(r.statusCode).toBe(200);
    }
    await page.reload();
    await e.waitText(page, "Ответы тест");
    await toManage(page);
    await expect.poll(() => page.locator("[data-guest]").count()).toBe(3);
    expect(await page.locator('[data-empty="replies"]').count()).toBe(0);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ru.csv + " ↓" }).click()]);
    const text = Buffer.concat((await (await download.createReadStream()).toArray()) as Buffer[]).toString("utf8");
    const names = text.replace(/^\ufeff/, "").split("\n").slice(1).map((l) => (l.startsWith('"') ? l.slice(0, l.indexOf('",') + 1) : l.split(",")[0]));
    expect(names.sort()).toEqual(['"\'=HYPERLINK(""https://evil.example"";""x"")"', "'-2+3", "'@SUM(A1)"]);
    await e.expectClean(page, problems);
    await close();
  });

  it("общее приглашение: «Добавить гостей» предлагает перейти на персональные", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Переход тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Переход тест" });
    await toManage(page);
    await page.getByRole("button", { name: "+ " + ru.addGuests }).click();
    const add = sheet(page, "guests");
    await add.waitFor();
    expect(await add.innerText()).toContain(ru.addShared);
    await add.getByRole("button", { name: new RegExp("^" + ru.toPersonal) }).click();
    await add.locator("input[name=guest-name]").waitFor();
    expect((await invOf(inv.id)).mode).toBe("personal");
    await add.locator("input[name=guest-name]").fill("Малика");
    await add.locator("input[name=guest-phone]").fill("90 555-44-33");
    await add.locator('[data-add="one"]').click();
    await expect.poll(async () => (await guestsOf(inv.id)).map((g) => [g.name, g.phone])).toEqual([["Малика", "998905554433"]]);
    await expect.poll(() => page.locator('[data-guest="Малика"]').count()).toBe(1);
    // Черновик без оплаты: место не оплачено.
    expect(await page.locator('[data-guest="Малика"] [data-unpaid]').count()).toBe(1);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("мини-апп Telegram", () => {
  it("тестовая оплата открывается внутри мини-аппа, внешних ссылок нет", async () => {
    const tgId = 7_200_000_000 + Math.floor(Math.random() * 1e6);
    const [user] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Тимур", locale: "ru" }).returning();
    const inv = await createInvitation(user!.id, { data: { names: "Телеграм тест", intro: "none" } });
    const context = await e.newContext();
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify({ id: tgId, first_name: "Тимур" }) });
    // Telegram.WebApp: ссылки, которые мини-апп открыл бы через Telegram, записываются в window.__links.
    await context.addInitScript((initData) => {
      const links: string[] = [];
      const nop = () => {};
      (window as any).__links = links;
      (window as any).Telegram = { WebApp: { initData, initDataUnsafe: {}, version: "8.0", platform: "ios", colorScheme: "light", themeParams: {}, ready: nop, expand: nop, close: nop, openLink: (u: string) => links.push(u), openTelegramLink: (u: string) => links.push(u), MainButton: { setText: nop, show: nop, hide: nop, onClick: (fn: () => void) => { (window as any).__main = fn; } }, BackButton: { show: nop, hide: nop, onClick: nop } } };
    }, initData);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Телеграм тест" });
    await toShare(page, ru, true);
    await sheet(page, "pay").locator('[data-pay="go"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    const [order] = await ordersOf(inv.id);
    // Без ухода со страницы: адрес тестовой оплаты требует cookie, которой нет во внешнем браузере Telegram.
    expect(page.url()).toBe(`${e.base}/app/#/mock-pay/${order!.id}`);
    expect(problems.requests).not.toContain(`/api/payments/mock/checkout/${order!.id}`);
    expect(await page.evaluate(() => (window as any).__links)).toEqual([]);
    await e.shot(page, "tg-mock-pay-ru-390x844.png");
    await page.locator('[data-mock="paid"]').click();
    await e.waitText(page, ru.linkReady);
    expect((await invOf(inv.id)).status).toBe("active");
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });
});
