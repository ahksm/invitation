import { eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/db/schema.js";
import { setLegal } from "../../src/services/settings.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, type E2E } from "./helpers.js";

/**
 * Оферта, политика и контакты в браузере: реквизиты из админки («Реквизиты»), страницы на телефоне
 * и компьютере без нарушений CSP и горизонтальной прокрутки, переключение языка и документов; ссылки на них
 * из приложения (подвал главной, согласие с офертой под кнопками оплаты).
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;

let e: E2E;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.db.delete(settings).where(eq(settings.key, "legal"));
  await e?.close();
});

beforeEach(async () => {
  await e.db.delete(settings).where(eq(settings.key, "legal"));
  await e.redis.flushdb();
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const visible = (page: Page, selector: string) => page.locator(selector).first().isVisible();

describe("реквизиты в админке", () => {
  it("админ заполняет реквизиты, сервер приводит Telegram к имени, ошибка email показывается; страницы показывают сохранённое", async () => {
    const context = await e.newContext({ viewport: DESKTOP });
    const admin = await e.signIn(context, { firstName: "Админ" });
    e.config.ADMIN_PHONES.push(admin.phone!);
    try {
      // Пока реквизитов нет, главная админки предупреждает: оферта называет исполнителем администрацию сайта.
      const home = await e.open("/admin/#/", { context, waitText: "Реквизиты не заполнены" });
      expect(await home.page.locator("[data-legal-warn]").innerText()).toContain("Нет: название, ИНН, адрес");
      await home.page.close();

      const { page, problems } = await e.open("/admin/#/legal", { context, waitText: "Юридический адрес" });
      await expect.poll(() => page.locator('#tabs a[href="#/legal"]').getAttribute("class")).toBe("active");
      // Пустая форма: значения ещё не заданы.
      expect(await page.locator('input[name="companyName"]').inputValue()).toBe("");

      const fill = async (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) await page.locator(`input[name="${name}"]`).fill(value);
      };
      await fill({ companyName: "ООО «Инвайт Блум»", inn: "309876543", address: "Ташкент, ул. Навои, 1", phone: "+998 90 123-45-67", email: "plохой", telegram: "https://t.me/invitebloom_support" });
      await page.getByRole("button", { name: "Сохранить" }).click();
      await e.waitText(page, "Email: адрес вида name@example.com");
      expect(await e.app.inject({ method: "GET", url: "/contacts" }).then((r) => r.body)).not.toContain("Инвайт Блум");

      await fill({ email: "support@invitebloom.tech" });
      await page.getByRole("button", { name: "Сохранить" }).click();
      await e.waitText(page, "Реквизиты сохранены");
      expect(await page.locator('input[name="telegram"]').inputValue()).toBe("invitebloom_support");
      // Поля ограничены по длине так же, как на сервере.
      expect(await page.locator('input[name="companyName"]').getAttribute("maxlength")).toBe("200");
      await e.shot(page, "legal-admin.png");

      // Ссылка из формы открывает страницу контактов с сохранёнными данными.
      const [contacts] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "Контакты" }).click()]);
      await contacts.waitForLoadState();
      await e.waitText(contacts, "ООО «Инвайт Блум»");
      expect(await contacts.locator('[data-field="telegram"] a').getAttribute("href")).toBe("https://t.me/invitebloom_support");
      expect(await contacts.locator('[data-field="phone"] a').getAttribute("href")).toBe("tel:+998901234567");
      expect(await contacts.locator('[data-field="bankAccount"]').count()).toBe(0);
      // Реквизиты заполнены: предупреждения на главной админки больше нет.
      await page.goto(e.base + "/admin/#/");
      await e.waitText(page, "пользователей");
      expect(await page.locator("[data-legal-warn]").count()).toBe(0);
      // Единственная ошибка в консоли — ожидаемый ответ 400 на неверный email.
      expect(problems.console).toEqual(["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
      problems.console = [];
      await e.expectClean(page, problems);
    } finally {
      e.config.ADMIN_PHONES.splice(e.config.ADMIN_PHONES.indexOf(admin.phone!), 1);
      await context.close();
    }
  });
});

describe("страницы документов", () => {
  it("телефон: оферта без реквизитов, оглавление раскрывается, переход на узбекский и к политике; без нарушений CSP", async () => {
    const { page, problems, close } = await e.open("/oferta", { viewport: PHONE, waitText: "Публичная оферта" });
    expect(await page.title()).toBe("Публичная оферта — InviteBloom");
    expect(await overflow(page)).toBe(0);
    // Без реквизитов исполнитель назван нейтрально, заглушек нет.
    await e.waitText(page, "администрация сайта 127.0.0.1");
    expect(await page.locator('[data-field="companyName"]').count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toMatch(/___|undefined|null/);
    // На телефоне оглавление свёрнуто, боковое скрыто.
    expect(await visible(page, ".toc-side")).toBe(false);
    expect(await page.locator(".toc-mob a").first().isVisible()).toBe(false);
    await page.locator(".toc-mob summary").click();
    await page.locator('.toc-mob a[href="#refunds"]').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#refunds");
    // Заголовок раздела не уходит под липкую шапку.
    const top = await page.locator("#refunds h2").evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(60);
    await e.shot(page, "legal-oferta-ru-phone.png");

    await page.locator('.langs a[hreflang="uz-Latn"]').click();
    await e.waitText(page, "Ommaviy oferta");
    expect(page.url()).toBe(`${e.base}/oferta?lang=uz`);
    expect(await page.locator("html").getAttribute("lang")).toBe("uz-Latn");
    expect(await overflow(page)).toBe(0);
    await page.locator(".docs a", { hasText: "Maxfiylik" }).click();
    await e.waitText(page, "Maxfiylik siyosati");
    expect(page.url()).toBe(`${e.base}/privacy?lang=uz`);
    expect(await overflow(page)).toBe(0);
    await e.shot(page, "legal-privacy-uz-phone.png");
    await e.expectClean(page, problems);
    expect(problems.requests.filter((r) => r.startsWith("/api/"))).toEqual([]);
    await close();
  });

  it("компьютер: оглавление сбоку, реквизиты таблицей; контакты на всех языках без горизонтальной прокрутки", async () => {
    await setLegal(e.app.ctx, {
      companyName: "ООО «Инвайт Блум»",
      inn: "309876543",
      address: "Ташкент, Мирзо-Улугбекский район, ул. Буюк Ипак Йули, 123, офис 45",
      phone: "+998 90 123-45-67",
      email: "support@invitebloom.tech",
      telegram: "invitebloom_support",
      bankName: "АКБ «Капиталбанк», Ташкентский филиал",
      bankAccount: "20208000900123456001",
      mfo: "01088",
      director: "Абдурахмонов Абдурахмон",
    });
    const { page, problems, close } = await e.open("/oferta", { viewport: DESKTOP, waitText: "Реквизиты Исполнителя" });
    expect(await visible(page, ".toc-side")).toBe(true);
    expect(await visible(page, ".toc-mob")).toBe(false);
    expect(await page.locator("#general").innerText()).toContain("ООО «Инвайт Блум» (далее — «Исполнитель»)");
    // Реквизиты: подпись слева, значение справа.
    const [dt, dd] = await Promise.all([page.locator('#details [data-field="inn"] dt').boundingBox(), page.locator('#details [data-field="inn"] dd').boundingBox()]);
    expect(dd!.x).toBeGreaterThan(dt!.x + dt!.width);
    expect(Math.abs(dd!.y - dt!.y)).toBeLessThan(8);
    await e.expectClean(page, problems);
    await close();

    for (const lang of ["ru", "uz", "uzc", "en"]) {
      for (const viewport of [PHONE, DESKTOP]) {
        const path = lang === "ru" ? "/contacts" : `/contacts?lang=${lang}`;
        const o = await e.open(path, { viewport, waitText: "309876543" });
        expect(await overflow(o.page), `${path} ${viewport.width}`).toBe(0);
        // Все десять полей и сайт; бота нет (TELEGRAM_MODE=off).
        expect(await o.page.locator("[data-field]").count()).toBe(11);
        if (viewport === PHONE) await e.shot(o.page, `legal-contacts-${lang}-phone.png`);
        await e.expectClean(o.page, o.problems);
        await o.close();
      }
    }
  });

  it("тёмная тема системы: тёмный фон и светлый текст", async () => {
    const context = await e.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${e.base}/privacy?lang=uzc`);
    await e.waitText(page, "Махфийлик сиёсати");
    const [bg, color] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
    expect(bg).toBe("rgb(21, 19, 17)");
    expect(color).toBe("rgb(241, 235, 224)");
    await e.shot(page, "legal-privacy-uzc-dark.png");
    await context.close();
  });
});

describe("ссылки из приложения", () => {
  /** Текст согласия так, как его собирает приложение: «Нажимая «{btn}», вы принимаете условия {link}». */
  const consent = (t: Dict, btn: string) => t.payConsent.replace("{btn}", btn).replace("{link}", t.consentLink);
  const text = (page: Page, selector: string) => page.locator(selector).first().evaluate((x) => (x.textContent || "").replace(/\s+/g, " ").trim());

  it("подвал главной и согласие под кнопками оплаты ведут на оферту на языке интерфейса", async () => {
    const context = await e.newContext({ viewport: PHONE });
    const user = await e.signIn(context);
    const res = await e.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie: `session=${e.app.jwt.sign({ sub: user.id })}`, origin: e.base },
      payload: { template: "wedding-classic", mode: "shared", language: "ru", data: { names: "Согласие тест", intro: "none" } },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Согласие тест" });

    // Подвал: «Публичная оферта» открывает страницу сервера в новой вкладке.
    const foot = page.locator('[data-foot-link="oferta"]');
    await foot.scrollIntoViewIfNeeded();
    const [offer] = await Promise.all([context.waitForEvent("page"), foot.click()]);
    await e.waitText(offer, "администрация сайта");
    expect(offer.url()).toBe(`${e.base}/oferta`);
    expect(await offer.title()).toBe("Публичная оферта — InviteBloom");
    await offer.close();

    // Лист оплаты черновика: под «Оплатить …» и под кнопкой подписки — согласие со ссылкой на оферту;
    // в кавычках — подпись кнопки целиком, как она написана на кнопке.
    await page.locator('#my-inv [data-inv-share="publish"]').first().click();
    const pay = page.locator('[data-sheet="pay"]');
    await pay.locator('[data-consent="pay"]').waitFor();
    const goLabel = (await pay.locator('[data-pay="go"]').innerText()).replace(/\s*→$/, "");
    expect(goLabel).toMatch(/^Оплатить \d[\d\s\u00a0]* сум$/);
    expect(await text(page, '[data-sheet="pay"] [data-consent="pay"]')).toBe(consent(ru, goLabel).replace(/\s+/g, " "));
    expect(await text(page, '[data-sheet="pay"] [data-consent="pay"]')).toMatch(/^Нажимая «Оплатить \d[\d ]* сум», вы принимаете условия оферты$/);
    const subLabel = await pay.locator('[data-pay="sub"]').innerText();
    expect(subLabel).toMatch(new RegExp("^" + ru.subBuy + " "));
    expect(await text(page, '[data-sheet="pay"] [data-consent="sub"]')).toBe(consent(ru, subLabel).replace(/\s+/g, " "));
    for (const k of ["pay", "sub"]) {
      const a = pay.locator(`[data-consent="${k}"] a`);
      expect(await a.getAttribute("href"), k).toBe("/oferta");
      expect(await a.getAttribute("target"), k).toBe("_blank");
    }
    const [fromPay] = await Promise.all([context.waitForEvent("page"), pay.locator('[data-consent="pay"] a').click()]);
    await e.waitText(fromPay, "Публичная оферта");
    expect(fromPay.url()).toBe(`${e.base}/oferta`);
    await fromPay.close();
    // Лист оплаты остался открытым.
    await pay.locator('[data-pay="go"]').waitFor();
    await e.expectClean(page, problems);
    await close();

    // Экран цен на узбекском: согласие под сроками подписки, оферта — на узбекском.
    const uzc = await e.newContext({ viewport: PHONE });
    await uzc.addInitScript(() => { try { localStorage.setItem("invito.lang", "uz"); } catch (x) {} });
    const o = await e.open("/app/#/pricing", { context: uzc, waitText: uz.pricingTitle });
    await o.page.locator('[data-consent="pricing"]').waitFor();
    expect(await o.page.locator("[data-buy-sub]").first().innerText()).toBe(uz.subBuy);
    expect(await text(o.page, '[data-consent="pricing"]')).toBe(consent(uz, uz.subBuy));
    expect(await o.page.locator('[data-consent="pricing"] a').getAttribute("href")).toBe("/oferta?lang=uz");
    const [uzOffer] = await Promise.all([uzc.waitForEvent("page"), o.page.locator('[data-consent="pricing"] a').click()]);
    await e.waitText(uzOffer, "Ommaviy oferta");
    expect(uzOffer.url()).toBe(`${e.base}/oferta?lang=uz`);
    // И подвал: политика на узбекском.
    await o.page.locator("[data-pricing-back]").click();
    const priv = o.page.locator('[data-foot-link="privacy"]');
    await priv.waitFor();
    expect(await priv.getAttribute("href")).toBe("/privacy?lang=uz");
    await e.expectClean(o.page, o.problems);
    await o.close();
  });
});
