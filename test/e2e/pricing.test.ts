import { and, eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, orders, subscriptions, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Экран цен (#/pricing) и покупка подписки с него, «Купить шаблон» на экране шаблонов и в предпросмотре,
 * экран ожидания оплаты, лист оплаты (подписка, места) — в браузере вместе с API. Оплата — тестовый
 * провайдер (mock), цены — из ответов сервера.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const D = INVITO as Dict;
let e: E2E;

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.close();
});

beforeEach(async () => {
  await e.redis.flushdb();
});

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const pricing = (page: Page) => page.locator('[data-screen="pricing"]');
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}

const createInvitation = (userId: string, body: Dict) => apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
const invOf = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const invsOf = (userId: string) => e.db.select().from(invitations).where(eq(invitations.userId, userId));
const ordersOfUser = (userId: string) => e.db.select().from(orders).where(eq(orders.userId, userId)).orderBy(orders.createdAt);

/** Общие цены сервера и цена шаблона. */
async function pricesFor(userId: string, template = "wedding-classic") {
  const me = await apiAs(userId, "GET", "/api/auth/me");
  const [tpl] = await e.db.select().from(templates).where(eq(templates.slug, template));
  return { ...(me.prices as { sharedTemplate: number; seat: number; subscriptionMonth: number }), template: tpl!.price ?? me.prices.sharedTemplate };
}

/** Сумма так, как её пишет приложение. */
const money = (page: Page, amount: number, sum: string = ru.sum) =>
  page.evaluate(([a, c]) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format((a as number) / 100) + " " + c, [amount, sum]);
const plan = (m: number, t: Dict = ru, lang = "ru") => m + " " + D.plural(lang, m, t.monthsN);

/** Вход по номеру в открытом листе входа: код — из SMS тестового провайдера. */
async function smsLogin(page: Page, phone: string) {
  await page.locator("input[name=phone]").fill(phone.slice(3));
  await sheet(page, "login").getByRole("button", { name: ru.getCode }).click();
  await page.locator("input[name=code]").waitFor();
  await page.locator("input[name=code]").fill(e.lastCode(phone)!);
  await sheet(page, "login").waitFor({ state: "detached" });
}

/** Главная → «Создать приглашение» → «Свадьба» → экран шаблонов. */
async function toTemplates(page: Page, t: Dict = ru, lang = "ru") {
  await page.getByRole("button", { name: t.create }).first().click();
  await e.waitText(page, t.chooseEvent);
  await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label[lang] }).first().click();
  await page.locator('[data-buy="tpl"]').first().waitFor();
}

/** Предпросмотр: заставка (конверт) закрывает кнопки, пока её не открыли. */
async function previewOf(page: Page, t: Dict = ru) {
  await page.getByRole("button", { name: t.preview }).click();
  const use = page.getByRole("button", { name: t.useTpl + " →" });
  await use.waitFor();
  await expect.poll(async () => {
    try { await use.click({ trial: true, timeout: 400 }); return true; } catch { const v = page.viewportSize()!; await page.mouse.click(v.width / 2, v.height / 2); return false; }
  }, { timeout: 15_000 }).toBe(true);
}

/** Конструктор открыт: шаги с подписями. */
const builder = (page: Page) => page.getByTitle(ru.stepsX.sections).waitFor();

