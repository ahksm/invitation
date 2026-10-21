import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, orders, subscriptions, templates, users } from "../../src/db/schema.js";
import { formatPhone } from "../../src/services/phone.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { botHarness, startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Шапка, вход и профиль в браузере против настоящего сервера (docs/invito-integration.md, раздел 4):
 * меню языка интерфейса на телефоне, компьютере и в мини-аппе, «Войти» сразу открывает вход, вход через
 * Telegram первым (ссылка на бота заготовлена, ожидание переживает перезагрузку), понятный вход по номеру,
 * имя в профиле, подписка → цены, история платежей. Бот — этого же сервера в процессе (botHarness).
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const uzc = I18N.uzc as Dict;
const en = I18N.en as Dict;
const D = INVITO as Dict;
const BOT = "invitebloom_e2e_bot";
const DESK = { width: 1366, height: 900 };
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

afterEach(() => setBot(false));

/** Бот в конфигурации сервера (как в contract.test.ts): сам бот не запускается, обновления подаёт botHarness. */
function setBot(on: boolean) {
  e.config.TELEGRAM_MODE = on ? "polling" : "off";
  e.config.TELEGRAM_BOT_USERNAME = on ? BOT : "";
}

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const tgIdOf = (base: number) => base + Math.floor(Math.random() * 1e6);
const userOf = async (id: string) => (await e.db.select().from(users).where(eq(users.id, id)))[0]!;
const storedLogin = (page: Page) => page.evaluate(() => localStorage.getItem("invito.tglogin"));
/** Переходы браузера на t.me (новая вкладка или эта же): заглушка отвечает 204, страница приложения остаётся. */
function tmeVisits(context: BrowserContext) {
  const urls: string[] = [];
  context.on("request", (r) => { if (r.isNavigationRequest() && r.url().startsWith("https://t.me/")) urls.push(r.url()); });
  return urls;
}

/** Пользователь Telegram с номером: вход через бота — сразу подтверждение, без шага контакта. */
async function tgUser(base: number, values: Dict = {}) {
  const tg = tgIdOf(base);
  const [u] = await e.db.insert(users).values({ telegramId: tg, phone: uniquePhone(), firstName: "Мадина", locale: "ru", ...values }).returning();
  return { tg, user: u! };
}

/** Ссылка на бота в листе входа и её nonce. */
async function tgLink(page: Page) {
  const a = sheet(page, "login").locator("a[data-tg-link]");
  await a.waitFor();
  const href = (await a.getAttribute("href"))!;
  const m = new RegExp(`^https://t\\.me/${BOT}\\?start=auth_([\\w-]+)$`).exec(href);
  expect(m, href).toBeTruthy();
  return { a, nonce: m![1]! };
}

async function toTemplates(page: Page) {
  await page.getByRole("button", { name: ru.create }).first().click();
  await e.waitText(page, ru.chooseEvent);
  await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label.ru }).first().click();
  await page.getByRole("button", { name: ru.useTpl }).first().waitFor();
}

