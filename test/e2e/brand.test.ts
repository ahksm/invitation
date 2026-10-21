import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, telegramStub, uniquePhone, type E2E } from "./helpers.js";

/**
 * Название InviteBloom в браузере: главная на четырёх языках без «Invito» (имя проекта дизайна), шапка
 * с длинным названием на телефоне (со «Войти» и с аккаунтом, в мини-аппе), страницы документов и «не найдено».
 */

type Dict = Record<string, any>;
const LANGS = ["ru", "uz", "uzc", "en"] as const;
const OLD = /invito/i;
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

const setLang = (l: string) => {
  try {
    localStorage.setItem("invito.lang", l);
  } catch {}
};

/**
 * Шапка: название и кнопки справа. Шрифты в проверках заглушены (запасной DejaVu Serif шире Cormorant Garamond),
 * поэтому ширина самого слова не сравнивается: проверяется место под него. Название занимает то, что осталось
 * от кнопок (не меньше 12px до них), размер — по этому месту (100cqi / 4.4: «InviteBloom» в Cormorant Garamond
 * italic — 4.25 своего размера), от 20 до 32px, в одну строку; кнопки в пределах экрана, прокрутки вбок нет.
 */
async function headerFits(page: Page, label: string) {
  const m = await page.evaluate(() => {
    const row = document.querySelector("header")!.firstElementChild as HTMLElement;
    const box = row.querySelector("[data-wordmark]") as HTMLElement;
    const mark = box.querySelector("button")!;
    const right = row.lastElementChild as HTMLElement;
    const b = box.getBoundingClientRect(), r = right.getBoundingClientRect(), k = mark.getBoundingClientRect();
    return {
      text: mark.textContent, fs: parseFloat(getComputedStyle(mark).fontSize), lh: parseFloat(getComputedStyle(mark).lineHeight),
      boxW: b.width, boxR: b.right, rightL: r.left, rightR: r.right, markH: k.height, markL: k.left,
      rowOver: row.scrollWidth - row.clientWidth, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth, w: innerWidth,
    };
  });
  expect(m.text, label).toBe("InviteBloom");
  expect(m.fs, label).toBeGreaterThanOrEqual(20);
  expect(m.fs, label).toBeLessThanOrEqual(32);
  expect(m.fs * 4.4, label).toBeLessThanOrEqual(m.boxW + 0.5);
  // Не уменьшается без нужды: 32px, если для 32px хватает места.
  if (m.boxW >= 32 * 4.4) expect(m.fs, label).toBe(32);
  expect(m.rightL - m.boxR, label).toBeGreaterThanOrEqual(11.5);
  expect(m.markL, label).toBeGreaterThanOrEqual(15.5);
  expect(m.markH, label).toBeLessThanOrEqual(m.lh + 1);
  expect(m.rightR, label).toBeLessThanOrEqual(m.w - 15.5);
  expect(m.rowOver, label).toBeLessThanOrEqual(0);
  return m;
}

