import { eq, sql } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, users } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Общий контракт этапа 4 (docs/invito-integration.md, 3.1 и 3.9) со стороны фронтенда: возврат после оплаты
 * из мини-аппа (#/paid/<id>), стёртая дата приглашения, ошибка номера в мини-аппе и «Подключить Telegram»,
 * когда этот Telegram уже у другого аккаунта. Ответы, которых сервер этого коммита ещё не умеет, подменяются
 * в самих сценариях (page.route / context.route) — об этом сказано рядом с каждой подменой.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const LANGS = ["ru", "en", "uz", "uzc"] as const;
const BOT = "invito_e2e_bot";
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
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}

const createInvitation = (userId: string, body: Dict) => apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
const invOf = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;

/** Заказ шаблона в ожидании оплаты (тестовый провайдер), как его создал бы мини-апп. */
async function pendingOrder(userId: string) {
  const inv = await createInvitation(userId, { data: { names: "Оплата из Telegram", intro: "none" } });
  const r = await apiAs(userId, "POST", "/api/orders", { kind: "template", invitationId: inv.id, returnTo: "telegram" });
  expect(r.status).toBe("pending");
  return r.order as Dict;
}

/**
 * Бот в конфигурации: в проверках TELEGRAM_MODE=off, и /api/auth/config отвечает telegram: false, botUsername: null.
 * Ответ сервера подменяется только в этих полях.
 */
async function withBot(context: BrowserContext) {
  await context.route(`${e.base}/api/auth/config`, async (route) => {
    const res = await route.fetch();
    const cfg = (await res.json()) as Dict;
    await route.fulfill({ response: res, json: { ...cfg, telegram: true, botUsername: BOT } });
  });
}

/** Текст в DOM без учёта text-transform (в шаблоне-билете имена набраны заглавными). */
const waitContent = (page: Page, text: string) => page.waitForFunction((x) => (document.body.textContent || "").includes(x), text, { timeout: 20_000 });

/** Тела POST-запросов страницы к пути API. */
function bodiesOf(page: Page, path: string) {
  const out: Dict[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === e.base + path) out.push((r.postDataJSON() as Dict) || {});
  });
  return out;
}

