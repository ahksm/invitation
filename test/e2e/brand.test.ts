import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, telegramStub, uniquePhone, type E2E } from "./helpers.js";

/**
 * Название InviteBloom в браузере: главная на четырёх языках без «Invito» (имя проекта дизайна), шапка
 * с длинным названием на телефоне (со «Войти» и с аккаунтом, в мини-аппе, в том числе запасным шрифтом, пока
 * Cormorant Garamond не загрузился), страницы документов и «не найдено».
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

/** Где в шапке название и что справа от него: в приложении — кнопки, на страницах документов — языки. */
const APP = { box: "header [data-wordmark]", right: "header > div > div:last-child", gap: 12 };
const LEGAL = { box: "header .brand", right: "header .langs", gap: 16 };
type Spot = typeof APP;

/**
 * Cormorant Garamond подменён на DejaVu Serif — самый широкий serif здесь: «InviteBloom» в нём 6,0 своего размера
 * (Noto Serif на Android — 5,7, Times — 4,8, Cormorant Garamond — 4,25).
 */
const WIDE = "@font-face{font-family:'Cormorant Garamond';font-style:italic;font-weight:500;src:local('DejaVu Serif')}";

function probe(spot: { box: string; right: string }) {
  const box = document.querySelector(spot.box) as HTMLElement;
  const mark = box.firstElementChild as HTMLElement;
  const right = document.querySelector(spot.right) as HTMLElement;
  const cs = getComputedStyle(box), ms = getComputedStyle(mark);
  const range = document.createRange();
  range.selectNodeContents(mark);
  const b = box.getBoundingClientRect(), t = range.getBoundingClientRect(), r = right.getBoundingClientRect(), k = mark.getBoundingClientRect();
  const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight);
  const row = box.parentElement!;
  return {
    text: mark.textContent, fs: parseFloat(ms.fontSize), lh: parseFloat(ms.lineHeight), adjust: ms.fontSizeAdjust, overflow: cs.overflowX,
    clipL: b.left, clipR: b.right, contentL: b.left + pl, contentR: b.right - pr, contentW: b.width - pl - pr, boxOver: box.scrollWidth - box.clientWidth,
    textL: t.left, textR: t.right, textW: t.width, markL: k.left, markH: k.height, rightL: r.left, rightR: r.right,
    rowOver: row.scrollWidth - row.clientWidth, w: innerWidth,
  };
}

/**
 * Название в шапке. Место под него — то, что осталось от кнопок справа (не меньше 12px до них, на страницах документов —
 * 16px), размер — по этому месту (100cqi / 4.4: «InviteBloom» в Cormorant Garamond italic — 4.25 своего размера), от 20
 * до 32px, в одну строку. Шрифты в проверках заглушены, поэтому слово рисуется запасным serif — так, как его видят, пока
 * Cormorant Garamond не загрузился (display=swap) или если он не загрузится: здесь это Liberation Serif (метрики Times,
 * как на iPhone), затем DejaVu Serif (WIDE). font-size-adjust:.386 (x-height Cormorant Garamond) сводит запасной шрифт к
 * той же высоте строчных: Times помещается в место целиком, DejaVu Serif — с заходом в поля 6px; слово видно целиком.
 * Без font-size-adjust (старый браузер) слово шире своего места и обрезается по нему (overflow:hidden), а край обрезки —
 * не ближе 6px к кнопкам: на кнопки название не заходит ни в каком шрифте. Кнопки в пределах экрана, шапка не шире экрана.
 */
