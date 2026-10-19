import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { signInitData, startE2E, uniquePhone, type E2E } from "./helpers.js";

/**
 * Приложение Invito в браузере вместе с API (docs/invito-integration.md, раздел 4): вход по SMS
 * и в мини-аппе Telegram, черновики на сервере, языки, файлы, демо тура, ошибки.
 * Во всех сценариях нет ошибок консоли и нарушений CSP; 401 от /api/auth/me без сессии считается отдельно.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const en = I18N.en as Dict;
const D = INVITO as Dict;
let e: E2E;

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.close();
});

// Лимиты запросов (в том числе на коды SMS с одного IP) не переходят из сценария в сценарий.
beforeEach(async () => {
  await e.redis.flushdb();
});

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);

/** Вход по номеру в открытом листе входа: код берётся из SMS тестового провайдера. */
async function smsLogin(page: Page, phone: string, t: Dict = ru) {
  await page.locator("input[name=phone]").fill(phone.slice(3));
  await sheet(page, "login").getByRole("button", { name: t.getCode }).click();
  await page.locator("input[name=code]").waitFor();
  const code = e.lastCode(phone);
  expect(code).toMatch(/^\d{6}$/);
  // Шестая цифра отправляет код сама.
  await page.locator("input[name=code]").fill(code!);
  await sheet(page, "login").waitFor({ state: "detached" });
}

async function toTemplates(page: Page, t: Dict = ru, lang = "ru") {
  await page.getByRole("button", { name: t.create }).first().click();
  await e.waitText(page, t.chooseEvent);
  await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label[lang] }).first().click();
  await page.getByRole("button", { name: t.useTpl }).first().waitFor();
}

const invitationsOf = (userId: string) => e.db.select().from(invitations).where(eq(invitations.userId, userId));

async function userByPhone(phone: string) {
  const [u] = await e.db.select().from(users).where(eq(users.phone, phone));
  return u;
}

/** Приглашение через API от имени пользователя (как его создал бы конструктор). */
async function createInvitation(userId: string, body: Dict) {
  const res = await e.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: `session=${e.app.jwt.sign({ sub: userId })}`, origin: e.base },
    payload: { template: "wedding-classic", mode: "shared", language: "ru", ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Dict;
}

/** Заголовки запросов к API: проверка, что мини-апп ходит с Bearer. */
function recordApi(page: Page) {
  const list: { method: string; path: string; auth?: string }[] = [];
  page.on("request", async (r) => {
    if (!r.url().startsWith(e.base + "/api/")) return;
    const h = await r.allHeaders();
    list.push({ method: r.method(), path: new URL(r.url()).pathname, auth: h.authorization });
  });
  return list;
}

/** Window.Telegram.WebApp мини-аппа: initData подписана ключом бота, кнопки и ссылки записываются в window.__tg. */
async function telegramStub(context: BrowserContext, user: Dict) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify(user) });
  await context.addInitScript(
    ({ initData, user }) => {
      const tg: Dict = { contact: 0, links: [], main: { text: "", visible: false, fn: null }, back: { visible: false, fn: null } };
      (window as any).__tg = tg;
      (window as any).Telegram = {
        WebApp: {
          initData,
          initDataUnsafe: { user },
          version: "8.0",
          platform: "ios",
          colorScheme: "light",
          themeParams: {},
          ready() {},
          expand() {},
          close() { tg.closed = true; },
          // Человек делится номером: бот сохранит его, а мини-апп узнает об этом, повторяя /webapp.
          requestContact(cb?: (ok: boolean) => void) { tg.contact++; setTimeout(() => cb && cb(true), 50); },
          openLink(u: string) { tg.links.push(["link", u]); },
          openTelegramLink(u: string) { tg.links.push(["tg", u]); },
          MainButton: { setText(t: string) { tg.main.text = t; }, show() { tg.main.visible = true; }, hide() { tg.main.visible = false; }, onClick(fn: () => void) { tg.main.fn = fn; } },
          BackButton: { show() { tg.back.visible = true; }, hide() { tg.back.visible = false; }, onClick(fn: () => void) { tg.back.fn = fn; } },
        },
      };
    },
    { initData, user },
  );
}

const tgState = (page: Page) => page.evaluate(() => { const tg = (window as any).__tg; return { contact: tg.contact, links: tg.links, main: { text: tg.main.text, visible: tg.main.visible }, back: tg.back.visible }; });
const tgMain = (page: Page) => page.evaluate(() => (window as any).__tg.main.fn());
const tgBack = (page: Page) => page.evaluate(() => (window as any).__tg.back.fn());

