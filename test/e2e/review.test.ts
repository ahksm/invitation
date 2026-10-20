import { eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guests, invitations, subscriptions, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO, plural, toCyr } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Исправления после проверки в браузере (этап 3): вход в мини-аппе без чужой cookie, номер из Telegram,
 * «Назад» из черновика, камера на входе, длинные списки гостей, язык предпросмотра, выключенные шаблоны,
 * сохранение при закрытии, пустая дата, повтор оплаты подписки, тексты (toCyr, числа, суммы).
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const en = I18N.en as Dict;
const uzc = I18N.uzc as Dict;
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

const failed = (code: number, text: string) => `Failed to load resource: the server responded with a status of ${code} (${text})`;
const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}

const createInvitation = (userId: string, body: Dict) => apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
const invOf = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const guestsOf = (id: string) => e.db.select().from(guests).where(eq(guests.invitationId, id));

async function personalWith(userId: string, list: Dict[], body: Dict = {}, paidSeats = list.length) {
  const inv = await createInvitation(userId, { mode: "personal", ...body });
  await e.db.update(invitations).set({ status: "active", publishedAt: new Date(), paidSeats }).where(eq(invitations.id, inv.id));
  const added = list.length ? ((await apiAs(userId, "POST", `/api/invitations/${inv.id}/guests`, { guests: list })) as unknown as Dict[]) : [];
  return { inv, added };
}

/** Текст в DOM без учёта text-transform (подписи шаблонов набраны заглавными). */
const content = (page: Page) => page.evaluate(() => document.body.textContent || "");

const tgBack = (page: Page) => page.evaluate(() => (window as any).__tg.back.fn());

describe("тексты дизайна", () => {
  it("toCyr: тутуқ белгиси ’ даёт «ъ», Smart casual и бренды не меняются", () => {
    expect(toCyr("E’lon qilingan")).toBe("Эълон қилинган");
    expect(toCyr("Iliq neytral ranglar ma’qul.")).toBe("Илиқ нейтрал ранглар маъқул.");
    expect(toCyr("She’riy")).toBe("Шеърий");
    expect(toCyr("ma’lumot")).toBe("маълумот");
    expect(toCyr("Smart casual. Bitiruv")).toBe("Smart casual. Битирув");
    expect(toCyr("Invito’da yaratilgan")).toBe("Invito’да яратилган");
    for (const [lat, cyr] of [["yo‘nalish", "йўналиш"], ["O‘zbekcha", "Ўзбекча"], ["ko‘chasi", "кўчаси"], ["ta'lim", "таълим"]]) expect(toCyr(lat!)).toBe(cyr);
    // В словаре uzc апостроф остаётся только после бренда.
    const dict = JSON.stringify(uzc);
    expect(dict.match(/’/g)).toHaveLength(1);
    expect(dict).toContain("Invito’да");
  });

  it("числа: формы слова для ru и en, узбекские существительные не меняются", () => {
    const n = (lang: string, k: number, v: unknown) => plural(lang, k, v);
    expect([1, 2, 5, 11, 21, 22].map((k) => k + " " + n("ru", k, ru.replies))).toEqual(["1 ответ", "2 ответа", "5 ответов", "11 ответов", "21 ответ", "22 ответа"]);
    expect([1, 2].map((k) => k + " " + n("en", k, en.replies))).toEqual(["1 reply", "2 replies"]);
    expect(n("ru", 1, ru.act.sms).replace("{n}", "1")).toBe("SMS отправлено 1 гостю");
    expect(n("ru", 3, ru.act.reminder).replace("{n}", "3")).toBe("Напоминание отправлено 3 гостям");
    expect(n("ru", 2, ru.comingN)).toBe("гостя ответили «да»");
    expect(n("en", 1, en.comingN)).toBe("guest said yes");
    expect(n("ru", 34, ru.cdN.m) + " · " + n("ru", 1, ru.cdN.d)).toBe("минуты · день");
    expect(n("uz", 2, I18N.uz.replies)).toBe("javob");
    expect(n("uzc", 5, uzc.replies)).toBe("жавоб");
  });
});