async function wordmarkFits(page: Page, label: string, spot: Spot) {
  const check = async (font: string) => {
    const l = `${label}, ${font}`;
    const m = await page.evaluate(probe, spot);
    expect(m.text, l).toBe("InviteBloom");
    expect(m.adjust, l).toBe("0.386");
    expect(m.fs, l).toBeGreaterThanOrEqual(20);
    expect(m.fs, l).toBeLessThanOrEqual(32);
    expect(m.fs * 4.4, l).toBeLessThanOrEqual(m.contentW + 0.5);
    // Не уменьшается без нужды: 32px, если для 32px хватает места.
    if (m.contentW >= 32 * 4.4) expect(m.fs, l).toBe(32);
    expect(m.markL, l).toBeGreaterThanOrEqual(15.5);
    expect(m.markL, l).toBeCloseTo(m.contentL, 1);
    expect(m.markH, l).toBeLessThanOrEqual(m.lh + 1);
    expect(m.rightL - m.contentR, l).toBeGreaterThanOrEqual(spot.gap - 0.5);
    // Обрезка по месту названия с полями 6px (в них помещается рамка фокуса) и не ближе 6px к кнопкам.
    expect(m.overflow, l).toBe("hidden");
    expect(m.contentL - m.clipL, l).toBeCloseTo(6, 1);
    expect(m.clipR - m.contentR, l).toBeCloseTo(6, 1);
    expect(m.rightL - m.clipR, l).toBeGreaterThanOrEqual(spot.gap - 6.5);
    expect(m.rightR, l).toBeLessThanOrEqual(m.w - 15.5);
    expect(m.rowOver, l).toBeLessThanOrEqual(0);
    return m;
  };

  const times = await check("запасной шрифт (Times)");
  // Слово видно целиком и помещается в своё место.
  expect(times.textL, label).toBeGreaterThanOrEqual(times.clipL - 0.5);
  expect(times.textR, label).toBeLessThanOrEqual(times.contentR + 0.5);

  const style = await page.addStyleTag({ content: WIDE });
  expect(await page.evaluate(() => document.fonts.load("italic 500 20px 'Cormorant Garamond'", "InviteBloom").then((f) => f.length)), label).toBe(1);
  const wide = await check("DejaVu Serif");
  // Шрифт действительно шире Times (иначе проверка ничего не проверяет); слово всё равно видно целиком. Сравнение с Times
  // в том же браузере: ширина букв зависит от того, как он округляет их до пикселей.
  expect(wide.textW / wide.fs, label).toBeGreaterThan((times.textW / times.fs) * 1.05);
  expect(wide.textL, label).toBeGreaterThanOrEqual(wide.clipL - 0.5);
  // Chromium в CI округляет размер запасного шрифта после font-size-adjust до целого пикселя (ширина слова на 320 px от
  // этого не меняется при 22 и 23px), поэтому слово может выйти за край обрезки на ширину округления, до 3px; на кнопки
  // оно при этом не заходит (край обрезки проверен выше).
  expect(wide.textR, label).toBeLessThanOrEqual(wide.clipR + 3);

  // Браузер без font-size-adjust: DejaVu Serif в полный размер (6,0 своего размера), где он шире места, обрезается
  // по нему (то, что за краем, не рисуется), и край обрезки не ближе 6px к кнопкам.
  await page.evaluate((sel) => ((document.querySelector(sel) as HTMLElement).firstElementChild as HTMLElement).style.fontSizeAdjust = "none", spot.box);
  const raw = await page.evaluate(probe, spot);
  expect(raw.adjust, label).toBe("none");
  expect(raw.textW / raw.fs, label).toBeGreaterThan(5.5);
  if (raw.textR > raw.clipR + 0.5) expect(raw.boxOver, label).toBeGreaterThan(0);
  expect(raw.overflow, label).toBe("hidden");
  expect(raw.rightL - raw.clipR, label).toBeGreaterThanOrEqual(spot.gap - 6.5);
  expect(raw.rowOver, label).toBeLessThanOrEqual(0);

  await page.evaluate((sel) => ((document.querySelector(sel) as HTMLElement).firstElementChild as HTMLElement).style.fontSizeAdjust = ".386", spot.box);
  await style.evaluate((el) => el.remove());
  return { ...times, rawOver: raw.textR - raw.clipR };
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

  it("шапка на 320, 360 и 390 px на всех языках, со «Войти» и с аккаунтом: название в одну строку, не заходит на кнопки и запасным шрифтом, без прокрутки вбок", async () => {
    for (const width of [320, 360, 390]) {
      for (const lang of LANGS) {
        for (const signed of [false, true]) {
          const label = `${width} ${lang} ${signed ? "с аккаунтом" : "без входа"}`;
          const context = await e.newContext({ viewport: { width, height: 760 } });
          await context.addInitScript(setLang, lang);
          if (signed) await e.signIn(context, { firstName: "Абдурахмон", lastName: "Каримов", locale: lang });
          const { page, problems, close } = await e.open("/", { context, waitText: (I18N as Dict)[lang].home.seeTpls });
          await page.locator(signed ? "header [data-account][aria-label]" : "header [data-account]:not([aria-label])").waitFor();
          const m = await wordmarkFits(page, label, APP);
          // Без входа на 320 px название уменьшается, с аккаунтом места хватает почти на 32px; на экране меньше
          // 360 px кнопка языка — без глобуса.
          if (width === 320) expect(m.fs, label)[signed ? "toBeGreaterThan" : "toBeLessThan"](signed ? 28 : 26);
          // Без font-size-adjust широкий запасной шрифт без входа на 320 и 360 px не помещается: его обрезает место названия.
          if (width < 390 && !signed) expect(m.rawOver, label).toBeGreaterThan(10);
          expect(await page.locator("header [data-lang-btn] svg").count(), label).toBe(width < 360 ? 0 : 1);
          if (width === 320) await e.shot(page, `brand-header-${lang}-${signed ? "in" : "out"}-320.png`);
          await e.expectClean(page, problems);
          await close();
          await e.redis.flushdb();
        }
      }
    }
  });

  it("мини-апп на 320 и 390 px: шапка с названием помещается, и запасным шрифтом тоже", async () => {
    for (const width of [320, 390]) {
      for (const lang of LANGS) {
        const tg = 880_000 + width * 10 + LANGS.indexOf(lang);
        await e.db.insert(users).values({ telegramId: tg, phone: uniquePhone(), firstName: "Мадина", locale: lang }).onConflictDoNothing();
        const context = await e.newContext({ viewport: { width, height: 760 } });
        await telegramStub(context, { id: tg, first_name: "Мадина", language_code: lang === "uzc" ? "uz" : lang });
        const { page, problems, close } = await e.open("/app/", { context, waitText: (I18N as Dict)[lang].home.seeTpls });
        await page.locator("header [data-account][aria-label]").waitFor();
        await wordmarkFits(page, `мини-апп ${width} ${lang}`, APP);
        await e.expectClean(page, problems);
        await close();
        await e.redis.flushdb();
      }
    }
  });

  it("страницы документов на 320 px и «не найдено»: InviteBloom в шапке (и запасным шрифтом не заходит на языки), без прокрутки вбок", async () => {
    for (const lang of LANGS) {
      const { page, problems, close } = await e.open(lang === "ru" ? "/privacy" : `/privacy?lang=${lang}`, { viewport: { width: 320, height: 760 } });
      const m = await wordmarkFits(page, `документ ${lang}`, LEGAL);
      expect(m.fs, lang).toBeLessThan(32);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), lang).toBe(0);
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
