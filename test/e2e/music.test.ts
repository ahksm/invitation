import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, templates, users } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, uniquePhone, type E2E } from "./helpers.js";

/**
 * Музыка на странице гостя включена по умолчанию: стартует от первого касания гостя (конверт, любая
 * кнопка), потому что без касания браузер звук не разрешает. Chromium запущен с тем же правилом
 * автозапуска, что у обычного браузера (звук только после касания). Состояние звука проверяется по
 * AudioContext страницы, а не только по кнопке.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;

let e: E2E;
beforeAll(async () => {
  e = await startE2E({ browserArgs: ["--autoplay-policy=user-gesture-required"] });
});
afterAll(async () => {
  await e?.close();
});
beforeEach(async () => {
  await e.redis.flushdb();
});

/** Опубликованное общее приглашение по адресу /i/<slug>. */
async function published(data: Dict, values: Dict = {}) {
  const [user] = await e.db.insert(users).values({ phone: uniquePhone() }).returning();
  const [template] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
  const slug = randomBytes(9).toString("base64url");
  await e.db.insert(invitations).values({ userId: user!.id, templateId: template!.id, mode: "shared", status: "active", unlocked: true, title: "Той", data, slug, ...values });
  return slug;
}

/** Контекст, где каждый созданный AudioContext виден тесту (window.__acs). */
async function audioContext() {
  const context = await e.newContext();
  await context.addInitScript(() => {
    const w = window as unknown as { __acs: AudioContext[]; AudioContext: typeof AudioContext };
    w.__acs = [];
    const AC = w.AudioContext;
    w.AudioContext = class extends AC {
      constructor(...a: ConstructorParameters<typeof AudioContext>) {
        super(...a);
        w.__acs.push(this);
      }
    };
  });
  return context;
}

const pressed = (page: Page) => page.locator("[data-music]").getAttribute("aria-pressed");
/** Звук действительно идёт: есть AudioContext в состоянии running. */
const audible = (page: Page) => page.evaluate(() => (window as unknown as { __acs: AudioContext[] }).__acs.some((a) => a.state === "running"));
const contexts = (page: Page) => page.evaluate(() => (window as unknown as { __acs: AudioContext[] }).__acs.length);

