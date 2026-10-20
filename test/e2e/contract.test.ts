import { eq } from "drizzle-orm";
import type { Frame, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, users } from "../../src/db/schema.js";
import { bt } from "../../src/i18n.js";
import { formatPhone, maskPhone, TELEGRAM_PHONE_MISMATCH, TELEGRAM_TAKEN } from "../../src/services/phone.js";
import { I18N } from "../../web/invito-data.js";
import { botHarness, startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Общий контракт этапа 4 (docs/invito-integration.md, 3.1, 3.2 и 3.9) в браузере против настоящего сервера:
 * возврат после оплаты из мини-аппа (#/paid/<id>), стёртая дата приглашения, причина отказа в номере в мини-аппе,
 * «Подключить Telegram» (Telegram с номером аккаунта, Telegram другого аккаунта и чужой Telegram с другим номером)
 * и мини-апп во фрейме чужого сайта (Telegram Web), где cookie не сохраняется. Бот — этого же сервера в процессе
 * (botHarness): Telegram не вызывается.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const LANGS = ["ru", "en", "uz", "uzc"] as const;
const BOT = "invito_e2e_bot";
const TG_WEB = "https://web.telegram.org";
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

/**
 * Бот в конфигурации сервера: в проверках TELEGRAM_MODE=off, и /api/auth/config отвечает telegram: false,
 * а /telegram/start — 503. На время сценария сервер видит бота BOT; сам бот при этом не запускается
 * и в Telegram не ходит, обновления ему подаёт botHarness.
 */
function setBot(on: boolean) {
  e.config.TELEGRAM_MODE = on ? "polling" : "off";
  e.config.TELEGRAM_BOT_USERNAME = on ? BOT : "";
}

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;
const tgIdOf = (base: number) => base + Math.floor(Math.random() * 1e6);

async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}

const createInvitation = (userId: string, body: Dict) => apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
const invOf = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const byTelegram = async (tg: number) => e.db.select().from(users).where(eq(users.telegramId, tg));

/** Заказ шаблона в ожидании оплаты (тестовый провайдер), как его создал бы мини-апп. */
async function pendingOrder(userId: string) {
  const inv = await createInvitation(userId, { data: { names: "Оплата из Telegram", intro: "none" } });
  const r = await apiAs(userId, "POST", "/api/orders", { kind: "template", invitationId: inv.id, returnTo: "telegram" });
  expect(r.status).toBe("pending");
  return r.order as Dict;
}

/** Текст в DOM без учёта text-transform (в шаблоне-билете имена набраны заглавными). */
const waitContent = (page: Page | Frame, text: string) => page.waitForFunction((x) => (document.body.textContent || "").includes(x), text, { timeout: 20_000 });

/** Тела POST-запросов страницы к пути API. */
function bodiesOf(page: Page, path: string) {
  const out: Dict[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === e.base + path) out.push((r.postDataJSON() as Dict) || {});
  });
  return out;
}

/** Мета-теги og:* страницы гостя, как их видит бот мессенджера (HTML сервера, без скриптов). */
async function ogOf(slug: string) {
  const html = (await e.app.inject({ method: "GET", url: `/i/${slug}`, headers: { accept: "text/html" } })).body;
  return Object.fromEntries([...html.matchAll(/<meta property="(og:[^"]+)" content="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
}

/**
 * «Мои приглашения» → «Изменить»: опубликованное открывается сразу в редакторе на странице приглашения,
 * черновик — в конструкторе. Возвращает true, если открылся редактор.
 */
async function editFromList(page: Page) {
  await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
  await page.waitForFunction((x) => !!document.querySelector(`[title="${x.s}"]`) || document.body.innerText.includes(x.h), { s: ru.stepsX.sections, h: ru.tapHint });
  return (await page.getByTitle(ru.stepsX.sections).count()) === 0;
}

/** «Изменить» → конструктор (из редактора опубликованного — его кнопкой «Назад»). */
async function toBuilder(page: Page) {
  if (await editFromList(page)) await page.getByRole("button", { name: "← " + ru.back, exact: true }).click();
  await page.getByTitle(ru.stepsX.sections).waitFor();
}

/** «Изменить» → редактор (у черновика — через «Разделы») → «Получить ссылку» (у опубликованного — сразу «Поделиться»). */
async function toShare(page: Page) {
  if (!(await editFromList(page))) {
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: "✎ " + ru.toEditor }).click();
  }
  await page.getByRole("button", { name: new RegExp("^" + ru.toShare) }).first().click();
  await e.waitText(page, ru.linkReady);
}