describe("возврат после оплаты из мини-аппа (#/paid/<id>)", () => {
  it("без входа: карточка «Оплата завершена» на четырёх языках, кнопка в бота, заказ не запрашивается", async () => {
    const [owner] = await e.db.insert(users).values({ phone: uniquePhone(), locale: "ru" }).returning();
    const order = await pendingOrder(owner!.id);
    for (const lang of LANGS) {
      const t = I18N[lang] as Dict;
      const context = await e.newContext();
      await withBot(context);
      await context.addInitScript((l) => { try { localStorage.setItem("invito.lang", l); } catch (x) {} }, lang);
      const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { context, waitText: t.paidTitle });
      const card = page.locator('[data-screen="paid"]');
      await card.waitFor();
      expect(await card.innerText()).toContain(t.paidText);
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
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { waitText: ru.paidTitle });
    expect(await page.locator("a[data-paid-bot]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("вход по SMS на карточке открывает сам заказ; на сайте токен сессии не запрашивается", async () => {
    const phone = uniquePhone();
    const [owner] = await e.db.insert(users).values({ phone, locale: "ru" }).returning();
    const order = await pendingOrder(owner!.id);
    const { page, problems, close } = await e.open(`/app/#/paid/${order.id}`, { waitText: ru.paidTitle });
    const verify = bodiesOf(page, "/api/auth/phone/verify");
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").getByRole("button", { name: new RegExp("^" + ru.login) }).click();
    await page.locator("input[name=phone]").fill(phone.slice(3));
    await sheet(page, "login").getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    await page.locator("input[name=code]").fill(e.lastCode(phone)!);
    await page.locator(`[data-order-status="pending"]`).waitFor();
    expect(page.url()).toBe(`${e.base}/app/#/orders/${order.id}`);
    await e.waitText(page, "№ " + order.number);
    // bearer: true уходит только из настоящего Telegram: на сайте токен не отдаётся скриптам страницы.
    expect(verify).toHaveLength(1);
    expect(verify[0]).not.toHaveProperty("bearer");
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
});

describe("стёртая дата приглашения", () => {
  it("дата и время, стёртые в конструкторе, не возвращаются после перезагрузки; у гостя нет пустых «Дата» и «Время»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    // Шаблон-билет: в герое ячейки «Дата», «Время», «Место».
    const inv = await createInvitation(user.id, { template: "party-neon", data: { names: "Дата стёрта", date: "2026-12-26", time: "17:00", venue: "Loft 7", intro: "none" } });
    await e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true }).where(eq(invitations.id, inv.id));
    const slug = (await invOf(inv.id)).slug!;
    // До правки у гостя есть ячейки даты и времени и обратный отсчёт.
    const before = await e.open(`/i/${slug}`);
    await waitContent(before.page, "Дата стёрта");
    expect(await before.page.getByText(ru.fDate, { exact: true }).count()).toBeGreaterThan(0);
    expect(await before.page.getByText(ru.fTime, { exact: true }).count()).toBeGreaterThan(0);
    expect(await before.page.locator("[data-cd]").count()).toBeGreaterThan(0);
    await before.close();

    // Принимает ли сервер пустую дату (контракт 3.2: "" и null в PATCH). Если нет (сервер этого коммита),
    // PATCH страницы подменяется: тело уходит на сервер без пустых даты и времени, ключи удаляются в базе,
    // как это делает сервер по контракту, а в ответ идёт свежий GET. Запрос страницы проверяется как есть.
    // Проба — у другого пользователя, чтобы не попасть в «Мои приглашения» этого.
    const [other] = await e.db.insert(users).values({ phone: uniquePhone(), locale: "ru" }).returning();
    const probe = await createInvitation(other!.id, { data: { names: "Проба", date: "2026-12-26" } });
    const res = await e.app.inject({ method: "PATCH", url: `/api/invitations/${probe.id}`, headers: { cookie: cookieOf(other!.id), origin: e.base }, payload: { data: { date: "" } } });
    const serverOk = res.statusCode < 300;
    const sent: Dict[] = [];
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Дата стёрта" });
    await page.route(`${e.base}/api/invitations/${inv.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON() as Dict;
      sent.push(body);
      if (serverOk) return route.continue();
      const data = { ...(body.data || {}) }, drop = ["date", "time"].filter((k) => k in data && (data[k] === "" || data[k] === null));
      drop.forEach((k) => delete data[k]);
      const r = await route.fetch({ postData: JSON.stringify({ ...body, data }) });
      if (r.status() >= 300) return route.fulfill({ response: r });
      for (const k of drop) await e.db.update(invitations).set({ data: sql`${invitations.data} - ${k}` }).where(eq(invitations.id, inv.id));
      return route.fulfill({ json: await apiAs(user.id, "GET", `/api/invitations/${inv.id}`) });
    });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.steps.when).click();
    await page.locator("input[type=date]").first().fill("");
    await page.locator("input[type=time]").first().fill("");
    await expect.poll(async () => { const d = (await invOf(inv.id)).data as Dict; return [d.date ?? "", d.time ?? ""]; }, { timeout: 10_000 }).toEqual(["", ""]);
    // Ушли пустая строка или null (удалить ключ), а не прежнее значение.
    const last = sent.filter((b) => b.data && ("date" in b.data || "time" in b.data));
    expect(last.length).toBeGreaterThan(0);
    for (const b of last) for (const k of ["date", "time"]) if (k in b.data) expect(["", null]).toContain(b.data[k]);
    await e.waitText(page, ru.saved);
    // Без даты под переключателем обратного отсчёта пусто, а не «0 дней · 0 часов · 0 минут».
    expect(await page.locator("[data-cdtext]").first().innerText()).toBe("");

    await page.reload();
    await e.waitText(page, "Дата стёрта");
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.steps.when).click();
    expect(await page.locator("input[type=date]").first().inputValue()).toBe("");
    expect(await page.locator("input[type=time]").first().inputValue()).toBe("");
    await e.shot(page, "build-nodate-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();

    // Страница гостя: ни пустых ячеек «Дата» и «Время», ни отсчёта, ни календаря; место осталось.
    if (!serverOk) await e.redis.flushdb();
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
  it("номер, который бот отклонил: причина и «Попробовать ещё раз» вместо «Ждём номер…», прежняя ошибка не мешает новой попытке", async () => {
    const tgId = 7_900_000_000 + Math.floor(Math.random() * 1e6);
    const msg = "Этот номер уже привязан к другому Telegram-аккаунту";
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Shahzod", language_code: "ru" });
    // Сервер этого коммита не отдаёт error в phone_required (контракт 3.1, п. 2): ответ подменяется,
    // пока reject; потом запрос идёт на настоящий сервер.
    let reject = true;
    await context.route(`${e.base}/api/auth/webapp`, (route) => (reject ? route.fulfill({ json: { status: "phone_required", error: msg } }) : route.continue()));
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const login = sheet(page, "login");
    await login.getByRole("alert").filter({ hasText: msg }).waitFor();
    // Запрос контакта сам не открывается: сначала причина, затем выбор человека.
    expect((await tgState(page)).contact).toBe(0);
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);
    const again = login.getByRole("button", { name: new RegExp(ru.tryAgain) });
    await again.waitFor();
    await e.shot(page, "tg-phone-rejected-ru-390x844.png");

    // Новая попытка: пока бот не получил новый номер, сервер ещё отвечает прежней ошибкой — она не показывается.
    const webapp = () => problems.requests.filter((u) => u === "/api/auth/webapp").length;
    let n = webapp();
    await again.click();
    expect((await tgState(page)).contact).toBe(1);
    await login.locator('[data-wait="phone"]').waitFor();
    await expect.poll(webapp, { timeout: 8_000 }).toBeGreaterThan(n);
    expect(await login.getByRole("alert").count()).toBe(0);
    expect(await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).count()).toBe(1);
    // Та же ошибка и через 8 секунд после отправки номера: это ответ бота на новый номер.
    await login.getByRole("alert").filter({ hasText: msg }).waitFor({ timeout: 15_000 });
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);

    // Номер привязан (в боте или в другом аккаунте разобрались): ещё одна попытка входит.
    await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Shahzod", locale: "ru" });
    reject = false;
    n = webapp();
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).click();
    await e.waitText(page, ru.welcome);
    await login.waitFor({ state: "detached" });
    expect(webapp()).toBeGreaterThan(n);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("«Подключить Telegram»", () => {
  it("Telegram уже у другого аккаунта: причина в листе, вход не переключается, «Попробовать ещё раз»", async () => {
    const context = await e.newContext();
    await withBot(context);
    const user = await e.signIn(context, { firstName: "Азиз" });
    const conflict = "Этот Telegram уже привязан к другому аккаунту.";
    // Сервер этого коммита не запускает вход без бота (TELEGRAM_MODE=off): start и poll подменяются по контракту 3.1, п. 3.
    const starts: string[] = [];
    await context.route(`${e.base}/api/auth/telegram/start`, (route) => {
      starts.push(route.request().headers().cookie || "");
      return route.fulfill({ json: { nonce: "a".repeat(32), url: `https://t.me/${BOT}?start=auth_${"a".repeat(32)}`, ttl: 300 } });
    });
    await context.route(`${e.base}/api/auth/telegram/poll`, (route) => route.fulfill({ json: { status: "conflict", error: conflict } }));
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const poll = bodiesOf(page, "/api/auth/telegram/poll");
    const cookie = (await context.cookies()).find((c) => c.name === "session")!.value;
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").getByRole("button", { name: new RegExp(ru.tgConnect) }).click();
    const login = sheet(page, "login");
    await login.locator('[data-wait="telegram"]').waitFor();
    await login.getByRole("alert").filter({ hasText: conflict }).waitFor({ timeout: 10_000 });
    // start ушёл с сессией: сервер запоминает, к какому аккаунту подключать.
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("session=" + cookie);
    expect(poll[0]).toEqual({ nonce: "a".repeat(32) });
    expect(await login.locator('[data-wait="telegram"]').count()).toBe(0);
    expect(await login.innerText()).toContain(ru.tgConnectHint);
    await e.shot(page, "tg-connect-conflict-ru-390x844.png");
    // Вход прежний: та же cookie, тот же профиль, Telegram не подключён.
    expect((await context.cookies()).find((c) => c.name === "session")!.value).toBe(cookie);
    expect((await e.user(user.id)).telegramId).toBeNull();
    // «Попробовать ещё раз» — новая ссылка на бота и снова ожидание.
    await login.getByRole("button", { name: new RegExp(ru.tryAgain) }).click();
    await expect.poll(() => starts.length).toBe(2);
    await login.getByRole("alert").filter({ hasText: conflict }).waitFor({ timeout: 10_000 });
    await login.getByRole("button", { name: ru.cancel }).click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    expect(await acc.innerText()).toContain("Азиз");
    expect(await acc.getByRole("button", { name: new RegExp(ru.tgConnect) }).count()).toBe(1);
    expect(await page.textContent("body")).not.toContain(ru.tgOtherAccount.split(":")[0]);
    await e.expectClean(page, problems);
    await close();
  });
});
