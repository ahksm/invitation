import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, orders, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Конец пути владельца: сохранение → ссылка → отправка → оплата. Новое приглашение без выдуманного телефона,
 * поля из примера шаблона перед публикацией, карточка «Всё готово» с ценой и одна основная кнопка, нижняя панель
 * шагов на телефоне, сохранение («в разделе «Мои приглашения»», «Повторить») в шагах и в редакторе, инструменты
 * редактора с подписями, лист оплаты с итогом, защита от двойного нажатия, «Поделиться» (WhatsApp, системное
 * меню, OG-теги под «Дополнительно», личные ссылки в Telegram и SMS), загрузки в мини-аппе Telegram и ответ гостя.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const D = INVITO as Dict;
const W = D.EVENTS.wedding;
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
const invsOf = (userId: string) => e.db.select().from(invitations).where(eq(invitations.userId, userId));
const ordersOf = (id: string) => e.db.select().from(orders).where(eq(orders.invitationId, id));
const activate = (id: string, values: Partial<typeof invitations.$inferInsert> = {}) =>
  e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true, ...values }).where(eq(invitations.id, id));
const cardOf = (page: Page, names: string) => page.locator("#my-inv [data-rv]").filter({ hasText: names });

/** Сумма так, как её пишет приложение: Intl браузера, тийины в сумы. */
const money = (page: Page, amount: number) =>
  page.evaluate(([a, c]) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format((a as number) / 100) + " " + c, [amount, ru.sum]);

async function priceOfTemplate(userId: string) {
  const me = await apiAs(userId, "GET", "/api/auth/me");
  const [tpl] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
  return (tpl!.price ?? me.prices.sharedTemplate) as number;
}

/** Новое приглашение из интерфейса: «Создать» → свадьба → «Использовать шаблон» → первый шаг конструктора. */
async function newDraft(page: Page, t: Dict = ru, lang = "ru") {
  await page.getByRole("button", { name: t.create }).first().click();
  await e.waitText(page, t.chooseEvent);
  await page.locator("[data-rv]").filter({ hasText: W.label[lang] }).first().click();
  await page.getByRole("button", { name: t.useTpl }).first().click();
  await page.getByLabel(t.fNames).waitFor();
}

/** Элемент виден в точке своего центра (его не закрывают панель шагов или полоска предпросмотра). */
const onTop = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });

/** Записывает window.open и navigator.share: ссылки WhatsApp, Telegram и системного меню «Поделиться». */
async function recordShares(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as any;
    w.__opened = [];
    w.__shared = [];
    w.open = (u: string) => { w.__opened.push(u); return null; };
    Object.defineProperty(navigator, "share", { configurable: true, value: (d: unknown) => { w.__shared.push(d); return Promise.resolve(); } });
  });
}