describe("название InviteBloom", () => {
  it("главная на четырёх языках: InviteBloom в шапке, подвале и заголовке вкладки, Invito нигде", async () => {
    for (const lang of LANGS) {
      const t = (I18N as Dict)[lang];
      const context = await e.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(setLang, lang);
      const { page, problems, close } = await e.open("/", { context, waitText: t.home.seeTpls });
      expect(await page.title(), lang).toBe("InviteBloom — электронные приглашения на свадьбу и праздник");
      expect(await page.locator("header button").first().textContent(), lang).toBe("InviteBloom");
      const foot = page.locator("footer[data-foot]");
      await foot.scrollIntoViewIfNeeded();
      expect(await foot.locator(":scope > div > div > div").first().textContent(), lang).toBe("InviteBloom");
      expect(await foot.textContent(), lang).toContain(`© ${new Date().getFullYear()} InviteBloom`);
      // Весь текст страницы и ответы на вопросы (они в DOM, только пока раскрыты).
      let text = await page.evaluate(() => document.body.textContent || "");
      const faq = page.locator("[data-home-faq]");
      for (let i = 0; i < (await faq.count()); i++) {
        await faq.nth(i).click();
        await expect.poll(() => faq.nth(i).getAttribute("aria-expanded")).toBe("true");
        text += await page.evaluate(() => document.body.textContent || "");
      }
      expect(text, lang).toContain(t.home.faq[3][1]);
      expect(t.home.faq[3][1], lang).toContain("InviteBloom");
      expect(text.match(/.{0,40}invito.{0,40}/gi), lang).toBeNull();
      expect(await page.evaluate(() => [...document.querySelectorAll("[title], [aria-label], [alt], [placeholder]")].map((x) => [x.getAttribute("title"), x.getAttribute("aria-label"), x.getAttribute("alt"), x.getAttribute("placeholder")].join(" ")).join(" "))).not.toMatch(OLD);
      await e.expectClean(page, problems);
      await close();
    }
  });

  it("шапка на 320, 360 и 390 px на всех языках, со «Войти» и с аккаунтом: название в одну строку, без наложения и прокрутки вбок", async () => {
    for (const width of [320, 360, 390]) {
      for (const lang of LANGS) {
        for (const signed of [false, true]) {
          const label = `${width} ${lang} ${signed ? "с аккаунтом" : "без входа"}`;
          const context = await e.newContext({ viewport: { width, height: 760 } });
          await context.addInitScript(setLang, lang);
          if (signed) await e.signIn(context, { firstName: "Абдурахмон", lastName: "Каримов", locale: lang });
          const { page, problems, close } = await e.open("/", { context, waitText: (I18N as Dict)[lang].home.seeTpls });
          await page.locator(signed ? "header [data-account][aria-label]" : "header [data-account]:not([aria-label])").waitFor();
          const m = await headerFits(page, label);
          // Без входа на 320 px название уменьшается, с аккаунтом места хватает почти на 32px; на экране меньше
          // 360 px кнопка языка — без глобуса.
          if (width === 320) expect(m.fs, label)[signed ? "toBeGreaterThan" : "toBeLessThan"](signed ? 28 : 26);
          expect(await page.locator("header [data-lang-btn] svg").count(), label).toBe(width < 360 ? 0 : 1);
          if (width === 320) await e.shot(page, `brand-header-${lang}-${signed ? "in" : "out"}-320.png`);
          await e.expectClean(page, problems);
          await close();
          await e.redis.flushdb();
        }
      }
    }
  });

  it("мини-апп на 320 и 390 px: шапка с названием помещается", async () => {
    for (const width of [320, 390]) {
      for (const lang of LANGS) {
        const tg = 880_000 + width * 10 + LANGS.indexOf(lang);
        await e.db.insert(users).values({ telegramId: tg, phone: uniquePhone(), firstName: "Мадина", locale: lang }).onConflictDoNothing();
        const context = await e.newContext({ viewport: { width, height: 760 } });
        await telegramStub(context, { id: tg, first_name: "Мадина", language_code: lang === "uzc" ? "uz" : lang });
        const { page, problems, close } = await e.open("/app/", { context, waitText: (I18N as Dict)[lang].home.seeTpls });
        await page.locator("header [data-account][aria-label]").waitFor();
        await headerFits(page, `мини-апп ${width} ${lang}`);
        await e.expectClean(page, problems);
        await close();
        await e.redis.flushdb();
      }
    }
  });

  it("страницы документов на 320 px и «не найдено»: InviteBloom в шапке, без прокрутки вбок", async () => {
    for (const lang of LANGS) {
      const { page, problems, close } = await e.open(lang === "ru" ? "/privacy" : `/privacy?lang=${lang}`, { viewport: { width: 320, height: 760 } });
      const m = await page.evaluate(() => {
        const logo = document.querySelector(".logo")!, brand = document.querySelector(".brand")!, langs = document.querySelector(".langs")!;
        const l = logo.getBoundingClientRect(), b = brand.getBoundingClientRect(), r = langs.getBoundingClientRect();
        return { text: logo.textContent, fs: parseFloat(getComputedStyle(logo).fontSize), boxW: b.width, boxR: b.right, rightL: r.left, rightR: r.right, markH: l.height, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(m.text, lang).toBe("InviteBloom");
      expect(m.fs, lang).toBeGreaterThanOrEqual(20);
      expect(m.fs, lang).toBeLessThan(32);
      expect(m.fs * 4.4, lang).toBeLessThanOrEqual(m.boxW + 0.5);
      expect(m.rightL - m.boxR, lang).toBeGreaterThanOrEqual(15.5);
      expect(m.rightR, lang).toBeLessThanOrEqual(320 - 15.5);
      expect(m.markH, lang).toBeLessThan(m.fs * 1.6);
      expect(m.docOver, lang).toBe(0);
      expect(await page.title(), lang).toMatch(/ — InviteBloom$/);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toMatch(OLD);
      if (lang === "uzc") await e.shot(page, "brand-legal-uzc-320.png");
      await e.expectClean(page, problems);
      await close();
    }

    const nf = await e.open("/i/no-such-invitation", { status: 404, waitText: (I18N as Dict).ru.nfTitle });
    expect(await nf.page.title()).toBe("InviteBloom");
    expect(await nf.page.getByRole("button", { name: "InviteBloom" }).count()).toBe(1);
    expect(await nf.page.evaluate(() => document.body.textContent || "")).not.toMatch(OLD);
    // Статус 404 самой страницы Chromium пишет в консоль: это единственная ожидаемая ошибка.
    expect(nf.problems.console).toEqual(["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
    await e.expectClean(nf.page, { ...nf.problems, console: [] });
    await nf.close();
  });
});