describe("возврат после оплаты из мини-аппа (#/paid/<id>)", () => {
  it("без входа: карточка «Оплата завершена» на четырёх языках, кнопка в бота, заказ не запрашивается", async () => {
    const [owner] = await e.db.insert(users).values({ phone: uniquePhone(), locale: "ru" }).returning();
    const order = await pendingOrder(owner!.id);
    setBot(true);
    for (const lang of LANGS) {
      const t = I18N[lang] as Dict;
      const context = await e.newContext();
      await context.addInitScript((l) => { try { localStorage.setItem("invito.lang", l); } catch (x) {} }, lang);
      const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { context, waitText: t.paidTitle });
      const card = page.locator('[data-screen="paid"]');
      await card.waitFor();
      expect(await card.innerText()).toContain(t.paidText);
      // Кнопка в бота — из /api/auth/config сервера.
      const bot = card.locator("a[data-paid-bot]");
      await bot.waitFor();
      expect(await bot.getAttribute("href")).toBe(`https://t.me/${BOT}`);
      expect(await bot.innerText()).toContain(t.paidBack);
      // Данных заказа нет: ни запроса, ни номера, ни суммы.
      expect(problems.requests.filter((u) => u.startsWith("/api/orders"))).toEqual([]);
      expect(await card.innerText()).not.toContain(String(order.number));
      expect(page.url()).toBe(`${e.base}/app/#/paid/${order.id}`);
      await e.shot(page, `paid-${lang}-390x844.png`);
      await e.expectClean(page, problems);
      await close();
    }
    // Без бота кнопки нет, текст тот же.
    setBot(false);
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { waitText: ru.paidTitle });
    expect(await page.locator("a[data-paid-bot]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("вход по SMS на карточке открывает сам заказ; на сайте токена сессии нет ни в запросе, ни в ответе", async () => {
    const phone = uniquePhone();
    const [owner] = await e.db.insert(users).values({ phone, locale: "ru" }).returning();
    const order = await pendingOrder(owner!.id);
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { waitText: ru.paidTitle });
    const verify = bodiesOf(page, "/api/auth/phone/verify");
    const verified = page.waitForResponse((r) => r.url() === e.base + "/api/auth/phone/verify");
    // «Войти» в шапке сразу открывает лист входа.
    await page.locator("[data-account]").first().click();
    await page.locator("input[name=phone]").fill(phone.slice(3));
    await sheet(page, "login").getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    await page.locator("input[name=code]").fill(e.lastCode(phone)!);
    await page.locator(`[data-order-status="pending"]`).waitFor();
    expect(page.url()).toBe(`${e.base}/app/#/orders/${order.id}`);
    await e.waitText(page, "№ " + order.number);
    // bearer: true уходит только из настоящего Telegram: на сайте сервер токен не отдаёт, сессия — только в cookie.
    expect(verify).toHaveLength(1);
    expect(verify[0]).not.toHaveProperty("bearer");
    const res = await verified;
    expect(await res.json()).toEqual({ status: "ok", redirect: "/app/" });
    expect((await res.headerValue("set-cookie")) ?? "").toMatch(/^session=.+HttpOnly/i);
    await e.expectClean(page, problems);
    await close();
  });

  it("с сессией: сразу экран заказа, адрес — #/orders/<id>", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const order = await pendingOrder(user.id);
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { context, waitText: ru.orderWait });
    await page.locator(`[data-order-status="pending"]`).waitFor();
    expect(page.url()).toBe(`${e.base}/app/#/orders/${order.id}`);
    expect(await page.locator('[data-screen="paid"]').count()).toBe(0);
    await e.waitText(page, "№ " + order.number);
    await e.shot(page, "paid-session-ru-390x844.png");
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });

  it("в браузере, где вошёл другой человек: та же карточка «Оплата завершена», а не «Заказ не найден»", async () => {
    const [owner] = await e.db.insert(users).values({ phone: uniquePhone(), locale: "ru" }).returning();
    const order = await pendingOrder(owner!.id);
    const context = await e.newContext();
    await e.signIn(context);
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { context });
    const card = page.locator('[data-screen="paid"]');
    await card.waitFor();
    expect(await card.innerText()).toContain(ru.paidText);
    expect(await card.innerText()).not.toContain(String(order.number));
    expect(await page.locator(`[data-order-status]`).count()).toBe(0);
    // Единственная ошибка — ответ 404 на чужой заказ в консоли браузера.
    expect(problems.console).toEqual(["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });
});

describe("стёртая дата приглашения", () => {
  it("дата и время, стёртые в конструкторе, не возвращаются; у гостя, в og:title, превью и карточке нет прежней даты", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    // Шаблон-билет: в герое ячейки «Дата», «Время», «Место».
    const inv = await createInvitation(user.id, { template: "party-neon", data: { names: "Дата стёрта", date: "2026-12-26", time: "17:00", venue: "Loft 7", intro: "none" } });
    await e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true }).where(eq(invitations.id, inv.id));
    const slug = (await invOf(inv.id)).slug!;
    // До правки у гостя есть ячейки даты и времени и обратный отсчёт, в og:title — дата.
    const before = await e.open(`/i/${slug}`);
    await waitContent(before.page, "Дата стёрта");
    expect(await before.page.getByText(ru.fDate, { exact: true }).count()).toBeGreaterThan(0);
    expect(await before.page.getByText(ru.fTime, { exact: true }).count()).toBeGreaterThan(0);
    expect(await before.page.locator("[data-cd]").count()).toBeGreaterThan(0);
    await before.close();
    expect((await ogOf(slug))["og:title"]).toBe("Дата стёрта — 26 декабря 2026 г.");

    const { page, problems, close } = await e.open("/app/", { context, waitText: "Дата стёрта" });
    // Карточка в «Моих приглашениях» с датой и временем.
    expect(await page.locator("#my-inv").textContent()).toMatch(/26/);
    // «Поделиться» загружает превью ссылки с датой: оно становится og:image страницы.
    await toShare(page);
    await expect.poll(async () => (await invOf(inv.id)).ogImageUrl ?? "", { timeout: 15_000 }).toMatch(/^\/media\//);
    const dated = (await invOf(inv.id)).ogImageUrl!;
    expect((await ogOf(slug))["og:image"]).toBe(e.base + dated);

    // Конструктор: дата и время стёрты, на «Поделиться» не заходим.
    const sent: Dict[] = [];
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url() === `${e.base}/api/invitations/${inv.id}`) sent.push(r.postDataJSON() as Dict); });
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Дата стёрта");
    await toBuilder(page);
    await page.getByTitle(ru.steps.when).click();
    await page.locator("input[type=date]").first().fill("");
    await page.locator("input[type=time]").first().fill("");
    await expect.poll(async () => { const d = (await invOf(inv.id)).data as Dict; return [d.date, d.time]; }, { timeout: 10_000 }).toEqual(["", ""]);
    // Ушли пустые строки, а не прежнее значение.
    const patches = sent.filter((b) => b.data && ("date" in b.data || "time" in b.data));
    expect(patches.length).toBeGreaterThan(0);
    for (const b of patches) for (const k of ["date", "time"]) if (k in b.data) expect(b.data[k]).toBe("");
    await e.waitText(page, ru.saved);
    // Без даты под переключателем обратного отсчёта пусто, а не «0 дней · 0 часов · 0 минут».
    expect(await page.locator("[data-cdtext]").first().innerText()).toBe("");
    // Превью с прежней датой больше не og:image: до нового превью — обложка, og:title — только имена.
    expect((await invOf(inv.id)).ogImageUrl).toBeNull();
    expect((await e.app.inject({ method: "GET", url: dated })).statusCode).toBe(404);
    const og = await ogOf(slug);
    expect(og["og:title"]).toBe("Дата стёрта");
    expect(og["og:image"] ?? "").not.toContain(dated);

    await page.reload();
    await e.waitText(page, "Дата стёрта");
    // Карточка в «Моих приглашениях» без даты.
    expect(await page.locator("#my-inv").textContent()).not.toMatch(/26|17:00/);
    await toBuilder(page);
    await page.getByTitle(ru.steps.when).click();
    expect(await page.locator("input[type=date]").first().inputValue()).toBe("");
    expect(await page.locator("input[type=time]").first().inputValue()).toBe("");
    await e.shot(page, "build-nodate-ru-390x844.png");

    // «Поделиться»: заголовок превью без даты, новое превью загружено.
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Дата стёрта");
    await toShare(page);
    await expect.poll(async () => (await invOf(inv.id)).ogImageUrl ?? "", { timeout: 15_000 }).toMatch(/^\/media\//);
    expect((await invOf(inv.id)).ogImageUrl).not.toBe(dated);
    expect(await page.locator("pre").innerText()).toContain('<meta property="og:title" content="Дата стёрта">');
    expect(await page.locator("body").innerText()).not.toMatch(/NaN|Invalid Date|26 декабря/);
    await e.shot(page, "share-nodate-ru-390x844.png");
    // Картинки превью и сторис (renderCard) без даты — без плашки даты, а не с пустым цветным прямоугольником:
    // красных пикселей (цвет плашки) справа от фото с датой «1» больше на целую плашку, а не только на цифру.
    // Строкой, а не функцией: import() в функции vitest переписал бы в свой загрузчик.
    const red = (await page.evaluate(`(async () => {
      const E = await import("/app/invito-engine.js");
      const th = { bg: "#000000", accent: "#ff0000", accent2: "#00ff00", ink: "#ffffff", onAccent: "#000000", muted: "#888888", font: "Onest", body: "Onest", wt: 500, fs: 1, key: "plain" };
      const count = async (date) => {
        const img = new Image();
        img.src = await E.renderCard({ W: 1200, H: 630, th, names: "A", kick: "K", date, link: "x", cover: "", tt: "none" });
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 1200; c.height = 630;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(600, 0, 600, 630).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++;
        return n;
      };
      return { empty: await count(""), dated: await count("1") };
    })()`)) as { empty: number; dated: number };
    expect(red.dated - red.empty).toBeGreaterThan(2000);
    await e.expectClean(page, problems);
    await close();

    // Страница гостя: ни пустых ячеек «Дата» и «Время», ни отсчёта, ни календаря; место осталось.
    const after = await e.open(`/i/${slug}`);
    await waitContent(after.page, "Дата стёрта");
    expect(await after.page.getByText(ru.fDate, { exact: true }).count()).toBe(0);
    expect(await after.page.getByText(ru.fTime, { exact: true }).count()).toBe(0);
    expect(await after.page.locator("[data-cd]").count()).toBe(0);
    expect(await after.page.locator("body").innerText()).not.toMatch(/NaN|Invalid Date/);
    await waitContent(after.page, "Loft 7");
    await e.shot(after.page, "guest-nodate-ticket-ru-390x844.png");
    // После ответа нет «Добавить в календарь»: без даты событие в календарь не положить.
    await after.page.locator(`#rsvp input[placeholder="${ru.yourName}"]`).fill("Гость");
    await after.page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await after.page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await waitContent(after.page, ru.thanks);
    expect(await after.page.getByRole("button", { name: ru.addCal }).count()).toBe(0);
    await e.expectClean(after.page, after.problems);
    await after.close();
  });
});