describe("мини-апп: вход", () => {
  it("ошибка /webapp не подхватывает cookie другого аккаунта: лист входа через Telegram с ошибкой и повтором", async () => {
    const tgId = 7_200_000_000 + Math.floor(Math.random() * 1e6);
    const phone = uniquePhone();
    await e.db.insert(users).values({ telegramId: tgId, phone, firstName: "Bekzod", locale: "ru" });
    const context = await e.newContext();
    const other = await e.signIn(context, { firstName: "Азиз" });
    await createInvitation(other.id, { data: { names: "Чужое приглашение", intro: "none" } });
    // initData двухдневной давности: сервер отвечает 401.
    await telegramStub(context, { id: tgId, first_name: "Bekzod", language_code: "ru" }, { authDate: Math.floor(Date.now() / 1000) - 2 * 86400 });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const login = sheet(page, "login");
    await login.waitFor();
    await e.waitText(page, ru.tgAuthFail);
    expect(await login.locator("input[name=phone]").count()).toBe(0);
    await login.getByRole("button", { name: new RegExp(ru.tgLogin) }).waitFor();
    expect(await content(page)).not.toContain("Чужое приглашение");
    // Профиль по cookie не запрашивался, а сама cookie закрыта.
    expect(problems.requests.filter((u) => u === "/api/auth/me")).toEqual([]);
    expect(problems.requests).toContain("/api/auth/logout");
    expect((await context.cookies()).find((c) => c.name === "session")?.value || "").toBe("");
    await e.shot(page, "tg-auth-failed-ru-390x844.png");
    expect(problems.console.every((m) => m === failed(401, "Unauthorized") || /Telegram/.test(m))).toBe(true);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("сбой /webapp (503) повторяется, а после «Выйти» вход снова через Telegram, без SMS", async () => {
    const tgId = 7_300_000_000 + Math.floor(Math.random() * 1e6);
    const phone = uniquePhone();
    await e.db.insert(users).values({ telegramId: tgId, phone, firstName: "Dilnoza", locale: "ru" });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Dilnoza", language_code: "ru" });
    let webapp = 0;
    await context.route(`${e.base}/api/auth/webapp`, (route) => (++webapp === 1 ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Сервис недоступен"}' }) : route.continue()));
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    // Через 3 секунды вторая попытка входит; листа входа нет.
    await expect.poll(() => webapp, { timeout: 10_000 }).toBe(2);
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").waitFor();
    await e.waitText(page, "Dilnoza");
    expect(await sheet(page, "login").count()).toBe(0);
    // «Выйти» → «Войти»: в мини-аппе — кнопка «Войти через Telegram», а не номер и SMS.
    await sheet(page, "account").getByRole("button", { name: ru.logout }).click();
    await e.waitText(page, ru.loggedOut);
    await page.locator("[data-account]").first().click();
    await sheet(page, "account").getByRole("button", { name: new RegExp("^" + ru.login) }).click();
    const login = sheet(page, "login");
    await login.waitFor();
    expect(await login.locator("input[name=phone]").count()).toBe(0);
    expect(await login.innerText()).toContain(ru.tgAuthHint);
    await login.getByRole("button", { name: new RegExp(ru.tgLogin) }).click();
    await e.waitText(page, ru.welcome);
    await login.waitFor({ state: "detached" });
    expect(webapp).toBe(3);
    expect(problems.console.filter((m) => m !== failed(503, "Service Unavailable") && !/HTTP 503|Сервис недоступен/.test(m))).toEqual([]);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("отказ поделиться номером и номер, который бот не принял: подсказка и ошибка вместо «Ждём номер…»", async () => {
    const tgId = 7_400_000_000 + Math.floor(Math.random() * 1e6);
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Jasur", language_code: "ru" }, { contactOk: false });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    const login = sheet(page, "login");
    await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).waitFor();
    await expect.poll(async () => (await login.textContent()) || "").toContain(ru.phoneDeclined);
    expect(await login.textContent()).not.toContain(ru.tgWaitPhone);
    await e.shot(page, "tg-phone-declined-ru-390x844.png");
    // Бот ответил, что номер привязан к другому Telegram: ошибка в листе, опрос /webapp останавливается.
    const msg = "Этот номер уже привязан к другому Telegram-аккаунту";
    await context.route(`${e.base}/api/auth/webapp`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "phone_required", error: msg }) }));
    await page.evaluate(() => { (window as any).__contactOk = true; });
    await login.getByRole("button", { name: new RegExp(ru.sharePhone) }).click();
    await login.getByRole("alert").filter({ hasText: msg }).waitFor();
    expect(await login.locator('[data-wait="phone"]').count()).toBe(0);
    const n = problems.requests.filter((u) => u === "/api/auth/webapp").length;
    await page.waitForTimeout(4000);
    expect(problems.requests.filter((u) => u === "/api/auth/webapp").length).toBe(n);
    await e.expectClean(page, problems);
    await close();
  });

  it("аккаунт: номер не из Узбекистана как в боте, конец подписки по Ташкенту, админка — во внешнем браузере", async () => {
    const tgId = 7_500_000_000 + Math.floor(Math.random() * 1e6);
    const phone = "7916" + String(Date.now() % 1e7).padStart(7, "0");
    const [u] = await e.db.insert(users).values({ telegramId: tgId, phone, firstName: "Иван", locale: "ru" }).returning();
    // 01:30 19 ноября по Ташкенту — это ещё 18-е по UTC.
    await e.db.insert(subscriptions).values({ userId: u!.id, startsAt: new Date(), endsAt: new Date("2027-11-18T20:30:00Z") });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Иван", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await page.locator("[data-account]").first().click();
    const acc = sheet(page, "account");
    await acc.waitFor();
    expect(await acc.locator("[data-phone]").innerText()).toBe("+" + phone);
    expect(await acc.innerText()).toContain(ru.subActive.replace("{date}", "19 ноября 2027 г."));
    // Админ (права по ADMIN_TELEGRAM_IDS выдаются при входе): «Админка» открывается во внешнем браузере, фрейм остаётся.
    e.config.ADMIN_TELEGRAM_IDS.push(String(tgId));
    try {
      await page.reload();
      await e.waitText(page, ru.hero1);
      await page.locator("[data-account]").first().click();
      await acc.getByRole("button", { name: new RegExp(ru.adminPanel) }).click();
      await expect.poll(async () => (await tgState(page)).links).toEqual([["link", e.base + "/admin/"]]);
      expect(page.url()).toBe(e.base + "/app/");
    } finally {
      e.config.ADMIN_TELEGRAM_IDS.splice(e.config.ADMIN_TELEGRAM_IDS.indexOf(String(tgId)), 1);
    }
    await e.expectClean(page, problems);
    await close();
  });
});

describe("мини-апп: экраны", () => {
  it("«Открыть» у черновика, затем BackButton: главная, а не «Ссылка готова»", async () => {
    const tgId = 7_600_000_000 + Math.floor(Math.random() * 1e6);
    const [u] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Malika", locale: "ru" }).returning();
    await createInvitation(u!.id, { data: { names: "Черновик назад", intro: "none" } });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Malika", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Черновик назад" });
    await page.locator("#my-inv").getByRole("button", { name: ru.open + " ↗" }).first().click();
    await page.locator("#rsvp").waitFor();
    expect((await tgState(page)).back).toBe(true);
    await tgBack(page);
    await e.waitText(page, ru.myInv);
    const text = await content(page);
    expect(text).not.toContain(ru.linkReady);
    expect((await tgState(page)).main.text).toBe(ru.create);
    await e.expectClean(page, problems);
    await close();
  });

  it("камера на входе: в Telegram — встроенный сканер, отметка гостя по QR", async () => {
    const tgId = 7_700_000_000 + Math.floor(Math.random() * 1e6);
    const [u] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Sardor", locale: "ru" }).returning();
    const { inv, added } = await personalWith(u!.id, [{ name: "Гость Сканер" }], { data: { names: "Сканер тест", intro: "none" } });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Sardor", language_code: "ru" }, { scanQr: true });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Сканер тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    await page.getByRole("button", { name: new RegExp("^" + ru.checkin) }).first().click();
    await page.getByRole("button", { name: ru.useCamera }).click();
    await expect.poll(async () => (await tgState(page)).scans).toBe(1);
    // Сканер прочитал личную ссылку гостя: отметка на сервере, сканер закрывается (true).
    const closed = await page.evaluate((link) => (window as any).__tg.scanFn(link), `${e.base}/g/${added[0]!.token}`);
    expect(closed).toBe(true);
    await expect.poll(async () => !!(await guestsOf(inv.id))[0]!.checkedInAt).toBe(true);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("экран гостей", () => {
  it("камера в браузере: без BarcodeDetector не включается и подсказывает; с ним выключается при уходе с вкладки", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await personalWith(user.id, [{ name: "Гость Камера" }], { data: { names: "Камера тест", intro: "none" } });
    await context.addInitScript(() => {
      const w = window as any;
      w.__gum = 0;
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { w.__gum++; const c = document.createElement("canvas"); c.width = 8; c.height = 8; c.getContext("2d")!.fillRect(0, 0, 8, 8); const s = (c as any).captureStream(5); w.__stream = s; return s; } } });
      if (sessionStorage.getItem("detector")) w.BarcodeDetector = class { static async getSupportedFormats() { return ["qr_code"]; } async detect() { return []; } };
    });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Камера тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    await page.getByRole("button", { name: new RegExp("^" + ru.checkin) }).first().click();
    await page.getByRole("button", { name: ru.useCamera }).click();
    await e.waitText(page, ru.noScanner.replace("{btn}", ru.checkIn));
    expect(await page.evaluate(() => (window as any).__gum)).toBe(0);
    // С BarcodeDetector камера включается и выключается, как только уходят на другую вкладку.
    await page.evaluate(() => sessionStorage.setItem("detector", "1"));
    await page.reload();
    await e.waitText(page, "Камера тест");
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    await page.getByRole("button", { name: new RegExp("^" + ru.checkin) }).first().click();
    await page.getByRole("button", { name: ru.useCamera }).click();
    await page.getByRole("button", { name: ru.stop }).waitFor();
    expect(await page.evaluate(() => (window as any).__stream.getTracks()[0].readyState)).toBe("live");
    await page.getByRole("button", { name: new RegExp("^" + ru.guestList) }).first().click();
    await expect.poll(() => page.evaluate(() => (window as any).__stream.getTracks()[0].readyState)).toBe("ended");
    await e.expectClean(page, problems);
    await close();
  });

  it("номера не рвутся посередине, «Напомнить ожидающим · N» совпадает с подтверждением", async () => {
    const context = await e.newContext({ viewport: { width: 360, height: 800 } });
    const user = await e.signIn(context);
    // Мест 2 на трёх гостей: напоминание получат только два ждущих с оплаченным местом.
    await personalWith(user.id, [
      { name: "Азиза Саидова", phone: "+998991234567" },
      { name: "Рустам Ахмедов", phone: "+998901000002" },
      { name: "Ойбек Наримов", phone: "+998901000003" },
    ], { data: { names: "Напоминание тест", intro: "none" } }, 2);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Напоминание тест" });
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    const row = page.locator('[data-guest="Азиза Саидова"]');
    await row.waitFor();
    expect(await row.textContent()).toContain("+998 99 123‑45‑67");
    // Номер в одну строку или с разрывом только между группами («+998 99» / «123‑45‑67»): не больше двух строк.
    const tops = await row.evaluate((el) => { const sp = [...el.querySelectorAll("span")].find((s) => s.textContent!.startsWith("+998"))!; const r = document.createRange(); r.selectNodeContents(sp); return [...new Set([...r.getClientRects()].map((x) => Math.round(x.top)))]; });
    expect(tops.length).toBeLessThanOrEqual(2);
    const btn = page.getByRole("button", { name: new RegExp("^" + ru.remind + " · ") });
    expect(await btn.innerText()).toBe(ru.remind + " · 2");
    await btn.click();
    await sheet(page, "confirm").waitFor();
    expect(await sheet(page, "confirm").innerText()).toContain(ru.remindQ.replace("{n}", "2"));
    await sheet(page, "confirm").getByRole("button", { name: ru.cancel }).click();
    await e.shot(page, "guests-phones-ru-360x800.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("600 гостей списком: частями по 500, список окном по 100 с «Показать ещё»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { inv } = await personalWith(user.id, [], { data: { names: "Большой список", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Большой список" });
    const posts: number[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/invitations/${inv.id}/guests`)) posts.push((r.postDataJSON() as Dict).guests.length); });
    await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
    await page.getByRole("button", { name: "+ " + ru.addGuests }).first().click();
    const add = sheet(page, "guests");
    await add.waitFor();
    await add.locator("textarea").fill(Array.from({ length: 600 }, (_, i) => "Гость " + (i + 1)).join("\n"));
    await add.locator('[data-add="list"]').click();
    await e.waitText(page, ru.added + " · 600", 30_000);
    expect(posts).toEqual([500, 100]);
    expect(await guestsOf(inv.id)).toHaveLength(600);
    await add.getByRole("button", { name: ru.close, exact: true }).first().click();
    await add.waitFor({ state: "detached" });
    await expect.poll(() => page.locator("[data-guest]").count()).toBe(100);
    const more = page.locator('[data-more="guests"]');
    expect(await more.innerText()).toBe(ru.showMore.replace("{n}", "500"));
    await more.click();
    await expect.poll(() => page.locator("[data-guest]").count()).toBe(300);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("конструктор", () => {
  it("предпросмотр — на языке приглашения, печать — по имени, без даты — без пустых ячеек", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { locale: "ru" });
    await createInvitation(user.id, { language: "en", data: { names: "Anna & Timur", date: "2026-12-26", time: "17:00", venue: "Garden Hall", intro: "none" } });
    await createInvitation(user.id, { template: "party-neon", data: { names: "Без даты", venue: "Loft", intro: "none" } });
    await createInvitation(user.id, { data: { names: "Мадина и Тимур", intro: "envelope" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Anna & Timur" });
    const openCard = async (names: string) => {
      await page.locator("#my-inv [data-rv]").filter({ hasText: names }).getByRole("button", { name: ru.open + " ↗" }).click();
    };
    // Английское приглашение при русском интерфейсе: подписи и даты на английском, как у гостей.
    await openCard("Anna & Timur");
    await page.locator("#rsvp").waitFor();
    const enText = await content(page);
    for (const s of [en.youreInvited, en.rsvp, en.yes, en.madeWith]) expect(enText).toContain(s);
    expect(enText).toContain("26 December 2026");
    for (const s of [ru.youreInvited, ru.rsvp, ru.madeWith]) expect(enText).not.toContain(s);
    await e.shot(page, "preview-en-in-ru-390x844.png");
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Без даты");
    // Билет (neon) без даты и времени: только «Где».
    await openCard("Без даты");
    await page.locator("#rsvp").waitFor();
    const heroText = await page.locator("section").first().evaluate((el) => el.textContent || "");
    expect(heroText).toContain(ru.venue);
    expect(heroText).not.toContain(ru.fDate);
    expect(heroText).not.toContain(ru.fTime);
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Мадина и Тимур");
    // Печать конверта: первые буквы имён, а не «МН».
    await openCard("Мадина и Тимур");
    await page.getByText("МТ", { exact: true }).first().waitFor();
    await e.expectClean(page, problems);
    await close();
  });

  it("стёртые дата и время уходят на сервер пустыми; у текста приглашения предел 3000 знаков", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Дата стёрта", date: "2026-12-26", time: "17:00", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Дата стёрта" });
    // Сервер этого коммита ещё не принимает пустую дату: ответ PATCH подменяется, проверяется тело запроса.
    const bodies: Dict[] = [];
    await page.route(`${e.base}/api/invitations/${inv.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON() as Dict;
      bodies.push(body);
      const cur = await apiAs(user.id, "GET", `/api/invitations/${inv.id}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...cur, data: { ...cur.data, ...body.data }, updatedAt: new Date().toISOString() }) });
    });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    expect(await page.getByLabel(ru.fNames).getAttribute("maxlength")).toBe("200");
    await page.getByTitle(ru.steps.words).click();
    expect(await page.getByLabel(ru.fMessage).getAttribute("maxlength")).toBe("3000");
    await page.getByTitle(ru.steps.when).click();
    await page.locator("input[type=date]").first().fill("");
    await page.locator("input[type=time]").first().fill("");
    await expect.poll(() => bodies.some((b) => b.data && b.data.date === "" && b.data.time === ""), { timeout: 10_000 }).toBe(true);
    await e.expectClean(page, problems);
    await close();
  });

  it("закрытие страницы во время автосохранения: последняя правка уходит сразу, не дожидаясь ответа", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Версия 0", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Версия 0" });
    const sent: string[] = [];
    let first = true;
    await page.route(`${e.base}/api/invitations/${inv.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      sent.push((route.request().postDataJSON() as Dict).data?.names);
      // Ответ на первое автосохранение задерживается на 3 секунды.
      if (first) { first = false; await new Promise((r) => setTimeout(r, 3000)); }
      return route.continue();
    });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    const names = page.getByLabel(ru.fNames);
    await names.fill("Версия 1");
    await expect.poll(() => sent.length).toBe(1);
    await names.fill("Версия 2");
    // Страницу сворачивают (или закрывают): правка уходит, пока первое сохранение ещё ждёт ответа.
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => sent.length, { timeout: 1500 }).toBe(2);
    expect(sent[1]).toBe("Версия 2");
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); });
    await expect.poll(async () => (await invOf(inv.id)).data.names, { timeout: 10_000 }).toBe("Версия 2");
    await e.expectClean(page, problems);
    await close();
  });

  it("шаблон, выключенный в админке, не предлагается: выбирается первый активный", async () => {
    const [classic] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    await e.db.update(templates).set({ isActive: false }).where(eq(templates.id, classic!.id));
    try {
      const context = await e.newContext();
      const user = await e.signIn(context);
      const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
      await page.getByRole("button", { name: ru.create }).first().click();
      await e.waitText(page, ru.chooseEvent);
      await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label.ru }).first().click();
      await page.getByRole("button", { name: ru.useTpl }).first().waitFor();
      const names = await page.locator("[data-ci]").evaluateAll((els) => els.map((el) => el.textContent || ""));
      expect(names).toHaveLength(4);
      expect(names.some((x) => x.includes(D.EVENTS.wedding.names[0]))).toBe(false);
      await page.getByRole("button", { name: ru.useTpl }).first().click();
      await page.getByLabel(ru.fNames).waitFor();
      const [dto] = await e.db.select().from(invitations).where(eq(invitations.userId, user.id));
      const [tpl] = await e.db.select().from(templates).where(eq(templates.id, dto!.templateId!));
      expect(tpl!.slug).toBe("wedding-botanical");
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ isActive: true }).where(eq(templates.id, classic!.id));
    }
  });
});