describe("шапка: язык интерфейса и разделы", () => {
  it("телефон без входа: меню языка с полными названиями, выбор меняет интерфейс; код языка не в кнопке входа", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    const acc = page.locator("[data-account]");
    expect((await acc.innerText()).trim()).toBe(ru.login);
    const btn = page.locator("[data-lang-btn]");
    expect(await btn.innerText()).toContain("RU");
    await btn.click();
    const menu = page.locator('[data-menu="lang"]');
    await menu.waitFor();
    expect(await btn.getAttribute("aria-expanded")).toBe("true");
    const items = menu.locator("[data-item]");
    expect(await items.evaluateAll((els) => els.map((x) => x.getAttribute("data-item")))).toEqual(["ru", "uz", "uzc", "en"]);
    for (const code of ["ru", "uz", "uzc", "en"]) expect(await menu.locator(`[data-item="${code}"]`).innerText()).toContain(D.LANG_NAMES[code]);
    expect(D.LANG_NAMES.uz).toBe("O\u2018zbekcha");
    expect(await menu.locator('[data-item="ru"]').getAttribute("aria-pressed")).toBe("true");
    expect(await menu.innerText()).toContain(ru.langNote);
    await e.shot(page, "lang-menu-ru-390x844.png");
    // Escape закрывает меню, повторное нажатие на кнопку (поверх неё — подложка меню) — тоже.
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await btn.click();
    await menu.waitFor();
    const b = (await btn.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await menu.waitFor({ state: "detached" });
    await btn.click();
    await menu.locator('[data-item="uz"]').click();
    await e.waitText(page, uz.hero1);
    await menu.waitFor({ state: "detached" });
    expect(await btn.innerText()).toContain("UZ");
    expect((await acc.innerText()).trim()).toBe(uz.login);
    expect(await page.evaluate(() => localStorage.getItem("invito.lang"))).toBe("uz");
    await e.expectClean(page, problems);
    await close();
  });

  it("360 px на узбекском: шапка без горизонтальной прокрутки, разделы в меню, «Narxlar» открывает цены", async () => {
    const context = await e.newContext({ viewport: { width: 360, height: 780 } });
    await context.addInitScript(() => { try { localStorage.setItem("invito.lang", "uz"); } catch (x) {} });
    const { page, problems, close } = await e.open("/app/", { context, waitText: uz.hero1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    for (const sel of ["[data-lang-btn]", "[data-account]", "[data-nav-btn]"]) {
      const box = (await page.locator(sel).boundingBox())!;
      expect(box.x, sel).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, sel).toBeLessThanOrEqual(360);
    }
    // Меню языка целиком на экране: кнопка языка левее середины, но меню не уходит за левый край.
    await page.locator("[data-lang-btn]").click();
    const langMenu = page.locator('[data-menu="lang"]');
    await langMenu.waitFor();
    const lm = (await langMenu.boundingBox())!;
    expect(lm.x).toBeGreaterThanOrEqual(0);
    expect(lm.x + lm.width).toBeLessThanOrEqual(360);
    await page.keyboard.press("Escape");
    await langMenu.waitFor({ state: "detached" });
    // На телефоне разделов в шапке нет — они в меню.
    expect(await page.locator("[data-nav]").count()).toBe(0);
    await page.locator("[data-nav-btn]").click();
    const menu = page.locator('[data-menu="nav"]');
    expect(await menu.locator("[data-item]").evaluateAll((els) => els.map((x) => x.textContent!.trim()))).toEqual([uz.navTpls, uz.navPrices, uz.myInv, uz.tour]);
    await e.shot(page, "nav-menu-uz-360x780.png");
    await menu.locator('[data-item="prices"]').click();
    await page.locator('[data-screen="pricing"]').waitFor();
    expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
    expect(await page.locator('[data-screen="pricing"]').innerText()).toContain(uz.pricingTitle);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    // «Назад» браузера — на главную, адрес без #/pricing.
    await page.goBack();
    await page.locator('[data-screen="pricing"]').waitFor({ state: "detached" });
    await e.waitText(page, uz.hero1);
    expect(await page.evaluate(() => location.hash)).toBe("");
    // Ссылка #/pricing открывает цены сразу.
    await page.goto(e.base + "/app/#/pricing");
    await page.locator('[data-screen="pricing"]').waitFor();
    await e.expectClean(page, problems);
    await close();
  });

  it("компьютер со входом: разделы в шапке, язык из меню сохраняется в профиле", async () => {
    const context = await e.newContext({ viewport: DESK });
    const user = await e.signIn(context, { firstName: "Азиз", lastName: "Каримов", locale: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account][aria-label]").waitFor();
    expect((await page.locator("[data-account]").innerText()).trim()).toBe("АК");
    expect(await page.locator("[data-nav]").evaluateAll((els) => els.map((x) => x.getAttribute("data-nav")))).toEqual(["tpls", "prices", "inv", "tour"]);
    expect(await page.locator("[data-nav-btn]").count()).toBe(0);
    await page.locator('[data-nav="tpls"]').click();
    await e.waitText(page, ru.chooseEvent);
    await page.locator("[data-lang-btn]").click();
    const box = (await page.locator('[data-menu="lang"]').boundingBox())!;
    const btn = (await page.locator("[data-lang-btn]").boundingBox())!;
    // Меню под кнопкой, по её правому краю.
    expect(box.y).toBeGreaterThan(btn.y + btn.height);
    expect(Math.abs(box.x + box.width - (btn.x + btn.width))).toBeLessThan(2);
    await page.locator('[data-menu="lang"] [data-item="en"]').click();
    await e.waitText(page, en.chooseEvent);
    await expect.poll(async () => (await userOf(user.id)).locale).toBe("en");
    // Из профиля «Язык интерфейса» открывает то же меню.
    await page.locator("[data-account]").click();
    await sheet(page, "account").locator('[data-acc-row="lang"]').click();
    await page.locator('[data-menu="lang"]').waitFor();
    expect(await sheet(page, "account").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("мини-апп: меню языка в шапке сохраняет выбор в профиле; в профиле нет «Выйти», вместо него пояснение", async () => {
    const { tg, user } = await tgUser(7_981_000_000);
    const context = await e.newContext();
    await telegramStub(context, { id: tg, first_name: "Мадина", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account][aria-label]").waitFor();
    await page.locator("[data-lang-btn]").click();
    await page.locator('[data-menu="lang"] [data-item="uzc"]').click();
    await e.waitText(page, uzc.hero1);
    expect(await page.locator("[data-lang-btn]").innerText()).toContain("ЎЗ");
    await expect.poll(async () => (await userOf(user.id)).locale).toBe("uzc");
    await page.locator("[data-account]").click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    expect(await acc.getByRole("button", { name: uzc.logout }).count()).toBe(0);
    expect(await acc.innerText()).toContain(uzc.tgSessionNote);
    await e.shot(page, "account-miniapp-uzc-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("мини-апп без номера: сначала объяснение, запрос контакта Telegram — только по нажатию", async () => {
    const tg = tgIdOf(7_982_000_000);
    const context = await e.newContext();
    await telegramStub(context, { id: tg, first_name: "Мадина", language_code: "ru" }, { contactOk: true });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const login = sheet(page, "login");
    await login.waitFor();
    expect(await login.innerText()).toContain(ru.tgPhoneTitle.replace("{name}", "Мадина"));
    expect(await login.innerText()).toContain(ru.sharePhoneHint);
    await page.waitForTimeout(1500);
    expect((await tgState(page)).contact).toBe(0);
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);
    await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).click();
    await expect.poll(async () => (await tgState(page)).contact).toBe(1);
    await login.locator('[data-wait="phone"]').waitFor();
    // «Позже» закрывает лист: приложение можно смотреть и без входа.
    await login.getByRole("button", { name: ru.later }).click();
    await login.waitFor({ state: "detached" });
    // «Войти» в шапке мини-аппа — снова шаг номера Telegram, без SMS.
    await page.locator("[data-account]").click();
    await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).waitFor();
    expect(await login.locator("input[name=phone]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("вход", () => {
  it("«Войти» сразу открывает вход; без бота — только номер, поле номера в фокусе", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await page.locator("[data-account]").click();
    const login = sheet(page, "login");
    await login.waitFor();
    expect(await sheet(page, "account").count()).toBe(0);
    expect(await login.locator("[data-login-tg]").count()).toBe(0);
    expect(await login.innerText()).toContain(ru.phoneHint);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("phone");
    // Телефон: лист снизу на всю ширину.
    const box = (await login.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    await e.expectClean(page, problems);
    await close();
  });

  it("компьютер с ботом: окно по центру, Telegram первым по заготовленной ссылке, шаги, срок и QR, вход подтверждается в боте", async () => {
    setBot(true);
    const h = botHarness(e, BOT);
    const { tg, user } = await tgUser(7_983_000_000);
    const context = await e.newContext({ viewport: DESK });
    const visits = tmeVisits(context);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account]").click();
    const login = sheet(page, "login");
    await login.waitFor();
    const { a, nonce } = await tgLink(page);
    // Окно по центру экрана.
    const box = (await login.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - DESK.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - DESK.height / 2)).toBeLessThan(2);
    // Telegram — первым, номер — вторым; поле номера не забирает фокус.
    expect(await page.evaluate(() => {
      const tgEl = document.querySelector("[data-login-tg]")!, ph = document.querySelector("input[name=phone]")!;
      return !!(tgEl.compareDocumentPosition(ph) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("name") ?? null)).not.toBe("phone");
    expect(await login.innerText()).toContain(ru.tgLoginNote);
    expect(await a.getAttribute("target")).toBe("_blank");
    await e.shot(page, "login-tg-ru-1366x900.png");
    // Нажатие открывает бота в новой вкладке (ссылка не убирается из страницы до перехода), лист ждёт подтверждения.
    await a.click();
    await login.locator('[data-wait="telegram"]').waitFor();
    await expect.poll(() => visits).toEqual([`https://t.me/${BOT}?start=auth_${nonce}`]);
    for (const step of ru.tgSteps) expect(await login.innerText()).toContain(step);
    expect(await login.locator("[data-tg-left]").innerText()).toMatch(/\d:\d\d/);
    await login.locator("[data-tg-qr] img").waitFor();
    expect(await login.locator("[data-tg-qr] img").getAttribute("src")).toMatch(/^data:image\//);
    expect(JSON.parse((await storedLogin(page))!)).toMatchObject({ nonce, connect: false });
    await e.shot(page, "login-tgwait-ru-1366x900.png");
    // В боте: «Запустить» по ссылке, затем «Подтвердить вход».
    await h.message(tg, `/start auth_${nonce}`);
    await h.press(tg, `auth:${nonce}`);
    await e.waitText(page, ru.welcome);
    await login.waitFor({ state: "detached" });
    const session = (await context.cookies()).find((c) => c.name === "session")!.value;
    expect((e.app.jwt.decode(session) as Dict).sub).toBe(user.id);
    expect(await storedLogin(page)).toBeNull();
    await e.expectClean(page, problems);
    await close();
  });

  it("телефон с ботом: ожидание входа переживает уход в Telegram и перезагрузку, затем — действие, ради которого входили", async () => {
    setBot(true);
    const h = botHarness(e, BOT);
    const { tg, user } = await tgUser(7_984_000_000);
    const context = await e.newContext({ hasTouch: true });
    const visits = tmeVisits(context);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await toTemplates(page);
    await page.getByRole("button", { name: ru.useTpl }).first().click();
    const login = sheet(page, "login");
    await login.waitFor();
    // Зачем вход и что будет после него.
    expect(await login.locator('[data-login-note="why"]').innerText()).toBe(ru.loginWhy.tpl);
    const { a, nonce } = await tgLink(page);
    // На телефоне ссылка открывается в этой же вкладке (Telegram в тестах — заглушка 204, страница остаётся).
    expect(await a.getAttribute("target")).toBe("_self");
    await e.shot(page, "login-tg-ru-390x844.png");
    await a.click();
    await login.locator('[data-wait="telegram"]').waitFor();
    await expect.poll(() => visits).toEqual([`https://t.me/${BOT}?start=auth_${nonce}`]);
    expect(page.url()).toBe(e.base + "/app/");
    expect(JSON.parse((await storedLogin(page))!)).toMatchObject({ nonce, act: { k: "tpl", ev: "wedding" } });
    await e.shot(page, "login-tgwait-ru-390x844.png");
    // Вернулись в браузер, а страница перезагрузилась: тот же запрос, то же ожидание и та же причина входа.
    await page.reload();
    await login.locator('[data-wait="telegram"]').waitFor();
    expect(await login.locator(`a[href="https://t.me/${BOT}?start=auth_${nonce}"]`).count()).toBe(1);
    expect(await login.locator('[data-login-note="why"]').innerText()).toBe(ru.loginWhy.tpl);
    await h.message(tg, `/start auth_${nonce}`);
    await h.press(tg, `auth:${nonce}`);
    await e.waitText(page, ru.welcome);
    // Действие продолжилось: черновик с выбранным шаблоном, открыт конструктор.
    await page.getByLabel(ru.fNames).waitFor();
    await expect.poll(async () => (await e.db.select().from(invitations).where(eq(invitations.userId, user.id))).length).toBe(1);
    expect(await storedLogin(page)).toBeNull();
    await e.expectClean(page, problems);
    await close();
  });

  it("истёкшая ссылка из прошлого визита не открывает ожидание; «Отмена» возвращает к способам входа", async () => {
    setBot(true);
    const context = await e.newContext({ hasTouch: true });
    await context.addInitScript(() => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("invito.tglogin", JSON.stringify({ nonce: "old-nonce-1234567890", url: "https://t.me/x?start=auth_old", until: Date.now() - 1000 })); } } catch (x) {} });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    expect(await sheet(page, "login").count()).toBe(0);
    expect(await storedLogin(page)).toBeNull();
    await page.locator("[data-account]").click();
    const { a } = await tgLink(page);
    await a.click();
    const login = sheet(page, "login");
    await login.locator('[data-wait="telegram"]').waitFor();
    await login.getByRole("button", { name: ru.cancel }).click();
    await login.locator("input[name=phone]").waitFor();
    expect(await storedLogin(page)).toBeNull();
    // Новая ссылка на бота готова снова.
    await tgLink(page);
    await e.expectClean(page, problems);
    await close();
  });

  it("номер: подсказка формата, «Изменить номер» и тот же номер — без нового запроса кода и без 429", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    const requests = () => problems.requests.filter((u) => u === "/api/auth/phone/request").length;
    await page.locator("[data-account]").click();
    const login = sheet(page, "login");
    const phone = uniquePhone();
    await page.locator("input[name=phone]").fill(phone.slice(3));
    await login.getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    expect(await login.innerText()).toContain(ru.codeTtl);
    expect(await login.locator("[data-resend]").innerText()).toMatch(/\d/);
    await login.getByRole("button", { name: ru.changePhone }).click();
    await page.locator("input[name=phone]").waitFor();
    await login.getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    expect(requests()).toBe(1);
    expect(await login.getByRole("alert").count()).toBe(0);
    // Другой номер — новый код.
    await login.getByRole("button", { name: ru.changePhone }).click();
    const other = uniquePhone();
    await page.locator("input[name=phone]").fill(other.slice(3));
    await login.getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    expect(requests()).toBe(2);
    await page.locator("input[name=code]").fill(e.lastCode(other)!);
    await login.waitFor({ state: "detached" });
    await e.expectClean(page, problems);
    await close();
  });
});

describe("профиль", () => {
  it("имя и фамилия, подписка → цены, история платежей, «Мои приглашения»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: null, lastName: null, locale: "ru" });
    const created = await e.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie: `session=${e.app.jwt.sign({ sub: user.id })}`, origin: e.base },
      payload: { template: "wedding-classic", mode: "personal", language: "ru", data: { names: "Лола и Бахтиёр" } },
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const invId = (created.json() as { id: string }).id;
    await e.db.insert(orders).values([
      { userId: user.id, kind: "subscription", quantity: 3, amount: 27_000_000, currency: "UZS", status: "paid", provider: "mock", createdAt: new Date(Date.now() - 864e5) },
      { userId: user.id, invitationId: invId, kind: "seats", quantity: 40, amount: 8_000_000, currency: "UZS", status: "pending", provider: "mock" },
    ] as never);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account][aria-label]").click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    // Без имени заголовок — номер, рядом «Добавьте имя».
    expect(await acc.locator("[data-acc-name]").innerText()).toBe(formatPhone(user.phone!));
    const edit = acc.locator("[data-edit-name]");
    expect(await edit.innerText()).toBe(ru.nameAdd);
    await edit.click();
    const form = acc.locator("[data-name-form]");
    await form.locator("input[name=first-name]").fill("   ");
    await form.locator("[data-save-name]").click();
    expect(await form.getByRole("alert").innerText()).toBe("Введите имя");
    // Ответ 400 Chromium пишет в консоль сам; других ошибок нет.
    expect(problems.console).toEqual(["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
    problems.console = [];
    await form.locator("input[name=first-name]").fill("Мадина");
    await form.locator("input[name=last-name]").fill("Каримова");
    await e.shot(page, "account-name-ru-390x844.png");
    await form.locator("input[name=last-name]").press("Enter");
    await e.waitText(page, ru.nameSaved);
    await form.waitFor({ state: "detached" });
    expect(await acc.locator("[data-acc-name]").innerText()).toBe("Мадина Каримова");
    expect(await acc.locator("[data-phone]").innerText()).toBe(formatPhone(user.phone!));
    expect(await userOf(user.id)).toMatchObject({ firstName: "Мадина", lastName: "Каримова", nameEdited: true });
    expect((await page.locator("[data-account]").innerText()).trim()).toBe("МК");
    // История платежей: новые сверху, сумма, вид и статус.
    await acc.locator('[data-acc-row="orders"]').click();
    const rows = acc.locator("[data-order-row]");
    await rows.first().waitFor();
    expect(await rows.evaluateAll((els) => els.map((x) => x.getAttribute("data-order-row")))).toEqual(["pending", "paid"]);
    expect(await rows.nth(0).innerText()).toContain(ru.orderSt.pending);
    // Места — за какое приглашение: имена и шаблон; у подписки приглашения нет.
    expect(await rows.nth(0).locator("[data-order-what]").innerText()).toBe("Лола и Бахтиёр · " + ru.template + " «" + ru.stName.classic + "»");
    expect(await rows.nth(1).locator("[data-order-what]").count()).toBe(0);
    expect(await rows.nth(1).innerText()).toContain(ru.subMonths[1]);
    expect(await rows.nth(1).innerText()).toContain(ru.orderSt.paid);
    await e.shot(page, "account-orders-ru-390x844.png");
    // Подписки нет: «Оформить подписку» ведёт на цены.
    expect(await acc.locator("[data-sub-status]").innerText()).toBe(ru.subNone);
    await acc.locator("[data-sub-go]").click();
    await page.locator('[data-screen="pricing"]').waitFor();
    expect(await acc.count()).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
    // «Мои приглашения» из профиля — на главную к списку.
    await page.locator("[data-account]").click();
    await acc.locator('[data-acc-row="inv"]').click();
    await page.locator("#my-inv").waitFor();
    expect(await acc.count()).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe("");
    await e.expectClean(page, problems);
    await close();
  });

  it("история платежей: у заказа шаблона — оплаченный шаблон, а не нынешний шаблон приглашения", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Тест", locale: "ru" });
    const api = (method: "POST" | "PATCH", url: string, payload: Dict) =>
      e.app.inject({ method, url, headers: { cookie: `session=${e.app.jwt.sign({ sub: user.id })}`, origin: e.base }, payload });
    const inv = (await api("POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", data: { names: "История тест" } })).json() as { id: string };
    const [classic] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    await e.db.update(invitations).set({ unlocked: true }).where(eq(invitations.id, inv.id));
    await e.db.insert(orders).values({ userId: user.id, invitationId: inv.id, kind: "template", amount: 5_000_000, currency: "UZS", status: "paid", provider: "mock", paidAt: new Date(), meta: { templateId: classic!.id } } as never);
    // После оплаты шаблон сменили на не более дорогой («Без доплаты»).
    expect((await api("PATCH", `/api/invitations/${inv.id}`, { template: "wedding-botanical" })).statusCode).toBe(200);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "История тест" });
    await page.locator("[data-account][aria-label]").click();
    const acc = sheet(page, "account");
    await acc.locator('[data-acc-row="orders"]').click();
    const row = acc.locator("[data-order-row]");
    await row.first().waitFor();
    expect(await row.locator("[data-order-what]").innerText()).toBe("История тест · " + ru.template + " «" + ru.stName.classic + "»");
    await e.expectClean(page, problems);
    await close();
  });

  it("подписка действует: срок и «Продлить подписку»; на компьютере профиль — окно по центру", async () => {
    const context = await e.newContext({ viewport: DESK });
    const user = await e.signIn(context, { firstName: "Азиз", locale: "ru" });
    await e.db.insert(subscriptions).values({ userId: user.id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 864e5) });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account][aria-label]").click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    const box = (await acc.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - DESK.width / 2)).toBeLessThan(2);
    expect(await acc.locator("[data-sub-status]").innerText()).toContain(ru.subActive.split("{date}")[0].trim());
    expect(await acc.locator("[data-sub-go]").innerText()).toContain(ru.subExtend);
    expect(await acc.innerText()).toContain(ru.subExtendNote);
    await acc.locator('[data-acc-row="orders"]').click();
    await acc.getByText(ru.payNone).waitFor();
    await e.shot(page, "account-sub-ru-1366x900.png");
    await acc.locator("[data-sub-go]").click();
    await page.locator('[data-screen="pricing"]').waitFor();
    await e.expectClean(page, problems);
    await close();
  });
});