describe("мини-апп: шаг номера", () => {
  it("номер, который бот отклонил: причина и «Попробовать ещё раз»; прежняя ошибка не мешает новой попытке", async () => {
    const h = botHarness(e, BOT);
    const tgId = tgIdOf(7_900_000_000);
    const msg = "Этот номер уже привязан к другому Telegram-аккаунту";
    // Номер уже у аккаунта с другим Telegram.
    const taken = uniquePhone();
    await e.db.insert(users).values({ phone: taken, telegramId: tgId + 1, locale: "ru" });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Shahzod", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const login = sheet(page, "login");
    // Номера ещё нет: шаг номера с объяснением, запрос контакта — по нажатию.
    await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).click();
    await login.locator('[data-wait="phone"]').waitFor();
    await expect.poll(async () => (await tgState(page)).contact).toBe(1);
    // Telegram присылает контакт боту, бот его отклоняет; мини-апп узнаёт причину из /api/auth/webapp.
    await h.contact(tgId, "+" + taken);
    expect(h.replies().at(-1)).toBe(msg);
    await login.getByRole("alert").filter({ hasText: msg }).waitFor({ timeout: 10_000 });
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).waitFor();

    // Мини-апп открыт заново: сразу причина, запрос контакта сам не открывается.
    await page.reload();
    await login.getByRole("alert").filter({ hasText: msg }).waitFor({ timeout: 20_000 });
    expect((await tgState(page)).contact).toBe(0);
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);
    const again = login.getByRole("button", { name: new RegExp(ru.tryAgain) });
    await again.waitFor();
    await e.shot(page, "tg-phone-rejected-ru-390x844.png");

    // Новая попытка: пока бот не получил новый номер, сервер ещё отвечает прежней причиной — она не показывается.
    const webapp = () => problems.requests.filter((u) => u === "/api/auth/webapp").length;
    let n = webapp();
    await again.click();
    await expect.poll(async () => (await tgState(page)).contact).toBe(1);
    await login.locator('[data-wait="phone"]').waitFor();
    await expect.poll(webapp, { timeout: 8_000 }).toBeGreaterThan(n);
    expect(await login.getByRole("alert").count()).toBe(0);
    expect(await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).count()).toBe(1);
    // Снова тот же занятый номер: та же причина — это ответ бота на новую попытку, она показывается.
    await h.contact(tgId, "+" + taken);
    await login.getByRole("alert").filter({ hasText: msg }).waitFor({ timeout: 15_000 });
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);

    // Свой свободный номер: бот его принимает, мини-апп входит.
    const own = uniquePhone();
    n = webapp();
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).click();
    await expect.poll(async () => (await tgState(page)).contact).toBe(2);
    await h.contact(tgId, "+" + own);
    await e.waitText(page, ru.welcome);
    await login.waitFor({ state: "detached" });
    expect(webapp()).toBeGreaterThan(n);
    expect((await byTelegram(tgId))[0]!.phone).toBe(own);
    expect(await e.redis.exists(`inv:tgcontact:rejected:${tgId}`)).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("«Подключить Telegram»", () => {
  /** Аккаунт → «Подключить Telegram»: nonce из ответа /telegram/start (он же в ссылке на бота). */
  async function connect(page: Page) {
    await page.locator("[data-account]").first().click();
    const started = page.waitForResponse((r) => r.url() === e.base + "/api/auth/telegram/start");
    await sheet(page, "account").getByRole("button", { name: new RegExp(ru.tgConnect) }).click();
    const res = await started;
    expect(res.status()).toBe(200);
    const { nonce, url } = (await res.json()) as Dict;
    expect(url).toBe(`https://t.me/${BOT}?start=auth_${nonce}`);
    // Запрос начат с сессией этого аккаунта.
    expect((await res.request().allHeaders()).cookie ?? "").toContain("session=");
    return nonce as string;
  }

  it("Telegram из записи выдачи доступа (без номера): бот просит номер, номер аккаунта — подключается к этому аккаунту, вход не меняется", async () => {
    setBot(true);
    const h = botHarness(e, BOT);
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Нигора" });
    // Админ заранее выдал бесплатный доступ по Telegram ID: запись без номера.
    const tg = tgIdOf(7_910_000_000);
    await e.db.insert(users).values({ telegramId: tg, freeAccess: true, freeAccessNote: "подарок" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const poll = bodiesOf(page, "/api/auth/telegram/poll");
    const nonce = await connect(page);
    const login = sheet(page, "login");
    await login.locator('[data-wait="telegram"]').waitFor();
    expect(await login.locator(`a[href="https://t.me/${BOT}?start=auth_${nonce}"]`).count()).toBe(1);

    // В боте: у Telegram нет номера — сначала он подтверждает номер аккаунта своим контактом,
    // затем подтверждение с номером аккаунта, скрытым посередине.
    await h.message(tg, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    await h.contact(tg, "+" + user.phone);
    const confirm = h.of("sendMessage").at(-1)!.payload;
    expect(confirm.text).toContain(maskPhone(user.phone!));
    expect(confirm.reply_markup.inline_keyboard.flat()).toEqual([{ text: bt("ru", "confirmLinkButton"), callback_data: `auth:${nonce}` }]);
    expect(confirm.text).not.toContain(user.phone!.slice(5, 10));
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(bt("ru", "linkConfirmed", { phone: maskPhone(user.phone!) }));

    await e.waitText(page, ru.tgConnected);
    await login.waitFor({ state: "detached" });
    // Тот же аккаунт с этим Telegram и доступом из выданной записи; записи без номера больше нет.
    expect(await e.user(user.id)).toMatchObject({ telegramId: tg, freeAccess: true, phone: user.phone });
    expect(await byTelegram(tg)).toHaveLength(1);
    const session = (await context.cookies()).find((c) => c.name === "session")!.value;
    expect((e.app.jwt.decode(session) as Dict).sub).toBe(user.id);
    const acc = sheet(page, "account");
    await acc.waitFor();
    // Тот же аккаунт (его номер). Имя теперь из профиля Telegram: бот обновляет его при каждом сообщении
    // (upsertTelegramUser), а после контакта было ещё нажатие «Подключить».
    expect(await acc.innerText()).toContain(formatPhone(user.phone!));
    expect(await acc.getByRole("button", { name: new RegExp(ru.tgConnect) }).count()).toBe(0);
    // На сайте токен в опросе не запрашивается.
    expect(poll.length).toBeGreaterThan(0);
    for (const b of poll) expect(b).toEqual({ nonce });
    await e.shot(page, "tg-connect-ok-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("Telegram другого аккаунта: причина в листе, ничего не привязано, вход не переключается, «Попробовать ещё раз»", async () => {
    setBot(true);
    const h = botHarness(e, BOT);
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Азиз" });
    const tg = tgIdOf(7_920_000_000);
    const [other] = await e.db.insert(users).values({ telegramId: tg, phone: uniquePhone(), firstName: "Другой" }).returning();
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const cookie = (await context.cookies()).find((c) => c.name === "session")!.value;
    const nonce = await connect(page);
    const login = sheet(page, "login");
    await login.locator('[data-wait="telegram"]').waitFor();
    await h.message(tg, `/start auth_${nonce}`);
    await h.press(tg, `auth:${nonce}`);
    expect(h.edits().at(-1)).toBe(TELEGRAM_TAKEN);

    await login.getByRole("alert").filter({ hasText: TELEGRAM_TAKEN }).waitFor({ timeout: 10_000 });
    expect(await login.locator('[data-wait="telegram"]').count()).toBe(0);
    expect(await login.innerText()).toContain(ru.tgConnectHint);
    await e.shot(page, "tg-connect-conflict-ru-390x844.png");
    // Вход прежний: та же cookie, тот же профиль, Telegram не подключён ни к кому другому.
    expect((await context.cookies()).find((c) => c.name === "session")!.value).toBe(cookie);
    expect((await e.user(user.id)).telegramId).toBeNull();
    expect(await e.user(other!.id)).toMatchObject({ telegramId: tg, phone: other!.phone });
    expect((await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).user.id))).toBe(user.id);

    // «Попробовать ещё раз» — новый запрос и снова ожидание бота.
    const again = page.waitForResponse((r) => r.url() === e.base + "/api/auth/telegram/start");
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).click();
    const next = (await (await again).json()) as Dict;
    expect(next.nonce).not.toBe(nonce);
    await login.locator('[data-wait="telegram"]').waitFor();
    await login.getByRole("button", { name: ru.cancel }).click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    expect(await acc.innerText()).toContain("Азиз");
    expect(await acc.getByRole("button", { name: new RegExp(ru.tgConnect) }).count()).toBe(1);
    expect(await page.textContent("body")).not.toContain(ru.tgOtherAccount.split(":")[0]);
    await e.expectClean(page, problems);
    await close();
  });

  it("ссылка подключения у чужого Telegram: бот просит номер, другой номер — причина в листе, ничего не привязано, вход прежний", async () => {
    setBot(true);
    const h = botHarness(e, BOT);
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Мадина" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const cookie = (await context.cookies()).find((c) => c.name === "session")!.value;
    const nonce = await connect(page);
    const login = sheet(page, "login");
    await login.locator('[data-wait="telegram"]').waitFor();

    // Ссылку t.me/<бот>?start=auth_<nonce> открыл другой человек в своём Telegram без номера:
    // бот просит номер, кнопки «Подключить» и номера аккаунта он не видит.
    const attacker = tgIdOf(7_940_000_000);
    await h.message(attacker, `/start auth_${nonce}`);
    expect(h.replies()).toEqual([bt("ru", "askPhoneLink")]);
    const own = uniquePhone();
    await h.contact(attacker, "+" + own);
    expect(h.replies().at(-1)).toBe(TELEGRAM_PHONE_MISMATCH);
    expect(h.replies().join("\n")).not.toContain(maskPhone(user.phone!));
    expect(h.of("sendMessage").some((c) => c.payload.reply_markup?.inline_keyboard)).toBe(false);
    // Повтор нажатия «Подключить» после отказа ничего не делает.
    await h.press(attacker, `auth:${nonce}`);
    expect(h.edits()).toEqual([bt("ru", "loginExpired")]);

    // Сайт: причина в листе, ожидания нет, вход прежний — та же cookie и тот же профиль.
    await login.getByRole("alert").filter({ hasText: TELEGRAM_PHONE_MISMATCH }).waitFor({ timeout: 10_000 });
    expect(await login.locator('[data-wait="telegram"]').count()).toBe(0);
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).waitFor();
    await e.shot(page, "tg-connect-mismatch-ru-390x844.png");
    expect((await context.cookies()).find((c) => c.name === "session")!.value).toBe(cookie);
    expect((await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).user))).toMatchObject({ id: user.id, telegramId: null });
    // Аккаунт не изменился; Telegram нападающего — отдельный аккаунт с его собственным номером.
    expect(await e.user(user.id)).toMatchObject({ telegramId: null, phone: user.phone, firstName: "Мадина" });
    const [row] = await byTelegram(attacker);
    expect(row).toMatchObject({ phone: own });
    expect(row!.id).not.toBe(user.id);
    expect(await page.textContent("body")).not.toContain(ru.tgOtherAccount.split(":")[0]);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("мини-апп во фрейме чужого сайта (Telegram Web)", () => {
  it("cookie не сохраняется: вход по initData с токеном, без «Выйти», перезагрузка фрейма; bearer у SMS-входа", async () => {
    const tgId = tgIdOf(7_930_000_000);
    const phone = uniquePhone();
    await e.db.insert(users).values({ telegramId: tgId, phone, firstName: "Камола", locale: "ru" });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Камола", language_code: "ru" });
    // Telegram Web: страница web.telegram.org с мини-аппом во фрейме (её отдаёт тест). Доступ публичного сайта
    // к 127.0.0.1 (Local Network Access) разрешён, иначе Chromium ждёт ответа на запрос разрешения.
    await context.grantPermissions(["local-network-access"], { origin: TG_WEB });
    await context.route(`${TG_WEB}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Telegram</title><body style="margin:0"><iframe src="${e.base}/app/" style="width:390px;height:844px;border:0"></iframe></body>` }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const api: { path: string; bearer: boolean }[] = [];
    page.on("request", (r) => { if (r.url().startsWith(e.base + "/api/")) api.push({ path: r.url().slice(e.base.length), bearer: /^Bearer /.test(r.headers().authorization ?? "") }); });
    await page.goto(`${TG_WEB}/k/`);
    const frame = () => page.frames().find((f) => f.url().startsWith(e.base + "/app/"))!;
    const app = page.frameLocator("iframe");
    const accountSheet = app.locator('[data-sheet="account"]');
    const sessionCookie = async () => (await context.cookies(e.base)).find((c) => c.name === "session");
    const loggedIn = async () => {
      await app.locator("[data-account]").first().click();
      await accountSheet.waitFor();
      await accountSheet.getByText("Камола").first().waitFor();
    };

    // Вход по initData: сервер ставит cookie, но во фрейме чужого сайта она не сохраняется — работает токен.
    await waitContent(frame(), ru.hero1);
    await loggedIn();
    expect(await sessionCookie()).toBeUndefined();
    const me = api.filter((r) => r.path === "/api/auth/me");
    expect(me.length).toBeGreaterThan(0);
    expect(me.every((r) => r.bearer)).toBe(true);
    await e.shot(page, "tg-web-frame-ru-390x844.png");

    // В мини-аппе вход — аккаунт Telegram: «Выйти» нет (он вернул бы тот же аккаунт), вместо него пояснение.
    expect(await accountSheet.getByRole("button", { name: ru.logout }).count()).toBe(0);
    await accountSheet.getByText(ru.tgSessionNote).waitFor();

    // Перезагрузка фрейма: токен был только в памяти, вход по initData снова, без cookie.
    await frame().evaluate(() => location.reload());
    await expect.poll(async () => { try { return await frame().evaluate(() => document.readyState); } catch { return "loading"; } }).toBe("complete");
    await waitContent(frame(), ru.hero1);
    await loggedIn();
    expect(await sessionCookie()).toBeUndefined();

    // Контракт 3.1: вход по SMS из этого фрейма. Без bearer токена в ответе нет, а cookie не сохранилась —
    // сессии нет; с bearer: true ответ несёт токен, и с ним работает Authorization: Bearer.
    const smsLogin = async (p: string, bearer: boolean) => {
      const f = frame();
      const req = await f.evaluate(async (p) => (await fetch("/api/auth/phone/request", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: p }) })).status, p);
      expect(req).toBe(200);
      return f.evaluate(
        async ({ p, code, bearer }) => {
          const r = await fetch("/api/auth/phone/verify", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: p, code, ...(bearer && { bearer: true }) }) });
          const body = await r.json();
          const me = (h: Record<string, string>) => fetch("/api/auth/me", { credentials: "include", headers: h }).then((x) => x.status);
          return { status: r.status, body, cookieOnly: await me({}), withToken: body.token ? await me({ authorization: "Bearer " + body.token }) : 0 };
        },
        { p, code: e.lastCode(p)!, bearer },
      );
    };
    const plain = uniquePhone();
    const noBearer = await smsLogin(plain, false);
    expect(noBearer).toMatchObject({ status: 200, body: { status: "ok", redirect: "/app/" }, cookieOnly: 401, withToken: 0 });
    expect(noBearer.body).not.toHaveProperty("token");
    const withBearer = await smsLogin(phone, true);
    expect(withBearer).toMatchObject({ status: 200, body: { status: "ok", redirect: "/app/" }, cookieOnly: 401, withToken: 200 });
    expect(typeof withBearer.body.token).toBe("string");
    expect(await sessionCookie()).toBeUndefined();
    expect(errors.filter((m) => !/status of 401/.test(m))).toEqual([]);
    await context.close();
  });
});