describe("экран цен", () => {
  it("цены сервера: общая ссылка «от» самой низкой цены шаблона, место, сроки 1–12 месяцев, что входит, вопросы", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Азиз" });
    const P = await pricesFor(user.id);
    // У одного шаблона своя цена — дороже общей: общая ссылка «от» самой низкой.
    const [luxe] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-luxe"));
    await e.db.update(templates).set({ price: P.sharedTemplate + 3_000_000 }).where(eq(templates.id, luxe!.id));
    try {
      const { page, problems, close } = await e.open("/app/#/pricing", { context });
      const scr = pricing(page);
      await scr.waitFor();
      expect(await scr.innerText()).toContain(ru.pricingTitle);
      await expect.poll(() => scr.locator('[data-price="shared"]').innerText()).toBe(ru.fromPrice.replace("{price}", await money(page, P.sharedTemplate)));
      expect(await scr.locator('[data-price-card="shared"]').innerText()).toContain(ru.tplDiff);
      expect(await scr.locator('[data-price="personal"]').innerText()).toBe(await money(page, P.seat));
      expect(await scr.locator('[data-price-card="personal"]').innerText()).toContain(ru.payPersonalFree);
      expect(await scr.locator('[data-price-card="personal"]').innerText()).toContain(ru.priceEx.replace("{price}", await money(page, 100 * P.seat)));
      // Сроки: сумма, срок словами, цена месяца; выбран месяц.
      for (const m of [1, 3, 6, 12]) {
        const tile = scr.locator(`[data-plan="${m}"]`);
        expect(await scr.locator(`[data-plan-price="${m}"]`).innerText()).toBe(await money(page, m * P.subscriptionMonth));
        expect(await tile.innerText()).toContain(plan(m).toUpperCase());
        expect(await tile.innerText()).toContain(ru.perMonth.replace("{price}", await money(page, P.subscriptionMonth)));
        expect(await tile.locator(`[data-buy-sub="${m}"]`).innerText()).toBe(ru.subBuy);
      }
      expect(await scr.locator('[data-plan="1"]').getAttribute("aria-pressed")).toBe("true");
      // Что входит и что нет: места персональных приглашений — отдельно.
      const incl = scr.locator("[data-sub-incl]");
      expect(await incl.locator('[data-incl="in"]').count()).toBe(ru.subIncl.length);
      expect(await incl.locator('[data-incl="out"]').innerText()).toContain(ru.subExcl.replace("{price}", await money(page, P.seat)));
      expect(await scr.locator('[data-sub-state="none"]').innerText()).toContain(ru.subNone);
      // Вопросы раскрываются по одному.
      expect(await scr.locator("[data-faq-a]").count()).toBe(0);
      await scr.locator('[data-faq-q="1"]').click();
      expect(await scr.locator('[data-faq-a="1"]').innerText()).toBe(ru.pricingFaq[1][1]);
      await scr.locator('[data-faq-q="2"]').click();
      expect(await scr.locator("[data-faq-a]").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await scr.locator('[data-plan="3"]').click();
      expect(await scr.locator('[data-plan="3"]').getAttribute("aria-pressed")).toBe("true");
      await page.evaluate(() => window.scrollTo(0, 0));
      await e.shot(page, "pricing-ru-390x844.png");
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ price: luxe!.price }).where(eq(templates.id, luxe!.id));
    }
  });

  it("подписка с экрана цен: оплата, снова цены с плашкой и сроком; доступ обновлён, кнопки — «Продлить»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Лола" });
    const P = await pricesFor(user.id);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-nav-btn]").click();
    await page.locator('[data-menu="nav"] [data-item="prices"]').click();
    const scr = pricing(page);
    await scr.locator('[data-buy-sub="3"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    // Тестовая оплата называет срок.
    await expect.poll(() => page.locator('[data-screen="mock-pay"]').innerText()).toContain((ru.orderKinds.subscription + " · " + plan(3)).toUpperCase());
    expect(await page.locator('[data-screen="mock-pay"]').innerText()).toContain(await money(page, 3 * P.subscriptionMonth));
    const [order] = await ordersOfUser(user.id);
    expect(order).toMatchObject({ kind: "subscription", quantity: 3, amount: 3 * P.subscriptionMonth, invitationId: null, status: "pending" });
    await page.locator('[data-mock="paid"]').click();
    // Не главная, а снова цены: плашка «Подписка оформлена» со сроком, статус и кнопки продления.
    await scr.locator("[data-sub-done]").waitFor();
    expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
    const [sub] = await e.db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
    expect(sub).toBeTruthy();
    expect(await scr.locator("[data-sub-done]").innerText()).toContain(ru.subDone.toUpperCase());
    expect(await scr.locator("[data-sub-done]").innerText()).not.toContain("..");
    expect(await scr.locator('[data-sub-state="sub"]').innerText()).toContain(ru.subUntil.split("{date}")[0].trim());
    expect(await scr.locator('[data-buy-sub="1"]').innerText()).toBe(ru.subRenew);
    expect(await scr.locator('[data-price-card="shared"]').innerText()).toContain(ru.tplInSub.toUpperCase());
    await e.shot(page, "pricing-done-ru-390x844.png");
    // Пришли с главной: дальше — создать приглашение.
    expect(await scr.locator("[data-sub-next]").innerText()).toContain(ru.create);
    await scr.locator("[data-sub-next]").click();
    await e.waitText(page, ru.chooseEvent);
    expect(await page.evaluate(() => location.hash)).toBe("");
    await e.expectClean(page, problems);
    await close();
  });

  it("отказ в оплате подписки: «Попробовать снова» — снова цены с тем же сроком, повторная оплата проходит", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { page, problems, close } = await e.open("/app/#/pricing", { context });
    const scr = pricing(page);
    await scr.locator('[data-plan="6"]').click();
    await scr.locator('[data-buy-sub="6"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await page.locator('[data-mock="failed"]').click();
    await page.locator('[data-order-status="failed"]').waitFor();
    await page.getByRole("button", { name: new RegExp("^" + ru.orderRetry) }).click();
    await scr.waitFor();
    expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
    expect(await scr.locator('[data-plan="6"]').getAttribute("aria-pressed")).toBe("true");
    await scr.locator('[data-buy-sub="6"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await page.locator('[data-mock="paid"]').click();
    await scr.locator("[data-sub-done]").waitFor();
    expect((await ordersOfUser(user.id)).map((o) => [o.quantity, o.status])).toEqual([[6, "failed"], [6, "paid"]]);
    await e.expectClean(page, problems);
    await close();
  });

  it("без входа: «Оформить» открывает вход с причиной; бесплатный доступ: сроков нет, сервер подписку не продаёт", async () => {
    const { page, problems, close } = await e.open("/app/#/pricing");
    const scr = pricing(page);
    await scr.locator('[data-buy-sub="1"]').click();
    await sheet(page, "login").waitFor();
    expect(await sheet(page, "login").innerText()).toContain(ru.loginWhy.buy);
    expect(await scr.locator("[data-sub-state]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();

    const context = await e.newContext();
    const free = await e.signIn(context, { freeAccess: true });
    const r = await e.app.inject({ method: "POST", url: "/api/orders", headers: { cookie: cookieOf(free.id), origin: e.base, "x-lang": "uz" }, payload: { kind: "subscription", months: 1 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("Sizda bepul foydalanish huquqi bor: obuna kerak emas");
    const second = await e.open("/app/#/pricing", { context });
    const scr2 = pricing(second.page);
    await scr2.locator('[data-sub-state="free"]').waitFor();
    expect(await scr2.locator('[data-sub-state="free"]').innerText()).toContain(ru.freeTitle);
    expect(await scr2.locator("[data-buy-sub]").count()).toBe(0);
    expect(await scr2.locator('[data-price-card="shared"]').innerText()).toContain(ru.tplFreeYou.toUpperCase());
    await e.expectClean(second.page, second.problems);
    await second.close();
  });

  it("подписка действует: срок и дни, «Продлить» и новый срок от конца текущей; на узбекском", async () => {
    const context = await e.newContext({ viewport: { width: 1366, height: 900 } });
    const user = await e.signIn(context, { locale: "uz" });
    const end = new Date(Date.now() + 30 * 864e5);
    await e.db.insert(subscriptions).values({ userId: user.id, startsAt: new Date(), endsAt: end });
    const { page, problems, close } = await e.open("/app/#/pricing", { context });
    const scr = pricing(page);
    await scr.locator('[data-sub-state="sub"]').waitFor();
    expect(await scr.innerText()).toContain(uz.pricingTitle);
    expect(await scr.locator('[data-sub-state="sub"]').innerText()).toContain(uz.daysLeft.replace("{n}", "30").toUpperCase());
    expect(await scr.locator('[data-buy-sub="3"]').innerText()).toBe(uz.subRenew);
    expect(await scr.innerText()).toContain(uz.subExtendNote);
    // Новый срок прибавляется к текущему (как extendSubscription на сервере).
    const after = new Date(end); after.setUTCMonth(after.getUTCMonth() + 1);
    const dd = new Date(after.getTime() + 5 * 36e5);
    const short = dd.getUTCDate() + "-" + D.UZ_DATES.uz.monthsShort[dd.getUTCMonth()] + ", " + dd.getUTCFullYear();
    expect(await scr.locator('[data-plan="1"]').innerText()).toContain(uz.untilShort.replace("{date}", short).toUpperCase());
    await e.shot(page, "pricing-sub-uz-1366x900.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("лист оплаты → «Подробнее о подписке» → цены; «Назад» возвращает в лист с тем же выбором", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await createInvitation(user.id, { data: { names: "Назад в лист", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Назад в лист" });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: ru.toShare + " →" }).last().click();
    const pay = sheet(page, "pay");
    await pay.locator("[data-sub-more]").click();
    await pricing(page).waitFor();
    expect(await pay.count()).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
    // «Назад» браузера — снова конструктор и лист оплаты.
    await page.goBack();
    await pay.waitFor();
    await builder(page);
    expect(await pay.locator('[data-mode="shared"]').getAttribute("data-mode")).toBe("shared");
    // И кнопкой «Назад» на экране цен.
    await pay.locator("[data-sub-more]").click();
    await pricing(page).locator("[data-pricing-back]").click();
    await pay.waitFor();
    await e.expectClean(page, problems);
    await close();
  });

  it("мини-апп: MainButton — выбранный срок с ценой, BackButton — назад; оплата внутри мини-аппа", async () => {
    const tgId = 7_300_000_000 + Math.floor(Math.random() * 1e6);
    const [user] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Мадина", locale: "ru" }).returning();
    const P = await pricesFor(user!.id);
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Мадина", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-nav-btn]").click();
    await page.locator('[data-menu="nav"] [data-item="prices"]').click();
    const scr = pricing(page);
    await scr.waitFor();
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.subBuyFor.replace("{plan}", plan(1)).replace("{price}", await money(page, P.subscriptionMonth)));
    expect((await tgState(page)).back).toBe(true);
    await scr.locator('[data-plan="12"]').click();
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.subBuyFor.replace("{plan}", plan(12)).replace("{price}", await money(page, 12 * P.subscriptionMonth)));
    // BackButton: пришли с главной — на главную.
    await page.evaluate(() => (window as any).__tg.back.fn());
    await scr.waitFor({ state: "detached" });
    await e.waitText(page, ru.hero1);
    await page.locator("[data-nav-btn]").click();
    await page.locator('[data-menu="nav"] [data-item="prices"]').click();
    await scr.waitFor();
    await page.evaluate(() => (window as any).__tg.main.fn());
    // Тестовая оплата — внутри мини-аппа, внешних ссылок нет.
    await page.locator('[data-screen="mock-pay"]').waitFor();
    expect((await tgState(page)).links).toEqual([]);
    const [order] = await ordersOfUser(user!.id);
    expect(order).toMatchObject({ kind: "subscription", quantity: 12 });
    await page.locator('[data-mock="paid"]').click();
    await scr.locator("[data-sub-done]").waitFor();
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.create);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("«Купить шаблон»", () => {
  it("с экрана шаблонов: вход, черновик, оплата — снова конструктор; потом ссылка без новой оплаты", async () => {
    const phone = uniquePhone();
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await toTemplates(page);
    const card = page.locator('[data-tpl-price="wedding-classic"]');
    const [tpl] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    const cfg = (await e.app.inject({ url: "/api/auth/config" })).json() as Dict;
    const price = tpl!.price ?? cfg.prices.sharedTemplate;
    await expect.poll(() => card.innerText()).toContain((await money(page, price)).toUpperCase());
    expect(await card.locator('[data-buy="tpl"]').innerText()).toBe(ru.buyTpl);
    // Цена и подсказка под каруселью.
    expect(await page.locator("[data-cur-price]").innerText()).toContain(await money(page, price));
    await e.shot(page, "templates-buy-ru-390x844.png");
    await card.locator('[data-buy="tpl"]').click();
    // Нужен вход: лист говорит зачем, после входа покупка продолжается.
    await sheet(page, "login").waitFor();
    expect(await sheet(page, "login").innerText()).toContain(ru.loginWhy.buy);
    await smsLogin(page, phone);
    await page.locator('[data-screen="mock-pay"]').waitFor({ timeout: 15_000 });
    const [user] = await e.db.select().from(users).where(eq(users.phone, phone));
    const [inv] = await invsOf(user!.id);
    expect(inv).toMatchObject({ mode: "shared", status: "draft", unlocked: false });
    const [order] = await ordersOfUser(user!.id);
    expect(order).toMatchObject({ kind: "template", invitationId: inv!.id, amount: price, status: "pending" });
    // Что оплачивается: имена и шаблон.
    await expect.poll(() => page.locator("[data-mock-what]").innerText()).toContain("IVORY");
    await page.locator('[data-mock="paid"]').click();
    // После оплаты — конструктор, а не «Ссылка готова»: черновик оплачен, но не опубликован.
    await builder(page);
    await e.waitText(page, ru.tplBought);
    expect(await page.locator("[data-screen]").count()).toBe(0);
    expect(page.url()).toBe(`${e.base}/app/`);
    expect(await invOf(inv!.id)).toMatchObject({ status: "draft", unlocked: true });
    expect(await e.app.inject({ url: "/i/" + (await invOf(inv!.id)).slug }).then((r) => r.statusCode)).toBe(404);
    // Ссылка потом — без новой оплаты: лист показывает «Оплачено», кнопка «Опубликовать».
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: ru.toShare + " →" }).last().click();
    const pay = sheet(page, "pay");
    await expect.poll(() => pay.locator('[data-price="shared"]').innerText()).toBe(ru.paidMark);
    expect(await pay.locator("[data-pay-total]").innerText()).toBe(ru.free);
    expect(await pay.locator("[data-sub]").count()).toBe(0);
    await pay.locator('[data-pay="go"]').click();
    await e.waitText(page, ru.linkReady);
    expect(await invOf(inv!.id)).toMatchObject({ status: "active", unlocked: true });
    expect((await ordersOfUser(user!.id)).map((o) => [o.kind, o.status])).toEqual([["template", "paid"]]);
    expect(problems.me401).toBeGreaterThan(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("в предпросмотре; отказ в оплате — «Попробовать снова» снова оплачивает тот же черновик; двойное нажатие не создаёт второй заказ", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const P = await pricesFor(user.id, "wedding-botanical");
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await toTemplates(page);
    await page.locator('[data-tpl-price="wedding-botanical"]').click();
    await previewOf(page);
    const buy = page.locator('[data-buy="tpl"]');
    await expect.poll(() => buy.innerText()).toBe(ru.buyFor.replace("{price}", await money(page, P.template)));
    // Заказ создаётся медленно: кнопка занята, повторное нажатие второго заказа не создаёт.
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    await context.route(e.base + "/api/orders", async (route) => { await slow; await route.continue(); });
    await buy.click();
    await expect.poll(() => buy.innerText()).toBe(ru.loading);
    await buy.click({ force: true });
    // Переход на страницу оплаты не состоялся (ответ 204): кнопка ждёт перехода — «Переходим к оплате…».
    await context.route(e.base + "/api/payments/mock/checkout/**", (route) => route.fulfill({ status: 204 }));
    release();
    await expect.poll(() => buy.innerText(), { timeout: 10_000 }).toBe(ru.toCheckout);
    await buy.click({ force: true });
    await page.waitForTimeout(400);
    const [first, ...more] = await ordersOfUser(user.id);
    expect(more).toEqual([]);
    // Перехода так и нет: через 20 с кнопка снова доступна.
    await expect.poll(() => buy.innerText(), { timeout: 25_000 }).toBe(ru.buyFor.replace("{price}", await money(page, P.template)));
    await context.unroute(e.base + "/api/orders");
    await context.unroute(e.base + "/api/payments/mock/checkout/**");
    // Страница оплаты того же заказа (как если бы переход завершился).
    await page.goto(e.base + "/api/payments/mock/checkout/" + first!.id);
    await page.locator('[data-screen="mock-pay"]').waitFor();
    const [inv] = await invsOf(user.id);
    expect(inv!.mode).toBe("shared");
    await page.locator('[data-mock="failed"]').click();
    await page.locator('[data-order-status="failed"]').waitFor();
    await page.getByRole("button", { name: new RegExp("^" + ru.orderRetry) }).click();
    // Снова страница оплаты того же черновика (новый заказ).
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await expect.poll(async () => (await ordersOfUser(user.id)).length).toBe(2);
    const list = await ordersOfUser(user.id);
    expect(list.map((o) => [o.invitationId, o.status])).toEqual([[inv!.id, "failed"], [inv!.id, "pending"]]);
    await page.locator('[data-mock="paid"]').click();
    await builder(page);
    expect(await invsOf(user.id)).toHaveLength(1);
    expect(await invOf(inv!.id)).toMatchObject({ status: "draft", unlocked: true });
    await e.expectClean(page, problems);
    await close();
  });

  it("бесплатный доступ и подписка: цена «Бесплатно для вас» / «Входит в подписку», кнопка сразу открывает конструктор", async () => {
    for (const [kind, label, start] of [["free", ru.tplFreeYou, ru.tplStartFree], ["sub", ru.tplInSub, ru.tplStartSub]] as const) {
      const context = await e.newContext();
      const user = await e.signIn(context, { freeAccess: kind === "free" });
      if (kind === "sub") await e.db.insert(subscriptions).values({ userId: user.id, startsAt: new Date(), endsAt: new Date(Date.now() + 10 * 864e5) });
      const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
      await toTemplates(page);
      const card = page.locator('[data-tpl-price="wedding-classic"]');
      await expect.poll(() => card.innerText()).toContain(label.toUpperCase());
      expect(await card.locator('[data-buy="tpl"]').innerText()).toBe(start);
      await e.shot(page, `templates-${kind}-ru-390x844.png`);
      // В предпросмотре платить не за что — только «Выбрать шаблон».
      await previewOf(page);
      expect(await page.locator('[data-buy="tpl"]').count()).toBe(0);
      await page.getByRole("button", { name: "← " + ru.back }).first().click();
      await card.locator('[data-buy="tpl"]').click();
      await builder(page);
      await e.waitText(page, label);
      const [inv] = await invsOf(user.id);
      expect(inv).toMatchObject({ status: "draft" });
      expect(await ordersOfUser(user.id)).toEqual([]);
      await e.expectClean(page, problems);
      await close();
    }
  });
});

describe("оплата: ожидание и места", () => {
  it("«Ждём оплату»: что оплачивается, страница оплаты на сайте, через 20 с — «Изменить заказ»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Ожидание тест", intro: "none" } });
    const r = await apiAs(user.id, "POST", "/api/orders", { kind: "template", invitationId: inv.id });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Ожидание тест" });
    await page.evaluate((id) => { location.hash = "#/orders/" + id; }, r.order.id);
    const scr = page.locator('[data-screen="order"]');
    await page.locator('[data-order-status="pending"]').waitFor();
    expect(await scr.locator("[data-order-what]").innerText()).toBe(("Ожидание тест · " + ru.template + " «Ivory»").toUpperCase());
    // Страница оплаты доступна и на сайте (раньше — только в Telegram).
    await scr.getByRole("button", { name: ru.orderOpen + " ↗" }).waitFor();
    expect(await scr.locator("[data-order-change]").count()).toBe(0);
    await scr.locator("[data-order-change]").waitFor({ timeout: 25_000 });
    expect(await scr.innerText()).toContain(ru.orderStuck);
    await e.shot(page, "order-stuck-ru-390x844.png");
    await scr.locator("[data-order-change]").click();
    await sheet(page, "pay").waitFor();
    await builder(page);
    // Снова на страницу оплаты того же заказа.
    await sheet(page, "pay").getByRole("button", { name: ru.close, exact: true }).click();
    await page.evaluate((id) => { location.hash = "#/orders/" + id; }, r.order.id);
    await scr.getByRole("button", { name: ru.orderOpen + " ↗" }).click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    expect(page.url()).toBe(`${e.base}/app/#/mock-pay/${r.order.id}`);
    await e.expectClean(page, problems);
    await close();
  });

  it("«Докупить места»: без карточки типа, «Сколько мест докупить», оплачено и без места", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { mode: "personal", data: { names: "Места тест", intro: "none" } });
    await e.db.update(invitations).set({ status: "active", publishedAt: new Date(), paidSeats: 1 }).where(eq(invitations.id, inv.id));
    await apiAs(user.id, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Гость Один" }, { name: "Гость Два" }] });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Места тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    await e.waitText(page, ru.guestList);
    await page.getByRole("button", { name: new RegExp("^" + ru.buySeats + " · ") }).click();
    const pay = sheet(page, "pay");
    await pay.waitFor();
    expect(await pay.locator("[data-mode]").count()).toBe(0);
    expect(await pay.innerText()).toContain(ru.seatsMore);
    expect(await pay.innerText()).toContain(ru.seatsNote.replace("{paid}", "1").replace("{unpaid}", "1"));
    expect(await pay.locator("[data-sub]").count()).toBe(0);
    await page.waitForTimeout(300);
    await e.shot(page, "pay-seats-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();
    expect(await e.db.select().from(orders).where(and(eq(orders.invitationId, inv.id)))).toEqual([]);
  });
});