describe("приложение без входа", () => {
  it("главная и шаблоны открываются без входа; «Мои приглашения» просят войти, примеров нет", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    expect(problems.me401).toBe(1);
    const myInv = page.locator("#my-inv");
    await expect.poll(() => myInv.innerText()).toContain(ru.invLoginHint);
    // Выдуманных приглашений на главной нет: ни одной кнопки «Гости» в списке.
    expect(await myInv.getByRole("button", { name: ru.guests }).count()).toBe(0);
    await e.shot(page, "home-ru-390x844.png");
    await toTemplates(page);
    await e.shot(page, "templates-ru-390x844.png");
    // Ни приглашений, ни черновиков без входа не запрашивается.
    expect(problems.requests.filter((u) => u.startsWith("/api/invitations"))).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });

  it("#/login-expired открывает лист входа с объяснением; кнопки Telegram без бота нет", async () => {
    const { page, problems, close } = await e.open("/app/#/login-expired", { waitText: ru.hero1 });
    await sheet(page, "login").waitFor();
    expect(await sheet(page, "login").innerText()).toContain(ru.loginExpired);
    // TELEGRAM_MODE=off: /api/auth/config отдаёт telegram: false.
    expect(await sheet(page, "login").getByText(ru.tgLogin).count()).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe("");
    await e.shot(page, "login-expired-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("тур: демо с гостями из дизайна без запросов к API и с меткой «Демо»", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await page.getByRole("button", { name: ru.tour }).first().click();
    const before = problems.requests.filter((u) => u.startsWith("/api/")).length;
    await page.getByRole("button", { name: new RegExp(ru.demos.guests[0]) }).click();
    await e.waitText(page, "Дилноза Каримова");
    await page.getByText(ru.demo).waitFor();
    await page.waitForTimeout(500);
    await e.shot(page, "demo-guests-ru-390x844.png");
    expect(problems.requests.filter((u) => u.startsWith("/api/")).length).toBe(before);
    // С главной демо выключается, гостей больше нет.
    await page.getByRole("button", { name: "Invito" }).first().click();
    await e.waitText(page, ru.hero1);
    expect(await page.getByText(ru.demo).count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("сбой /api/auth/me: приложение без входа и тост; ошибки рантайма скрыты", async () => {
    const context = await e.newContext();
    await context.route(e.base + "/api/auth/me", (route) => route.fulfill({ status: 503, body: "" }));
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await e.waitText(page, ru.errServer);
    expect(await page.locator("[data-account]").innerText()).toContain(ru.login);
    // .sc-logic-error рантайма не показывается людям (ошибка остаётся в консоли).
    const hidden = await page.evaluate(() => { const d = document.createElement("div"); d.className = "sc-logic-error"; d.textContent = "x"; document.body.appendChild(d); const v = getComputedStyle(d).display; d.remove(); return v; });
    expect(hidden).toBe("none");
    expect(problems.page).toEqual([]);
    expect(await e.csp(page)).toEqual([]);
    await close();
  });
});

describe("вход и черновики", () => {
  it("вход по SMS из «Выбрать шаблон», черновик на сервере, автосохранение переживает перезагрузку", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await toTemplates(page);
    await page.getByRole("button", { name: ru.useTpl }).first().click();
    await sheet(page, "login").waitFor();
    expect(await sheet(page, "login").innerText()).toContain(ru.loginHint);
    await e.shot(page, "login-phone-ru-390x844.png");
    const phone = uniquePhone();
    await page.locator("input[name=phone]").fill(phone.slice(3));
    await sheet(page, "login").getByRole("button", { name: ru.getCode }).click();
    await page.locator("input[name=code]").waitFor();
    await e.shot(page, "login-code-ru-390x844.png");
    // Неверный код: ошибка сервера в листе, поле очищается.
    await page.locator("input[name=code]").fill(e.lastCode(phone) === "000000" ? "111111" : "000000");
    await sheet(page, "login").getByRole("alert").waitFor();
    await page.locator("input[name=code]").fill(e.lastCode(phone)!);
    await sheet(page, "login").waitFor({ state: "detached" });
    // После входа действие продолжается: черновик создан, открыт конструктор.
    await e.waitText(page, ru.welcome);
    await page.getByLabel(ru.fNames).waitFor();
    const user = await userByPhone(phone);
    expect(user).toBeTruthy();
    await expect.poll(async () => (await invitationsOf(user!.id)).length).toBe(1);
    await expect.poll(() => page.locator("body").innerText()).toMatch(new RegExp(ru.saved + " · \\d\\d:\\d\\d"));
    // Правка имён уходит на сервер через 700 мс.
    await page.getByLabel(ru.fNames).fill("Мадина и Азиз");
    await expect.poll(async () => (await invitationsOf(user!.id))[0]!.data.names, { timeout: 10_000 }).toBe("Мадина и Азиз");
    // Язык приглашения отдельно от интерфейса: тексты по умолчанию переводятся, правленые остаются.
    await page.getByRole("button", { name: D.LANG_NAMES.uz }).first().click();
    await expect.poll(async () => (await invitationsOf(user!.id))[0]!.language, { timeout: 10_000 }).toBe("uz");
    const saved = (await invitationsOf(user!.id))[0]!;
    expect(saved.data.names).toBe("Мадина и Азиз");
    expect(saved.data.host).toBe(D.EVENTS.wedding.text.uz.host);
    await expect.poll(() => page.locator("body").innerText()).toMatch(new RegExp(ru.saved + " · \\d\\d:\\d\\d"));
    await e.shot(page, "build-ru-390x844.png");
    // Ответ 400 на неверный код Chromium пишет в консоль сам; других ошибок нет.
    const bad = "Failed to load resource: the server responded with a status of 400 (Bad Request)";
    expect(problems.console).toEqual([bad]);
    problems.console = [];
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(1);

    // После перезагрузки: вход сохранился, приглашение в списке и открывается с сохранёнными данными.
    problems.me401 = 0;
    await page.reload();
    await e.waitText(page, "Мадина и Азиз");
    expect(problems.me401).toBe(0);
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).click();
    await expect.poll(() => page.getByLabel(ru.fNames).inputValue()).toBe("Мадина и Азиз");
    expect(await page.getByLabel(ru.fNames).count()).toBeGreaterThan(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("«Мои приглашения»: копия и удаление с подтверждением, пустой список", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await createInvitation(user.id, { data: { names: "Дилноза и Бобур" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Дилноза и Бобур" });
    const myInv = page.locator("#my-inv");
    await myInv.getByRole("button", { name: ru.duplicate }).click();
    await e.waitText(page, ru.duplicated);
    await expect.poll(() => myInv.getByRole("button", { name: ru.duplicate }).count()).toBe(2);
    expect(await invitationsOf(user.id)).toHaveLength(2);
    await myInv.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await e.shot(page, "my-invitations-ru-390x844.png");
    await myInv.getByRole("button", { name: ru.deleteD }).first().click();
    await sheet(page, "confirm").waitFor();
    expect(await sheet(page, "confirm").innerText()).toContain("Дилноза и Бобур");
    await e.shot(page, "confirm-delete-ru-390x844.png");
    await sheet(page, "confirm").getByRole("button", { name: ru.deleteD }).click();
    await e.waitText(page, ru.deleted);
    await expect.poll(async () => (await invitationsOf(user.id)).length).toBe(1);
    await myInv.getByRole("button", { name: ru.deleteD }).click();
    await sheet(page, "confirm").getByRole("button", { name: ru.deleteD }).click();
    await expect.poll(() => myInv.innerText()).toContain(ru.noInv);
    expect(await invitationsOf(user.id)).toHaveLength(0);
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });

  it("файл: картинка уменьшается до 2000 px и загружается в /api/media, адрес сохраняется в черновике", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await createInvitation(user.id, { data: { names: "Фото тест" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Фото тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).click();
    await page.getByTitle(ru.steps.photos).click();
    // PNG 3000×1500 из canvas страницы.
    const b64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 3000; c.height = 1500; const x = c.getContext("2d")!; const g = x.createLinearGradient(0, 0, 3000, 1500); g.addColorStop(0, "#d4452a"); g.addColorStop(1, "#1a1714"); x.fillStyle = g; x.fillRect(0, 0, 3000, 1500); return c.toDataURL("image/png").split(",")[1]!; });
    await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
    await expect.poll(async () => (await invitationsOf(user.id))[0]!.data.cover ?? "", { timeout: 15_000 }).toMatch(/^\/media\/[0-9a-f-]{36}\.jpg$/);
    const cover = (await invitationsOf(user.id))[0]!.data.cover!;
    const size = await page.evaluate((src) => new Promise<number[]>((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([0, 0]); i.src = src; }), cover);
    expect(size).toEqual([2000, 1000]);
    // Не картинка и не звук/видео: тост, ничего не загружается.
    await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await e.waitText(page, ru.fileType);
    // Текст «за меня» без ключа ассистента (config.ai: false) — готовый текст дизайна на языке приглашения.
    await page.getByTitle(ru.steps.words).click();
    await page.getByRole("button", { name: ru.aiWrite }).click();
    await e.waitText(page, ru.aiFail);
    expect(problems.requests.filter((u) => u.startsWith("/api/ai/"))).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });

  it("сохранение без сети: тост и «Не сохранено», затем повтор сохраняет", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Сеть тест" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Сеть тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).click();
    await context.route(e.base + "/api/invitations/" + inv.id, (route) => (route.request().method() === "PATCH" ? route.abort() : route.continue()));
    await page.getByLabel(ru.fNames).fill("Сеть вернулась");
    await e.waitText(page, ru.errNetwork);
    await e.waitText(page, ru.notSaved);
    await context.unroute(e.base + "/api/invitations/" + inv.id);
    await expect.poll(async () => (await invitationsOf(user.id))[0]!.data.names, { timeout: 15_000 }).toBe("Сеть вернулась");
    await expect.poll(() => page.locator("body").innerText()).toMatch(new RegExp(ru.saved + " · \\d\\d:\\d\\d"));
    // Ошибки консоли здесь ожидаемы: оборванный запрос и его разбор.
    expect(problems.page).toEqual([]);
    expect(await e.csp(page)).toEqual([]);
    await close();
  });
});

describe("языки", () => {
  it("язык интерфейса: без входа — в браузере, при входе — в профиле; язык профиля важнее", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").waitFor();
    await e.shot(page, "account-out-ru-390x844.png");
    await sheet(page, "account").getByRole("button", { name: D.LANG_NAMES.uz }).click();
    await e.waitText(page, uz.hero1);
    expect(await page.evaluate(() => localStorage.getItem("invito.lang"))).toBe("uz");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("uz-Latn");
    // Без входа язык не уходит на сервер.
    expect(problems.requests.filter((u) => u.startsWith("/api/auth/me")).length).toBe(1);
    await page.reload();
    await e.waitText(page, uz.hero1);
    await e.shot(page, "home-uz-390x844.png");
    // Вход в узбекском интерфейсе: новый аккаунт получает язык интерфейса.
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").getByRole("button", { name: uz.login }).click();
    await sheet(page, "login").waitFor();
    await e.shot(page, "login-phone-uz-390x844.png");
    const phone = uniquePhone();
    await smsLogin(page, phone, uz);
    const user = (await userByPhone(phone))!;
    expect(user.locale).toBe("uz");
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").waitFor();
    // Имени в профиле нет (вход по SMS): заголовок аккаунта — номер.
    expect(await sheet(page, "account").innerText()).toContain(`+998 ${phone.slice(3, 5)} ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`);
    expect(await sheet(page, "account").innerText()).toContain(uz.subNone);
    await e.shot(page, "account-uz-390x844.png");
    // Смена языка после входа сохраняется в профиле (PATCH /api/auth/me).
    await sheet(page, "account").getByRole("button", { name: D.LANG_NAMES.en }).click();
    await expect.poll(async () => (await e.user(user.id)).locale).toBe("en");
    await e.expectClean(page, problems);
    await close();

    // Другой браузер без localStorage: язык из профиля.
    const context = await e.newContext();
    await context.addCookies([{ name: "session", value: e.app.jwt.sign({ sub: user.id }), url: e.base }]);
    const second = await e.open("/app/", { context, waitText: en.hero1 });
    await e.expectClean(second.page, second.problems);
    await second.close();
  });

  it("экраны на узбекском: шаблоны, конструктор, «не найдено»", async () => {
    const context = await e.newContext({ locale: "uz-UZ" });
    const user = await e.signIn(context, { locale: "uz" });
    await createInvitation(user.id, { language: "uz", data: { names: "Malika va Jasur" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Malika va Jasur" });
    await page.locator("#my-inv").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await e.shot(page, "my-invitations-uz-390x844.png");
    await page.locator("#my-inv").getByRole("button", { name: uz.edit }).click();
    await page.getByLabel(uz.fNames).waitFor();
    await page.waitForTimeout(400);
    await e.shot(page, "build-uz-390x844.png");
    await page.getByRole("button", { name: "Invito" }).first().click();
    await toTemplates(page, uz, "uz");
    await e.shot(page, "templates-uz-390x844.png");
    await e.expectClean(page, problems);
    const nf = await e.open("/i/no-such-slug", { context, status: 404, waitText: uz.nfTitle });
    await e.shot(nf.page, "notfound-uz-390x844.png");
    await nf.close();
    await close();
  });
});

describe("мини-апп Telegram", () => {
  it("вход по initData даже при cookie другого аккаунта; номер через requestContact; дальше Bearer", async () => {
    const tgId = 7_000_000_000 + Math.floor(Math.random() * 1e6);
    const context = await e.newContext();
    // Cookie прежнего аккаунта в этом браузере не должна подменить человека из Telegram.
    const other = await e.signIn(context);
    await telegramStub(context, { id: tgId, first_name: "Ali", last_name: "Valiyev", language_code: "uz" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: uz.hero1 });
    const calls = recordApi(page);
    // Номера нет: лист «Поделиться номером», Telegram спрашивает контакт.
    await sheet(page, "login").getByRole("button", { name: new RegExp(uz.sharePhone) }).waitFor();
    await expect.poll(async () => (await tgState(page)).contact).toBeGreaterThan(0);
    await e.shot(page, "tg-share-phone-uz-390x844.png");
    // Поддельной шапки и кнопки Telegram на странице нет: работают настоящие MainButton и BackButton.
    expect(await page.getByText("← " + uz.back).count()).toBe(0);
    expect(problems.requests).toContain("/api/auth/webapp");
    expect(problems.requests).toContain("/api/auth/logout");
    expect(problems.requests.filter((u) => u === "/api/auth/me")).toEqual([]);
    // Бот получил контакт: номер в базе, мини-апп повторяет /webapp не чаще раза в 3 секунды.
    const phone = uniquePhone();
    const t0 = Date.now();
    await e.db.update(users).set({ phone }).where(eq(users.telegramId, tgId));
    await e.waitText(page, uz.welcome, 15_000);
    expect(Date.now() - t0).toBeLessThan(8000);
    await sheet(page, "login").waitFor({ state: "detached" });
    const me = calls.find((c) => c.path === "/api/auth/me");
    expect(me?.auth).toMatch(/^Bearer \S+$/);
    const tg = await tgState(page);
    expect(tg.main).toEqual({ text: uz.create, visible: true });
    expect(tg.back).toBe(false);
    // Без cookie (как в Telegram Web) всё идёт по Bearer: черновик создаётся от имени человека из Telegram.
    await context.clearCookies();
    await tgMain(page);
    await e.waitText(page, uz.chooseEvent);
    expect((await tgState(page)).back).toBe(true);
    await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label.uz }).first().click();
    await expect.poll(async () => (await tgState(page)).main.text).toBe(uz.useTpl);
    expect(await page.getByRole("button", { name: uz.useTpl }).count()).toBe(0);
    await tgMain(page);
    await page.getByLabel(uz.fNames).waitFor();
    const tgUser = (await e.db.select().from(users).where(eq(users.telegramId, tgId)))[0]!;
    expect(tgUser.phone).toBe(phone);
    await expect.poll(async () => (await invitationsOf(tgUser.id)).length).toBe(1);
    expect(await invitationsOf(other.id)).toHaveLength(0);
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/invitations")?.auth).toMatch(/^Bearer /);
    // BackButton: шаг назад из конструктора.
    await tgBack(page);
    await page.getByLabel(uz.fNames).waitFor({ state: "detached" });
    await e.shot(page, "tg-templates-uz-390x844.png");
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });

  it("человек с номером входит сразу: профиль Telegram, Bearer, ссылки t.me через openTelegramLink", async () => {
    const tgId = 7_100_000_000 + Math.floor(Math.random() * 1e6);
    const phone = uniquePhone();
    await e.db.insert(users).values({ telegramId: tgId, phone, firstName: "Nodira", locale: "ru" });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Nodira", language_code: "uz" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    // Язык профиля (ru) важнее языка Telegram (uz).
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").waitFor();
    expect(await sheet(page, "account").innerText()).toContain("Nodira");
    expect(await sheet(page, "account").innerText()).toContain(ru.tgConnected);
    expect((await tgState(page)).back).toBe(true);
    // BackButton закрывает лист.
    await tgBack(page);
    await sheet(page, "account").waitFor({ state: "detached" });
    await page.evaluate(() => { const a = document.createElement("a"); a.href = "https://t.me/invito_bot"; a.target = "_blank"; a.textContent = "bot"; document.body.appendChild(a); a.click(); a.href = "https://example.com/x"; a.click(); a.remove(); });
    expect((await tgState(page)).links).toEqual([["tg", "https://t.me/invito_bot"], ["link", "https://example.com/x"]]);
    expect(problems.requests.filter((u) => u === "/api/auth/webapp")).toHaveLength(1);
    await e.expectClean(page, problems);
    expect(problems.me401).toBe(0);
    await close();
  });
});