describe("конец конструктора", () => {
  it("новое приглашение: без выдуманного телефона, шаг из N, «Сохранено … в разделе «Мои приглашения»», «Всё готово» сверху с ценой и одной основной кнопкой", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await newDraft(page);
    // Черновик на сервере без контакта-примера: пример — только подсказка в пустом поле.
    await expect.poll(async () => (await invsOf(user.id)).length).toBe(1);
    const [dto] = await invsOf(user.id);
    expect(dto!.data.contact || "").toBe("");
    expect(dto!.data.names).toBe(W.text.ru.names);
    // Шапка: один счётчик шагов в строку, сохранение говорит, где лежит черновик.
    expect(await page.locator("[data-step-of]").textContent()).toBe(ru.stepOf.replace("{n}", "1").replace("{total}", "9"));
    expect(await page.getByText(ru.flow3).count()).toBe(0);
    await page.locator('[data-save="saved"]').waitFor();
    expect(await page.locator('[data-save="saved"]').textContent()).toContain(ru.savedWhere);
    expect(await page.locator("body").innerText()).toMatch(new RegExp(ru.saved + " · \\d\\d:\\d\\d"));
    // Короткий шаг: панель «Назад / Далее» прижата к низу экрана, а не висит посередине.
    await page.getByTitle(ru.steps.when).click();
    const nav = (await page.locator("[data-build-nav]").boundingBox())!;
    expect(Math.round(nav.y + nav.height)).toBe(844);
    // «Детали»: контакт пустой с примером-подсказкой; низ шага не закрыт полоской предпросмотра и панелью.
    await page.getByTitle(ru.steps.details).click();
    const contact = page.locator("input[name=contact]");
    expect(await contact.inputValue()).toBe("");
    expect(await contact.getAttribute("placeholder")).toBe(ru.phEg.replace("{x}", W.text.ru.contact));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    expect(await onTop(page, "input[name=contact]")).toBe(true);
    await e.shot(page, "finish-details-bottom-ru-390x844.png");
    // Последний шаг: «Всё готово» сразу на экране, цена публикации, примеры — кнопками к их шагам.
    await page.getByTitle(ru.stepsX.sections).click();
    const fin = page.locator("[data-finish]");
    await fin.waitFor();
    const editorBtn = fin.getByRole("button", { name: "✎ " + ru.toEditor });
    const eb = (await editorBtn.boundingBox())!;
    expect(eb.y + eb.height).toBeLessThan(844 - 79 - 64);
    expect(await onTop(page, "[data-finish] button")).toBe(true);
    // Цена общей ссылки — точная цена шаблона, без «от»: персональные приглашения считаются отдельно, за гостя.
    const price = await money(page, await priceOfTemplate(user.id));
    await expect.poll(() => fin.locator('[data-finish-price="price"]').textContent()).toBe(ru.pubPrice + " · " + price);
    expect(await fin.innerText()).toContain(ru.finishD);
    expect(await fin.locator("[data-smp]").evaluateAll((els) => els.map((x) => x.getAttribute("data-smp")))).toEqual(["names", "date", "venue", "address", "program", "dress", "photos"]);
    // Одна основная кнопка «Получить ссылку →» — в нижней панели, с ценой под ней.
    expect(await page.getByRole("button", { name: ru.toShare + " →" }).count()).toBe(1);
    expect(await page.locator('[data-next="share"] [data-next-price]').textContent()).toBe(price);
    await e.shot(page, "finish-card-ru-390x844.png");
    // Кнопка примера ведёт к его шагу.
    await fin.locator('[data-smp="venue"]').click();
    await page.locator("input[name=venue]").waitFor();
    expect(await page.locator("input[name=venue]").inputValue()).toBe(W.text.ru.venue);
    expect(await page.locator("[data-step-of]").textContent()).toBe(ru.stepOf.replace("{n}", "3").replace("{total}", "9"));
    await e.expectClean(page, problems);
    await close();
  });

  it("примеры шаблона: подтверждение перед оплатой со списком, «Изменить» ведёт к полю, лист оплаты с итогом; двойное нажатие — один заказ", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.hero1 });
    await newDraft(page);
    await page.getByTitle(ru.stepsX.sections).click();
    await page.locator('[data-next="share"]').click();
    const cf = sheet(page, "confirm");
    await cf.waitFor();
    expect(await cf.innerText()).toContain(ru.smpTitle);
    expect(await cf.locator("[data-cf-items] li").allTextContents()).toEqual([ru.fNames, ru.fDate, ru.fVenue, ru.fAddress, ru.fStops, ru.fDress, ru.smpPhotos]);
    await e.shot(page, "finish-samples-ru-390x844.png");
    expect(await sheet(page, "pay").count()).toBe(0);
    // «Изменить» — к первому полю из примера (имена), лист оплаты не открывается.
    await cf.getByRole("button", { name: ru.edit, exact: true }).click();
    await cf.waitFor({ state: "detached" });
    await page.getByLabel(ru.fNames).fill("Мадина и Азиз");
    expect(await page.locator("[data-step-of]").textContent()).toBe(ru.stepOf.replace("{n}", "1").replace("{total}", "9"));
    // Исправленные имена больше не в списке; «Всё равно опубликовать» — лист оплаты.
    await page.getByTitle(ru.stepsX.sections).click();
    await page.locator('[data-next="share"]').click();
    await cf.waitFor();
    expect(await cf.locator("[data-cf-items] li").allTextContents()).toEqual([ru.fDate, ru.fVenue, ru.fAddress, ru.fStops, ru.fDress, ru.smpPhotos]);
    await cf.getByRole("button", { name: ru.smpAnyway }).click();
    const pay = sheet(page, "pay");
    await pay.waitFor();
    // Лист: «Оплата и публикация», что покупается (имена, шаблон, тип ссылки) и что будет после оплаты.
    expect(await pay.innerText()).toContain(ru.payTitlePub);
    await expect.poll(() => pay.locator("[data-pay-what]").innerText()).toContain("Мадина и Азиз");
    expect(await pay.locator("[data-pay-what]").textContent()).toContain(ru.payWhat.replace("{tpl}", ru.stName[W.styles[0]]).replace("{mode}", ru.payShared));
    expect(await pay.locator("[data-pay-after]").textContent()).toBe(ru.payAfter);
    await e.shot(page, "finish-pay-ru-390x844.png");
    // Согласие запомнено: тот же набор полей больше не спрашивается.
    await pay.getByRole("button", { name: ru.close }).click();
    await pay.waitFor({ state: "detached" });
    await page.locator('[data-next="share"]').click();
    await pay.waitFor();
    expect(await cf.count()).toBe(0);
    // Два нажатия «Оплатить» до перерисовки (в одной задаче браузера) — один заказ.
    const [dto] = await invsOf(user.id);
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url() === e.base + "/api/orders") sent.push(r.url()); });
    await pay.locator('[data-pay="go"]').evaluate((b) => { (b as HTMLButtonElement).click(); (b as HTMLButtonElement).click(); });
    await page.locator('[data-screen="mock-pay"]').waitFor();
    expect(sent).toHaveLength(1);
    expect(await ordersOf(dto!.id)).toHaveLength(1);
    await e.expectClean(page, problems);
    await close();
  });

  it("сохранение с ошибкой: «Не сохранено» и «Повторить» в шапке шага и в редакторе, повтор сохраняет", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Сохранение тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Сохранение тест" });
    await cardOf(page, "Сохранение тест").getByRole("button", { name: ru.edit }).click();
    await page.getByLabel(ru.fNames).waitFor();
    // Сервер отвечает 400 на сохранение: автоповтора нет, в шапке — «Не сохранено» и «Повторить».
    let fail = true;
    await page.route("**/api/invitations/*", (route) => (fail && route.request().method() === "PATCH" ? route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"Проверка"}' }) : route.fallback()));
    await page.getByLabel(ru.fNames).fill("Сохранение 2");
    await page.locator('[data-save="error"]').waitFor();
    expect(await page.locator('[data-save="error"]').textContent()).toContain(ru.notSaved);
    fail = false;
    await page.locator("[data-save-retry]").click();
    await page.locator('[data-save="saved"]').waitFor();
    await expect.poll(async () => (await invOf(inv.id)).data.names).toBe("Сохранение 2");
    // Редактор: до правки — подсказка, после — «✓ Сохранено · ЧЧ:ММ · в разделе «Мои приглашения»».
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: "✎ " + ru.toEditor }).click();
    const st = page.locator("[data-ed-status]");
    await st.waitFor();
    expect(await st.getAttribute("data-ed-status")).toBe("hint");
    expect(await st.textContent()).toContain(ru.tapHint);
    await page.locator("h1[data-herotext]").first().click();
    await sheet(page, "edit").or(page.locator("input[maxlength='200']").first()).first().waitFor();
    await page.locator("input[maxlength='200']").first().fill("Сохранение 3");
    await page.getByRole("button", { name: ru.done, exact: true }).click();
    await expect.poll(() => st.getAttribute("data-ed-status")).toBe("saved");
    expect(await st.textContent()).toMatch(new RegExp("✓ " + ru.saved + " · \\d\\d:\\d\\d · " + ru.savedWhere));
    await expect.poll(async () => (await invOf(inv.id)).data.names).toBe("Сохранение 3");
    // Ошибка в редакторе: та же кнопка «Повторить» в строке статуса.
    fail = true;
    await page.locator("h1[data-herotext]").first().click();
    await page.locator("input[maxlength='200']").first().fill("Сохранение 4");
    await page.getByRole("button", { name: ru.done, exact: true }).click();
    await expect.poll(() => st.getAttribute("data-ed-status")).toBe("error");
    await e.shot(page, "finish-editor-error-ru-390x844.png");
    fail = false;
    await st.locator("[data-save-retry]").click();
    await expect.poll(() => st.getAttribute("data-ed-status")).toBe("saved");
    await expect.poll(async () => (await invOf(inv.id)).data.names).toBe("Сохранение 4");
    // 400 Chromium пишет в консоль сам (два раза — по одному на ошибку).
    expect(problems.console).toEqual([failed(400, "Bad Request"), failed(400, "Bad Request")]);
    problems.console = [];
    await e.expectClean(page, problems);
    await close();
  });

  it("редактор на узбекском: инструменты с подписями без прокрутки, «Qadamlar» — в конструктор; «Tahrirlash» у опубликованного — сразу редактор; новый черновик — тост", async () => {
    const context = await e.newContext();
    await context.addInitScript(() => { try { localStorage.setItem("invito.lang", "uz"); } catch {} });
    const user = await e.signIn(context, { locale: "uz" });
    const inv = await createInvitation(user.id, { language: "uz", data: { names: "Malika va Jasur", intro: "none" } });
    await activate(inv.id);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Malika va Jasur" });
    await cardOf(page, "Malika va Jasur").getByRole("button", { name: uz.edit }).click();
    const tools = page.locator("[data-ed-tools]");
    await tools.waitFor();
    // Сразу редактор: шагов конструктора нет.
    expect(await page.locator("[data-step-of]").count()).toBe(0);
    const labels = { music: uz.stepsX.music, sections: uz.stepsX.sections, style: uz.stepsX.style, steps: uz.stepsBtn };
    for (const [k, label] of Object.entries(labels)) {
      const b = tools.locator(`[data-ed-tool="${k}"]`);
      expect(await b.getAttribute("aria-label")).toBe(label);
      const box = (await b.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    const share = (await page.locator("[data-share]").boundingBox())!;
    expect(share.x + share.width).toBeLessThanOrEqual(390);
    await e.shot(page, "finish-editor-uz-390x844.png");
    await tools.locator('[data-ed-tool="music"]').click();
    await e.waitText(page, uz.done);
    await page.getByRole("button", { name: uz.done, exact: true }).click();
    // «Qadamlar» — конструктор на последнем шаге; счётчик шагов — одной строкой.
    await tools.locator('[data-ed-tool="steps"]').click();
    await page.locator("[data-finish]").waitFor();
    expect(await page.locator("[data-step-of]").textContent()).toBe(uz.stepOf.replace("{n}", "9").replace("{total}", "9"));
    expect((await page.locator("[data-step-of]").boundingBox())!.height).toBeLessThan(20);
    expect(await page.locator('[data-finish-price="live"]').textContent()).toBe(uz.pubPrice + " · " + uz.live);
    expect(await page.locator("[data-finish]").innerText()).toContain(uz.finishLive);
    // Новое событие при открытом своём приглашении: тост, что прежнее осталось в «Mening taklifnomalarim».
    await page.locator("header").getByText("Invito").first().click().catch(() => page.goto(e.base + "/app/"));
    await e.waitText(page, uz.hero1);
    await page.getByRole("button", { name: uz.create }).first().click();
    await e.waitText(page, uz.chooseEvent);
    await page.locator("[data-rv]").filter({ hasText: W.label.uz }).first().click();
    await e.waitText(page, uz.newDraft);
    await e.expectClean(page, problems);
    await close();
  });

  it("«Детали»: «Кто придёт» — один переключатель в «Разделах» (раздел и showGuests вместе), скретч-секрет — за переключателем", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Детали тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Детали тест" });
    await cardOf(page, "Детали тест").getByRole("button", { name: ru.edit }).click();
    await page.getByTitle(ru.steps.details).click();
    await page.locator("[data-reveal]").waitFor();
    // Второго переключателя «Кто придёт» в шаге нет; секрет скрыт, пока «Скретч-сюрприз» выключен.
    expect(await page.getByText(ru.showGuests).count()).toBe(0);
    expect(await page.locator("[data-reveal]").getAttribute("data-reveal")).toBe("off");
    expect(await page.locator("input[name=secret]").count()).toBe(0);
    await page.locator("[data-reveal] button").click();
    await page.locator("input[name=secret]").waitFor();
    expect(await page.locator("input[name=secret]").inputValue()).toBe(ru.secretDef);
    await expect.poll(async () => ((await invOf(inv.id)).data.sections as Dict[]).find((x) => x.k === "reveal")?.on).toBe(true);
    // «Разделы»: «Кто придёт» с подсказкой; включение меняет и раздел, и showGuests.
    await page.getByTitle(ru.stepsX.sections).click();
    const who = page.locator('button[data-sec="who"]');
    expect(await who.getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator("body").innerText()).toContain(ru.whoHint);
    await who.click();
    expect(await who.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(async () => { const d = (await invOf(inv.id)).data; return [d.showGuests, (d.sections as Dict[]).find((x) => x.k === "who")?.on]; }).toEqual([true, true]);
    await who.click();
    await expect.poll(async () => { const d = (await invOf(inv.id)).data; return [d.showGuests, (d.sections as Dict[]).find((x) => x.k === "who")?.on]; }).toEqual([false, false]);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("«Поделиться»", () => {
  it("с карточки «Мои приглашения»; WhatsApp и системное меню; предупреждение о смене адреса; OG-теги под «Дополнительно»", async () => {
    const context = await e.newContext();
    await recordShares(context);
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Ссылка тест", intro: "none" } });
    await activate(inv.id);
    const draft = await createInvitation(user.id, { data: { names: "Черновик карта", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Ссылка тест" });
    await cardOf(page, "Ссылка тест").locator("[data-inv-share]").click();
    await e.waitText(page, ru.linkReady);
    const link = `${e.base}/i/${inv.slug}`;
    // Адрес опубликованного: предупреждение, что отправленные ссылки перестанут открываться.
    expect(await page.locator("[data-slug-warn]").textContent()).toBe(ru.slugWarn);
    await page.locator("[data-share-wa]").click();
    const title = `Ссылка тест`;
    await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(["https://wa.me/?text=" + encodeURIComponent(title + " " + link)]);
    await page.locator("[data-share-any]").click();
    expect(await page.evaluate(() => (window as any).__shared)).toEqual([{ title, url: link }]);
    // OG-теги свёрнуты: служебный код не на виду, но открывается.
    const more = page.locator("details[data-more]");
    expect(await more.getAttribute("open")).toBeNull();
    expect(await page.locator("pre").isVisible()).toBe(false);
    expect(await page.locator("pre").textContent()).toContain(`content="${link}"`);
    await more.locator("summary").click();
    await page.locator("pre").waitFor({ state: "visible" });
    expect(await more.innerText()).toContain(ru.ogTagsDev);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await e.shot(page, "finish-share-more-ru-390x844.png");
    // Черновик с карточки: имена свои, даты, места и адреса из примера нет (фото шаблона сами по себе
    // подтверждения не вызывают) — сразу лист оплаты.
    await page.getByRole("button", { name: "← " + ru.back }).first().click();
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Черновик карта");
    await cardOf(page, "Черновик карта").locator("[data-inv-share]").click();
    await sheet(page, "pay").waitFor();
    expect(await sheet(page, "confirm").count()).toBe(0);
    expect(await sheet(page, "pay").locator("[data-pay-what]").innerText()).toContain("Черновик карта");
    expect((await invOf(draft.id)).status).toBe("draft");
    await e.expectClean(page, problems);
    await close();
  });

  it("личные ссылки: у каждого гостя «Скопировать», Telegram, SMS (если есть телефон) и ↗", async () => {
    const context = await e.newContext();
    await recordShares(context);
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { mode: "personal", data: { names: "Личные тест", intro: "none" } });
    await activate(inv.id, { paidSeats: 2 });
    const added = (await apiAs(user.id, "POST", `/api/invitations/${inv.id}/guests`, { guests: [{ name: "Анна", phone: "+998901234567" }, { name: "Бобур" }] })) as unknown as Dict[];
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Личные тест" });
    await cardOf(page, "Личные тест").locator("[data-inv-share]").click();
    const rows = page.locator("[data-personal-links] [data-guest-link]");
    await expect.poll(() => rows.count()).toBe(2);
    const anna = page.locator('[data-guest-link="Анна"]'), bobur = page.locator('[data-guest-link="Бобур"]');
    const annaLink = added.find((g) => g.name === "Анна")!.link as string;
    expect(await anna.locator('[data-pl="sms"]').getAttribute("href")).toBe(`sms:+998901234567?&body=${encodeURIComponent("Личные тест " + annaLink)}`);
    expect(await bobur.locator('[data-pl="sms"]').count()).toBe(0);
    await bobur.locator('[data-pl="tg"]').click();
    const boburLink = added.find((g) => g.name === "Бобур")!.link as string;
    await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([`https://t.me/share/url?url=${encodeURIComponent(boburLink)}&text=${encodeURIComponent("Личные тест")}`]);
    // Кнопки не выходят за экран 390 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await rows.first().scrollIntoViewIfNeeded();
    await e.shot(page, "finish-personal-rows-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("мини-апп Telegram: QR, превью и сторис скачивает Telegram (downloadFile), в старом Telegram — браузер; в редакторе одна кнопка ссылки (MainButton)", async () => {
    const tgId = 7_300_000_000 + Math.floor(Math.random() * 1e6);
    const [user] = await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Тимур", locale: "ru" }).returning();
    const inv = await createInvitation(user!.id, { data: { names: "Загрузки тест", intro: "none" } });
    await activate(inv.id);
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Тимур" });
    await context.addInitScript(() => {
      const w = window as any;
      w.Telegram.WebApp.downloadFile = (p: { url: string; file_name: string }) => w.__tg.links.push(["dl", p.url, p.file_name]);
    });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Загрузки тест" });
    await cardOf(page, "Загрузки тест").locator("[data-inv-share]").click();
    await e.waitText(page, ru.linkReady);
    // Ссылок download нет: в Telegram они ничего не делают.
    expect(await page.locator("a[download]").count()).toBe(0);
    const dl = async (kind: string) => {
      await page.locator(`[data-dl="${kind}"]`).click();
      await expect.poll(async () => (await tgState(page)).links.filter((x) => x[0] === "dl" && x[2] === `invito-${kind}.jpg`).length, { timeout: 15_000 }).toBe(1);
      const [, url] = (await tgState(page)).links.find((x) => x[2] === `invito-${kind}.jpg`)!;
      expect(url).toMatch(new RegExp(`^${e.base}/media/[0-9a-f-]{36}\\.jpg$`));
      const res = await e.app.inject({ method: "GET", url: url!.slice(e.base.length) });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
    };
    await dl("qr");
    await page.locator('img[alt="Story"]').waitFor();
    await dl("story");
    await e.shot(page, "finish-tg-share-ru-390x844.png");
    // Старый Telegram без downloadFile: файл открывается в браузере, тост объясняет.
    await page.evaluate(() => { delete (window as any).Telegram.WebApp.downloadFile; });
    await page.locator('img[alt="OG"]').waitFor();
    await page.locator('[data-dl="og"]').click();
    await e.waitText(page, ru.dlBrowser);
    expect((await tgState(page)).links.filter((x) => x[0] === "link").map((x) => x[1])).toEqual([expect.stringMatching(new RegExp(`^${e.base}/media/`))]);
    // Редактор опубликованного: кнопку «Получить ссылку» показывает MainButton, своей в панели нет.
    await page.goto(e.base + "/app/");
    await e.waitText(page, "Загрузки тест");
    await cardOf(page, "Загрузки тест").getByRole("button", { name: ru.edit }).click();
    await page.locator("[data-ed-tools]").waitFor();
    expect(await page.locator("[data-share]").count()).toBe(0);
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.toShare);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("страница гостя", () => {
  it("ответ: «Отправить» без ответа и без имени объясняет, что не так; дата героя не наезжает на линии на 390 px", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, { data: { names: "Ответ тест", date: "2026-12-27", time: "16:00", intro: "none" } });
    await activate(inv.id);
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { waitText: "Ответ тест" });
    // Дата и время героя: линии по бокам не заходят на текст, дата не рвётся внутри.
    const hero = page.locator("[data-herotext]").filter({ hasText: "16:00" }).first();
    const parts = await hero.evaluate((el) => Array.from(el.children).map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.right, r.width]; }));
    expect(parts).toHaveLength(3);
    expect(parts[0]![1]).toBeLessThanOrEqual(parts[1]![0]! + 0.5);
    expect(parts[1]![1]).toBeLessThanOrEqual(parts[2]![0]! + 0.5);
    const dateSpan = hero.locator("span > span").first();
    expect((await dateSpan.boundingBox())!.height).toBeLessThan(30);
    // Пусто: подсказка про оба поля, курсор в поле имени; с ответом без имени — ввести имя, курсор в поле.
    const rsvp = page.locator("#rsvp");
    await rsvp.scrollIntoViewIfNeeded();
    await rsvp.getByRole("button", { name: ru.send }).click();
    expect(await rsvp.locator("[data-rsvp-need]").textContent()).toBe(ru.needBoth);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("rsvp-name");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await rsvp.getByRole("button", { name: ru.yes }).click();
    await rsvp.getByRole("button", { name: ru.send }).click();
    expect(await rsvp.locator("[data-rsvp-need]").textContent()).toBe(ru.needName);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("rsvp-name");
    await e.shot(page, "finish-rsvp-need-ru-390x844.png");
    await page.keyboard.type("Гость Тест");
    expect(await rsvp.locator("[data-rsvp-need]").count()).toBe(0);
    await rsvp.getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    await e.expectClean(page, problems);
    await close();
  });
});