describe("тема", () => {
  it("тёмная тема из «Возможностей» переживает перезагрузку (и возврат со страницы оплаты)", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: ru.hero1 });
    await page.getByRole("button", { name: ru.tour }).first().click();
    await e.waitText(page, ru.tourTitle);
    await page.getByRole("button", { name: new RegExp(ru.demos.dark[0]) }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("invito.theme"))).toBe("dark");
    await page.reload();
    await e.waitText(page, ru.hero1);
    const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('[style*="min-height: 100vh"]')!).backgroundColor);
    await expect.poll(bg).toBe("rgb(21, 19, 17)");
    await e.expectClean(page, problems);
    await close();
  });
});

describe("узкий экран (320 px)", () => {
  it("заголовок главной на 320 px мельче (с 375 px — как в дизайне); «Оплачено мест» переносится под заголовок, а не за край карточки", async () => {
    const narrow = { width: 320, height: 800 };
    const c1 = await e.newContext({ viewport: narrow });
    await c1.addInitScript(() => { try { localStorage.setItem("invito.lang", "uzc"); } catch {} });
    const home = await e.open("/app/", { context: c1, waitText: uzc.hero1 });
    // 14.5vw на 320 px (46.4 px) вместо 54 px: «таклифномалар.» шрифтом Cormorant Garamond помещается в экран.
    // Ширину слова здесь не проверить: шрифты в проверках заглушены, а запасной DejaVu Serif намного шире.
    const h1Size = () => home.page.evaluate(() => getComputedStyle(document.querySelector("h1")!).fontSize);
    expect(await h1Size()).toBe("46.4px");
    await home.page.setViewportSize({ width: 375, height: 800 });
    await expect.poll(h1Size).toBe("54px");
    await home.close();

    const context = await e.newContext({ viewport: narrow });
    const user = await e.signIn(context);
    await personalWith(user.id, [{ name: "Анна" }, { name: "Бобур" }, { name: "Севара" }], { data: { names: "Узкий экран", intro: "none" } }, 2);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Узкий экран" });
    // Опубликованное: «Получить ссылку» прямо с карточки «Мои приглашения».
    await page.locator("#my-inv [data-inv-share]").first().click();
    const links = page.locator("[data-personal-links]");
    const badge = links.getByText(ru.seatsLine.replace("{paid}", "2").replace("{n}", "3"), { exact: true });
    await badge.waitFor();
    const [b, box] = await Promise.all([badge.boundingBox(), links.boundingBox()]);
    // Внутренний отступ карточки 18 px: бейдж кончается до него.
    expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width - 17);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("оплата", () => {
  it("отказ в оплате подписки: «Попробовать снова» снова открывает лист оплаты того же приглашения", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await createInvitation(user.id, { data: { names: "Подписка повтор", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Подписка повтор" });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: "✎ " + ru.toEditor }).click();
    await page.getByRole("button", { name: new RegExp("^" + ru.toShare) }).first().click();
    const pay = sheet(page, "pay");
    await pay.locator('[data-pay="sub"]').click();
    await page.locator('[data-screen="mock-pay"]').waitFor();
    await page.locator('[data-mock="failed"]').click();
    await page.locator('[data-order-status="failed"]').waitFor();
    await page.getByRole("button", { name: new RegExp("^" + ru.orderRetry) }).click();
    await pay.waitFor();
    expect(await pay.innerText()).toContain(ru.payTitle);
    expect(page.url()).toBe(`${e.base}/app/`);
    // Контекст заказа удалён, когда ушли с экрана заказа.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("invito.order.")))).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });
});
