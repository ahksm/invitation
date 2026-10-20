import { eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/db/schema.js";
import { setLegal } from "../../src/services/settings.js";
import { startE2E, type E2E } from "./helpers.js";

/**
 * Оферта, политика и контакты в браузере: реквизиты из админки («Реквизиты»), страницы на телефоне
 * и компьютере без нарушений CSP и горизонтальной прокрутки, переключение языка и документов.
 */

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
      const { page, problems } = await e.open("/admin/#/legal", { context, waitText: "Юридический адрес" });
      await expect.poll(() => page.locator('#tabs a[href="#/legal"]').getAttribute("class")).toBe("active");
      // Пустая форма: значения ещё не заданы.
      expect(await page.locator('input[name="companyName"]').inputValue()).toBe("");

      const fill = async (values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) await page.locator(`input[name="${name}"]`).fill(value);
      };
      await fill({ companyName: "ООО «Инвито Медиа»", inn: "309876543", address: "Ташкент, ул. Навои, 1", phone: "+998 90 123-45-67", email: "plохой", telegram: "https://t.me/invito_support" });
      await page.getByRole("button", { name: "Сохранить" }).click();
      await e.waitText(page, "Email: адрес вида name@example.com");
      expect(await e.app.inject({ method: "GET", url: "/contacts" }).then((r) => r.body)).not.toContain("Инвито Медиа");

      await fill({ email: "support@invito.uz" });
      await page.getByRole("button", { name: "Сохранить" }).click();
      await e.waitText(page, "Реквизиты сохранены");
      expect(await page.locator('input[name="telegram"]').inputValue()).toBe("invito_support");
      // Поля ограничены по длине так же, как на сервере.
      expect(await page.locator('input[name="companyName"]').getAttribute("maxlength")).toBe("200");
      await e.shot(page, "legal-admin.png");

      // Ссылка из формы открывает страницу контактов с сохранёнными данными.
      const [contacts] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "Контакты" }).click()]);
      await contacts.waitForLoadState();
      await e.waitText(contacts, "ООО «Инвито Медиа»");
      expect(await contacts.locator('[data-field="telegram"] a').getAttribute("href")).toBe("https://t.me/invito_support");
      expect(await contacts.locator('[data-field="phone"] a').getAttribute("href")).toBe("tel:+998901234567");
      expect(await contacts.locator('[data-field="bankAccount"]').count()).toBe(0);
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
    expect(await page.title()).toBe("Публичная оферта — Invito");
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
      companyName: "ООО «Инвито Медиа»",
      inn: "309876543",
      address: "Ташкент, Мирзо-Улугбекский район, ул. Буюк Ипак Йули, 123, офис 45",
      phone: "+998 90 123-45-67",
      email: "support@invitebloom.tech",
      telegram: "invito_support",
      bankName: "АКБ «Капиталбанк», Ташкентский филиал",
      bankAccount: "20208000900123456001",
      mfo: "01088",
      director: "Абдурахмонов Абдурахмон",
    });
    const { page, problems, close } = await e.open("/oferta", { viewport: DESKTOP, waitText: "Реквизиты Исполнителя" });
    expect(await visible(page, ".toc-side")).toBe(true);
    expect(await visible(page, ".toc-mob")).toBe(false);
    expect(await page.locator("#general").innerText()).toContain("ООО «Инвито Медиа» (далее — «Исполнитель»)");
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