describe("музыка на странице гостя", () => {
  it("конверт: музыка включается от касания, гость выключает её, и она больше не включается сама", async () => {
    const slug = await published({ names: "Азиз и Мадина", date: "2026-12-12" });
    const { page, problems, close } = await e.open(`/i/${slug}`, { waitText: "Азиз и Мадина", context: await audioContext() });
    // До касания звука нет: браузер его не разрешает, приложение и не пытается.
    expect(await pressed(page)).toBe("false");
    expect(await contexts(page)).toBe(0);
    // Касание конверта открывает приглашение и включает музыку.
    await page.mouse.click(195, 420);
    await expect.poll(() => pressed(page)).toBe("true");
    await expect.poll(() => audible(page)).toBe(true);
    await page.waitForTimeout(2800);
    // Гость выключил музыку: следующие касания её не включают.
    await page.locator("[data-music]").click();
    await expect.poll(() => pressed(page)).toBe("false");
    await page.locator("#rsvp").scrollIntoViewIfNeeded();
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.waitForTimeout(400);
    expect(await pressed(page)).toBe("false");
    // И снова включается кнопкой.
    await page.locator("[data-music]").click();
    await expect.poll(() => pressed(page)).toBe("true");
    await e.expectClean(page, problems);
    await close();
  });

  it("без заставки: первое касание где угодно включает музыку; первое нажатие на кнопку музыки тоже включает", async () => {
    const slug = await published({ names: "Лола и Тимур", intro: "none" });
    const a = await e.open(`/i/${slug}`, { waitText: "Лола и Тимур", context: await audioContext() });
    expect(await pressed(a.page)).toBe("false");
    await a.page.getByText("Лола и Тимур").first().click();
    await expect.poll(() => pressed(a.page)).toBe("true");
    await expect.poll(() => audible(a.page)).toBe(true);
    await e.expectClean(a.page, a.problems);
    await a.close();

    // Первое касание — сама кнопка музыки: музыка включается, а не включается и сразу выключается.
    const b = await e.open(`/i/${slug}`, { waitText: "Лола и Тимур", context: await audioContext() });
    await b.page.locator("[data-music]").click();
    await b.page.waitForTimeout(400);
    expect(await pressed(b.page)).toBe("true");
    await expect.poll(() => audible(b.page)).toBe(true);
    // Гость сам включил и выключил музыку кнопкой: дальше касания её не включают.
    await b.page.locator("[data-music]").click();
    await expect.poll(() => pressed(b.page)).toBe("false");
    await b.page.getByText("Лола и Тимур").first().click();
    await b.page.waitForTimeout(400);
    expect(await pressed(b.page)).toBe("false");
    await e.expectClean(b.page, b.problems);
    await b.close();

    // Ввод имени в ответе музыку не запускает, касание кнопки ответа — запускает.
    const c = await e.open(`/i/${slug}`, { waitText: "Лола и Тимур", context: await audioContext() });
    await c.page.locator("#rsvp").scrollIntoViewIfNeeded();
    const name = c.page.locator(`#rsvp input[placeholder="${ru.yourName}"]`);
    await name.click();
    await name.pressSequentially("Гость");
    await c.page.waitForTimeout(400);
    expect(await pressed(c.page)).toBe("false");
    await c.page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await expect.poll(() => pressed(c.page)).toBe("true");
    await e.expectClean(c.page, c.problems);
    await c.close();
  });

  it("вкладку свернули: музыка молчит и продолжается при возвращении", async () => {
    const slug = await published({ names: "Нигора и Бахром", intro: "none" });
    const { page, problems, close } = await e.open(`/i/${slug}`, { waitText: "Нигора и Бахром", context: await audioContext() });
    await page.getByText("Нигора и Бахром").first().click();
    await expect.poll(() => pressed(page)).toBe("true");
    const setVisibility = (state: string) =>
      page.evaluate((v) => {
        Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await setVisibility("hidden");
    await expect.poll(() => pressed(page)).toBe("false");
    await setVisibility("visible");
    await expect.poll(() => pressed(page)).toBe("true");
    await e.expectClean(page, problems);
    await close();
  });

  it("без музыки в приглашении и за паролем касание звук не включает", async () => {
    const quiet = await published({ names: "Тихий вечер", intro: "none", music: "none" });
    const a = await e.open(`/i/${quiet}`, { waitText: "Тихий вечер", context: await audioContext() });
    await a.page.getByText("Тихий вечер").first().click();
    await a.page.waitForTimeout(400);
    expect(await pressed(a.page)).toBe("false");
    expect(await contexts(a.page)).toBe(0);
    await e.expectClean(a.page, a.problems);
    await a.close();

    // За паролем касания поля и ввод звук не включают; после пароля — касание конверта включает.
    const locked = await published({ names: "Секретный ужин" }, { accessCode: "tulip-26" });
    const b = await e.open(`/i/${locked}`, { waitText: ru.unlock, context: await audioContext() });
    await b.page.locator("input[type=password]").click();
    await b.page.keyboard.type("tulip-26");
    await b.page.waitForTimeout(400);
    expect(await contexts(b.page)).toBe(0);
    await b.page.getByRole("button", { name: ru.unlock }).click();
    await e.waitText(b.page, "Секретный ужин");
    await b.page.waitForTimeout(1200);
    expect(await pressed(b.page)).toBe("false");
    await b.page.mouse.click(195, 420);
    await expect.poll(() => pressed(b.page)).toBe("true");
    await expect.poll(() => audible(b.page)).toBe(true);
    await e.expectClean(b.page, b.problems);
    await b.close();
  });
});
