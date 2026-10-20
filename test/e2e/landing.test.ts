import { eq, inArray } from "drizzle-orm";
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { startE2E, telegramStub, tgState, uniquePhone, type E2E } from "./helpers.js";

/**
 * Главная (что такое Invito, как это работает, витрина, цены сервера, вопросы, подвал), карточки
 * «Моих приглашений» («Поделиться» / «Опубликовать», «Изменить» с сохранённого шага), события с числом
 * шаблонов, экран шаблонов (стрелки, точки, понятные названия), мини-апп (предпросмотр шаблона) и тур
 * без переключателей разработчика — в браузере вместе с API.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
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

const sheet = (page: Page, name: string) => page.locator(`[data-sheet="${name}"]`);
const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

async function apiAs(userId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: Dict) {
  const res = await e.app.inject({ method, url, headers: { cookie: cookieOf(userId), origin: e.base }, ...(payload && { payload }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json() as Dict;
}
const createInvitation = (userId: string, body: Dict) => apiAs(userId, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "ru", ...body });
/** Опубликованное приглашение без интерфейса (как после оплаты). */
const activate = (id: string) => e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true }).where(eq(invitations.id, id));

/** Цены из настроек сервера (GET /api/auth/config, без входа). */
async function cfgPrices() {
  const res = await e.app.inject({ url: "/api/auth/config" });
  return res.json().prices as { sharedTemplate: number; seat: number; subscriptionMonth: number };
}
/** Активные шаблоны каталога (slug) — их отдаёт GET /api/templates. */
const activeSlugs = async () => new Set((await e.db.select().from(templates).where(eq(templates.isActive, true))).map((x) => x.slug));

/** Сумма так, как её пишет приложение: Intl браузера, тийины в сумы. */
const money = (page: Page, amount: number) =>
  page.evaluate(([a, c]) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format((a as number) / 100) + " " + c, [amount, ru.sum]);

/** Текст в DOM без text-transform (innerText пишет подписи заглавными); неразрывные пробелы сумм остаются. */
const text = (loc: Locator) => loc.evaluate((x) => (x.textContent || "").replace(/[ \t\r\n]+/g, " ").trim());
const content = (page: Page) => page.evaluate(() => document.body.textContent || "");
const waitContent = (page: Page, s: string, timeout = 20_000) =>
  page.waitForFunction((x) => (document.body.textContent || "").includes(x), s, { timeout });

/** Элементы внутри селектора, которые вылезают за ширину окна (кроме прокручиваемых каруселей). */
const overflowing = (page: Page, scope: string, skip = "[data-carousel], [data-home='show']") =>
  page.evaluate(
    ([scope, skip]) => {
      const w = window.innerWidth, bad: string[] = [];
      document.querySelectorAll(scope).forEach((root) =>
        root.querySelectorAll("*").forEach((el) => {
          if (el.closest(skip)) return;
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push(`${el.tagName} «${(el.textContent || "").trim().slice(0, 40)}» ${Math.round(r.left)}…${Math.round(r.right)}`);
        }),
      );
      return bad;
    },
    [scope, skip],
  );

/**
 * Снова главная. Перезагрузка — после того как закончились запросы экрана (прерванный fetch попал бы в консоль);
 * без перезагрузки — логотипом в шапке.
 */
async function reload(page: Page, waitText: string, hard = false) {
  if (hard) {
    const set = pending.get(page)!;
    await expect.poll(() => set.size).toBe(0);
    await page.goto(e.base + "/app/");
  } else await page.getByRole("button", { name: "Invito" }).first().click();
  await e.waitText(page, waitText);
}

/** Незавершённые запросы страницы (для reload с перезагрузкой). */
const pending = new WeakMap<Page, Set<unknown>>();
function track(page: Page) {
  const set = new Set<unknown>();
  pending.set(page, set);
  page.on("request", (r) => set.add(r));
  page.on("requestfinished", (r) => set.delete(r));
  page.on("requestfailed", (r) => set.delete(r));
}

/** Кнопка не закрыта другими слоями: в её центре — она сама. */
const onTop = (loc: Locator) =>
  loc.evaluate((b) => {
    const r = b.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el && b.contains(el);
  });

describe("главная", () => {
  it("без входа: что такое Invito, кнопки, шаги, возможности, витрина, цены сервера, вопросы и подвал", async () => {
    const P = await cfgPrices();
    // Свой шаблон дешевле общей цены: общая ссылка — «от» самой низкой цены, витрина — цена шаблона.
    const cheap = P.sharedTemplate - 1_000_000;
    const [classic] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    await e.db.update(templates).set({ price: cheap }).where(eq(templates.id, classic!.id));
    try {
      const { page, problems, close } = await e.open("/app/");
      const hero = page.locator('[data-home="hero"]');
      await hero.waitFor();
      const heroText = await text(hero);
      for (const s of [ru.home.kick, ru.hero1, ru.hero2, ru.heroSub, ...ru.home.trust]) expect(heroText).toContain(s);
      // Что это: онлайн-приглашение, ссылка в Telegram и WhatsApp, ответы гостей, персональные приглашения
      // (так же, как на экране цен и в листе оплаты).
      for (const s of ["Telegram", "WhatsApp", "ответ", "персональных приглашениях"]) expect(ru.heroSub).toContain(s);
      expect(await text(hero.locator('[data-cta="create"]'))).toContain(ru.create);
      expect(await text(hero.locator('[data-cta="tpls"]'))).toBe(ru.home.seeTpls);
      // Цены — из ответов сервера.
      const shared = ru.fromPrice.replace("{price}", await money(page, cheap));
      await expect.poll(() => text(page.locator("[data-hero-price]"))).toBe(ru.home.price.replace("{shared}", shared).replace("{seat}", await money(page, P.seat)));
      const card = (k: string) => page.locator(`[data-home-price="${k}"]`);
      expect(await text(card("shared").locator("[data-price]"))).toBe(shared);
      expect(await text(card("personal").locator("[data-price]"))).toBe(await money(page, P.seat));
      expect(await text(card("personal"))).toContain(ru.priceEx.replace("{price}", await money(page, 100 * P.seat)));
      expect(await text(card("sub").locator("[data-price]"))).toBe(await money(page, P.subscriptionMonth));
      expect(await text(card("sub"))).toContain(ru.perMonthU);
      // Витрина: название стиля по-русски, событие и цена шаблона.
      const show = page.locator('[data-show="wedding-classic"]').first();
      expect(await text(show)).toContain(ru.stName.classic);
      expect(await text(show)).toContain(await money(page, cheap));
      expect(await text(page.locator('[data-show="birthday-polaroid"]').first())).toContain(ru.stName.polaroid);
      // Как это работает — 4 шага, возможности — 6 карточек, вопросы — 7.
      expect(await page.locator("[data-how]").count()).toBe(ru.home.how.length);
      expect(ru.home.how).toHaveLength(4);
      for (const [i, [title, body]] of ru.home.how.entries()) {
        const step = page.locator("[data-how]").nth(i);
        expect(await text(step)).toContain(title);
        expect(await text(step)).toContain(body);
      }
      expect(await page.locator("[data-feat]").count()).toBe(6);
      const faq = page.locator("[data-home-faq]");
      expect(await faq.count()).toBe(ru.home.faq.length);
      expect(ru.home.faq.length).toBeGreaterThanOrEqual(5);
      expect(ru.home.faq.length).toBeLessThanOrEqual(7);
      expect(await page.locator('[data-home-faq][aria-expanded="true"]').count()).toBe(0);
      // Вопрос об оплате: раскрывается, второй вопрос закрывает первый.
      const pay = ru.home.faq.findIndex(([q]: string[]) => q === "Как оплатить?");
      // Банковской картой через Multicard, без названий платёжных систем (какие карты принимаются, показывает страница оплаты).
      expect(ru.home.faq[pay][1]).toMatch(/^Банковской картой .*Multicard/);
      expect(ru.home.faq[pay][1]).not.toMatch(/Uzcard|Humo|Visa|Mastercard/);
      await page.locator(`[data-home-faq="${pay}"]`).click();
      expect(await page.locator(`[data-home-faq="${pay}"]`).getAttribute("aria-expanded")).toBe("true");
      expect(await text(page.locator("#faq"))).toContain(ru.home.faq[pay][1]);
      await page.locator('[data-home-faq="0"]').click();
      expect(await text(page.locator("#faq"))).not.toContain(ru.home.faq[pay][1]);
      expect(await text(page.locator("#faq"))).toContain(ru.home.faq[0][1]);
      // Без входа «Мои приглашения» — ниже, с подсказкой войти.
      expect(await page.locator("#my-inv").getAttribute("data-inv-top")).toBeNull();
      expect(await text(page.locator("#my-inv"))).toContain(ru.invLoginHint);
      // Подвал: разделы, оферта, политика и контакты на языке интерфейса; бота нет — без ссылки на него.
      expect(await page.locator("[data-foot-nav]").evaluateAll((a) => a.map((x) => x.getAttribute("data-foot-nav")))).toEqual(["tpls", "prices", "tour", "inv"]);
      for (const [k, href] of [["oferta", "/oferta"], ["privacy", "/privacy"], ["contacts", "/contacts"]]) {
        const a = page.locator(`[data-foot-link="${k}"]`);
        expect(await a.getAttribute("href"), k).toBe(href);
        expect(await a.getAttribute("target"), k).toBe("_blank");
      }
      expect(await text(page.locator('[data-foot-link="oferta"]'))).toBe(ru.home.offer);
      expect(await page.locator('[data-foot-link="bot"]').count()).toBe(0);
      expect(await text(page.locator("[data-foot]"))).toContain(ru.home.copy.replace("{year}", String(new Date().getFullYear())));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(await overflowing(page, "[data-home], [data-foot]")).toEqual([]);
      await e.shot(page, "landing-ru-390x844.png");

      // «Все цены и подписка» — экран цен.
      await page.locator("[data-home-pricing]").click();
      await page.locator('[data-screen="pricing"]').waitFor();
      expect(await page.evaluate(() => location.hash)).toBe("#/pricing");
      // «Смотреть шаблоны» — все шаблоны каталога.
      await page.goto(e.base + "/app/");
      await page.locator('[data-cta="tpls"]').click();
      await page.locator('[data-tour-tab="tpl"][aria-selected="true"]').waitFor();
      const act = await activeSlugs();
      expect(await page.locator("[data-gal]").count()).toBe(D.TEMPLATES.filter((x: Dict) => act.has(x.id)).length);
      // Шаблон витрины открывается на экране шаблонов.
      await page.goto(e.base + "/app/");
      await page.locator('[data-show="birthday-polaroid"]').first().dispatchEvent("click");
      await page.locator("[data-tpl-info]").waitFor();
      expect(await text(page.locator("[data-tpl-info]"))).toContain(ru.stName.polaroid);
      expect(await content(page)).toContain(D.EVENTS.birthday.label.ru);
      // Последний призыв — выбор события.
      await page.goto(e.base + "/app/");
      await page.locator('[data-cta="final"]').click();
      await e.waitText(page, ru.chooseEvent);
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ price: classic!.price }).where(eq(templates.id, classic!.id));
    }
  });

  it("по-узбекски на 360 px: тексты на узбекском, ничего не вылезает на главной, в карточках, событиях и шаблонах", async () => {
    const context = await e.newContext({ viewport: { width: 360, height: 760 } });
    await context.addInitScript(() => { try { localStorage.setItem("invito.lang", "uz"); } catch {} });
    const user = await e.signIn(context, { firstName: "Aziz", locale: "uz" });
    const live = await createInvitation(user.id, { language: "uz", data: { names: "Dilnoza va Jasur", intro: "none" } });
    await activate(live.id);
    await createInvitation(user.id, { template: "birthday-polaroid", mode: "personal", language: "uz", data: { names: "Aziz · 30", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Aziz · 30" });
    const heroText = await text(page.locator('[data-home="hero"]'));
    for (const s of [uz.hero1, uz.hero2, uz.heroSub]) expect(heroText).toContain(s);
    expect(await text(page.locator('[data-inv-card="live"] [data-inv-share]'))).toBe(uz.invShare + " →");
    expect(await text(page.locator('[data-inv-card="draft"] [data-inv-share]'))).toBe(uz.publishBtn + " →");
    await page.locator('[data-home-faq="1"]').click();
    expect(await text(page.locator("#faq"))).toContain(uz.home.faq[1][1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(await overflowing(page, "#my-inv, [data-home], [data-foot]")).toEqual([]);
    await e.shot(page, "landing-uz-360x760.png");
    // События и шаблоны.
    await page.locator('[data-cta="create"]').click();
    await page.locator('[data-ev="wedding"]').waitFor();
    expect(await text(page.locator('[data-ev="wedding"] [data-ev-count]'))).toBe(`${D.EVENTS.wedding.styles.length} ${uz.tplCount}`);
    expect(await overflowing(page, "main")).toEqual([]);
    await page.locator('[data-ev="wedding"]').click();
    await page.locator("[data-tpl-info]").waitFor();
    expect(await text(page.locator("[data-car-pos]"))).toBe(uz.tplPos.replace("{i}", "1").replace("{n}", String(D.EVENTS.wedding.styles.length)) + " · " + uz.swipe + " →");
    expect(await text(page.locator("[data-tpl-info]"))).toContain(uz.stName.classic);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(await overflowing(page, "main")).toEqual([]);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("Мои приглашения", () => {
  it("вверху главной; опубликованное — «Поделиться», черновик — «Опубликовать»; «Изменить» продолжает с сохранённого шага", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context, { firstName: "Азиз" });
    const live = await createInvitation(user.id, { data: { names: "Опубликовано тест", intro: "none" } });
    await activate(live.id);
    const draft = await createInvitation(user.id, { data: { names: "Черновик тест", intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Черновик тест" });
    track(page);
    const top = page.locator("#my-inv");
    expect(await top.getAttribute("data-inv-top")).toBe("1");
    expect((await top.boundingBox())!.y).toBeLessThan((await page.locator('[data-home="hero"]').boundingBox())!.y);
    const liveCard = page.locator('[data-inv-card="live"]').filter({ hasText: "Опубликовано тест" });
    const draftCard = page.locator('[data-inv-card="draft"]').filter({ hasText: "Черновик тест" });
    expect(await liveCard.locator("[data-inv-share]").getAttribute("data-inv-share")).toBe("share");
    expect(await text(liveCard.locator("[data-inv-share]"))).toBe(ru.invShare + " →");
    expect(await liveCard.locator("[data-draft-hint]").count()).toBe(0);
    expect(await draftCard.locator("[data-inv-share]").getAttribute("data-inv-share")).toBe("publish");
    expect(await text(draftCard.locator("[data-inv-share]"))).toBe(ru.publishBtn + " →");
    expect(await text(draftCard.locator("[data-draft-hint]"))).toBe(ru.invDraftHint);
    // Остальные действия на месте; название стиля по-русски.
    for (const card of [liveCard, draftCard]) {
      for (const name of [ru.guests, ru.edit, ru.duplicate, ru.open + " ↗", ru.deleteD]) expect(await card.getByRole("button", { name, exact: true }).count(), name).toBe(1);
      expect(await text(card)).toContain(ru.stName.classic);
    }
    await e.shot(page, "my-inv-ru-390x844.png");

    // Опубликованное → «Поделиться»: экран ссылки.
    await liveCard.locator('[data-inv-share="share"]').click();
    await e.waitText(page, ru.linkReady);
    // Черновик → «Опубликовать»: лист оплаты, как «Получить ссылку».
    await reload(page, "Черновик тест");
    await draftCard.locator('[data-inv-share="publish"]').click();
    await sheet(page, "pay").waitFor();
    await sheet(page, "pay").getByRole("button", { name: ru.close }).click();
    await sheet(page, "pay").waitFor({ state: "detached" });

    // «Изменить» у черновика: конструктор с первого шага, потом — с шага, на котором остановились.
    await reload(page, "Черновик тест");
    await draftCard.getByRole("button", { name: ru.edit, exact: true }).click();
    await waitContent(page, ru.stepOf.replace("{n}", "1").replace("{total}", "9"));
    await page.getByTitle(ru.steps.where).first().click();
    await waitContent(page, ru.stepOf.replace("{n}", "3").replace("{total}", "9"));
    await expect.poll(() => page.evaluate((id) => localStorage.getItem("invito.step." + id), draft.id)).toBe("2");
    await reload(page, "Черновик тест", true);
    await draftCard.getByRole("button", { name: ru.edit, exact: true }).click();
    await waitContent(page, ru.stepOf.replace("{n}", "3").replace("{total}", "9"));
    // «Изменить» у опубликованного: сразу редактор на странице приглашения.
    await reload(page, "Опубликовано тест");
    await liveCard.getByRole("button", { name: ru.edit, exact: true }).click();
    await e.waitText(page, ru.tapHint);
    // Редактор, а не конструктор: панель инструментов редактора (в ней тоже есть «Разделы»), счётчика шагов нет.
    await page.locator("[data-ed-tools]").waitFor();
    expect(await page.locator("[data-step-of]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });

  it("больше трёх приглашений: первые три и «Показать все · N»", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    for (const n of [1, 2, 3, 4]) await createInvitation(user.id, { data: { names: `Список ${n}`, intro: "none" } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Список" });
    await expect.poll(() => page.locator("[data-inv-card]").count()).toBe(3);
    const all = page.locator("[data-inv-all]");
    expect(await text(all)).toBe(ru.home.invAll.replace("{n}", "4"));
    await all.click();
    expect(await page.locator("[data-inv-card]").count()).toBe(4);
    expect(await text(all)).toBe(ru.home.invLess);
    await e.expectClean(page, problems);
    await close();
  });

  it("без приглашений: раздел внизу, «Создать приглашение»", async () => {
    const context = await e.newContext();
    await e.signIn(context);
    const { page, problems, close } = await e.open("/app/", { context, waitText: ru.noInv });
    expect(await page.locator("#my-inv").getAttribute("data-inv-top")).toBeNull();
    expect((await page.locator("#my-inv").boundingBox())!.y).toBeGreaterThan((await page.locator('[data-home="faq"]').boundingBox())!.y);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("события и шаблоны", () => {
  it("число шаблонов события — с сервера: выключенный в админке шаблон не считается", async () => {
    const off = ["wedding-botanical", "birthday-riso"];
    await e.db.update(templates).set({ isActive: false }).where(inArray(templates.slug, off));
    try {
      const act = await activeSlugs();
      const P = await cfgPrices();
      const { page, problems, close } = await e.open("/app/");
      await page.locator('[data-cta="create"]').click();
      await page.locator('[data-ev="wedding"]').waitFor();
      const keys = await page.locator("[data-ev]").evaluateAll((a) => a.map((x) => x.getAttribute("data-ev")));
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys as string[]) {
        const n = D.EVENTS[k].styles.filter((st: string) => act.has(`${k}-${st}`)).length;
        await expect.poll(() => text(page.locator(`[data-ev="${k}"] [data-ev-count]`)), k).toBe(`${n} ${D.plural("ru", n, ru.tplCount)}`);
      }
      expect(await text(page.locator('[data-ev="wedding"] [data-ev-count]'))).toBe("4 шаблона");
      expect(await text(page.locator('[data-ev="birthday"] [data-ev-count]'))).toBe(`${D.EVENTS.birthday.styles.length - 1} ${D.plural("ru", D.EVENTS.birthday.styles.length - 1, ru.tplCount)}`);
      // Цена события — цены его активных шаблонов с сервера («от», если они разные).
      const wp = (await e.db.select().from(templates).where(inArray(templates.slug, [...act].filter((x) => x.startsWith("wedding-"))))).map((x) => x.price ?? P.sharedTemplate);
      const lo = await money(page, Math.min(...wp));
      expect(await text(page.locator('[data-ev="wedding"] [data-ev-price]'))).toBe(Math.min(...wp) === Math.max(...wp) ? lo : ru.fromPrice.replace("{price}", lo));
      // На экране шаблонов — тоже четыре свадебных: точки и «1 из 4».
      await page.locator('[data-ev="wedding"]').click();
      await page.locator("[data-tpl-info]").waitFor();
      expect(await page.locator("[data-dot]").count()).toBe(4);
      expect(await text(page.locator("[data-car-pos]"))).toBe(`1 из 4 · ${ru.swipe} →`);
      expect(await content(page)).not.toContain(ru.stName.botanical);
      await e.expectClean(page, problems);
      await close();
    } finally {
      await e.db.update(templates).set({ isActive: true }).where(inArray(templates.slug, off));
    }
  });

  it("на компьютере: стрелки, точки и «2 из 5»; понятные названия, описание и цвета без шрифтов", async () => {
    const { page, problems, close } = await e.open("/app/", { viewport: { width: 1366, height: 900 } });
    await page.locator('[data-cta="create"]').click();
    await page.locator('[data-ev="wedding"]').click();
    const info = page.locator("[data-tpl-info]");
    await info.waitFor();
    const n = D.EVENTS.wedding.styles.length;
    const prev = page.locator('[data-car="prev"]'), next = page.locator('[data-car="next"]');
    expect(await prev.getAttribute("aria-label")).toBe(ru.prevTpl);
    expect(await next.getAttribute("aria-label")).toBe(ru.nextTpl);
    // Стрелки видны на первом экране, рядом с карточками.
    for (const b of [prev, next]) {
      const box = (await b.boundingBox())!;
      expect(box.y + box.height).toBeLessThan(900 - 80);
      expect(await onTop(b)).toBe(true);
    }
    expect(await page.locator("[data-dot]").count()).toBe(n);
    expect(await page.locator('[data-dot="0"]').getAttribute("aria-current")).toBe("true");
    expect(await text(page.locator("[data-car-pos]"))).toBe(`1 из ${n}`);
    expect(await text(info)).toContain(ru.stName.classic);
    await next.click();
    await expect.poll(() => page.locator('[data-dot="1"]').getAttribute("aria-current")).toBe("true");
    expect(await text(page.locator("[data-car-pos]"))).toBe(`2 из ${n}`);
    const st = D.EVENTS.wedding.styles[1];
    await expect.poll(() => text(info)).toContain(ru.stName[st]);
    // Что можно настроить — простыми словами, вместо списка шрифтов; цвета — по-русски.
    const what = info.locator("[data-tpl-what] li");
    expect(await what.count()).toBe(3);
    expect(await text(what.nth(0))).toContain(ru.tplWhatL[0]);
    const S = D.STYLES[st], VV = (D.VARIANTS[st] || []) as Dict[];
    expect(await text(what.nth(2))).toContain(ru.tplWhatL[2].replace("{p}", String(VV.length || 1)).replace("{f}", String(S.fonts.length)));
    const infoText = await text(info);
    for (const f of S.fonts) expect(infoText, f).not.toContain(f);
    expect(infoText).toContain(ru.colorsL);
    expect(VV.length).toBeGreaterThan(1);
    for (const v of VV) expect(infoText).toContain(ru.palName[v.name]);
    expect(infoText).toContain(ru.sd[st]);
    // Стрелка назад и точка: выбор меняется.
    await prev.click();
    await expect.poll(() => page.locator('[data-dot="0"]').getAttribute("aria-current")).toBe("true");
    await page.locator('[data-dot="3"]').click();
    await expect.poll(() => text(page.locator("[data-car-pos]"))).toBe(`4 из ${n}`);
    await e.shot(page, "templates-ru-1366x900.png");
    await e.expectClean(page, problems);
    await close();
  });

  it("на телефоне: без стрелок, «1 из 5 · листайте →»", async () => {
    const { page, problems, close } = await e.open("/app/");
    await page.locator('[data-cta="create"]').click();
    await page.locator('[data-ev="wedding"]').click();
    await page.locator("[data-tpl-info]").waitFor();
    expect(await page.locator("[data-car]").count()).toBe(0);
    expect(await text(page.locator("[data-car-pos]"))).toBe(`1 из ${D.EVENTS.wedding.styles.length} · ${ru.swipe} →`);
    // Кнопка предпросмотра — одна (внизу экрана), отдельная — только в мини-аппе.
    expect(await page.locator("[data-tpl-preview]").count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });
});

describe("мини-апп", () => {
  it("шаблоны: «Предпросмотр» на экране, в предпросмотре «Назад» и «Выбрать шаблон» над конвертом", async () => {
    const tgId = 7_800_000_000 + Math.floor(Math.random() * 1e6);
    await e.db.insert(users).values({ telegramId: tgId, phone: uniquePhone(), firstName: "Madina", locale: "ru" });
    const context = await e.newContext();
    await telegramStub(context, { id: tgId, first_name: "Madina", language_code: "ru" });
    const { page, problems, close } = await e.open("/app/", { context });
    await expect.poll(async () => (await tgState(page)).main.text).toBe(ru.create);
    await page.evaluate(() => (window as any).__tg.main.fn());
    await page.locator('[data-ev="wedding"]').click();
    const btn = page.locator("[data-tpl-preview]");
    await btn.waitFor();
    expect(await text(btn)).toBe(ru.preview + " ↗");
    await btn.click();
    // Заставка-конверт закрыта: кнопки предпросмотра всё равно сверху.
    await waitContent(page, ru.tapOpen);
    const back = page.getByRole("button", { name: "← " + ru.back, exact: true });
    const use = page.locator("[data-preview-bar]").getByRole("button", { name: ru.useTpl + " →" });
    await use.waitFor();
    expect(await onTop(back)).toBe(true);
    expect(await onTop(use)).toBe(true);
    await e.shot(page, "tg-preview-ru-390x844.png");
    // «Назад» — снова экран шаблонов.
    await back.click();
    await btn.waitFor();
    await btn.click();
    await use.waitFor();
    await use.click();
    await page.getByTitle(ru.stepsX.sections).waitFor();
    await e.expectClean(page, problems);
    await close();
  });
});

describe("тур «Возможности»", () => {
  it("для клиента: вкладки возможностей и шаблонов, без переключателей разработчика", async () => {
    const { page, problems, close } = await e.open("/app/");
    await page.locator("[data-home-tour]").click();
    await page.locator('[data-tour-tab="feat"][aria-selected="true"]').waitFor();
    const keys = (await page.locator("[data-demo]").evaluateAll((a) => a.map((x) => x.getAttribute("data-demo")))) as string[];
    expect(keys.length).toBeGreaterThan(10);
    for (const k of ["languages", "telegram", "dark"]) expect(keys).not.toContain(k);
    // Подписи разделов — по-русски, без технических слов.
    const tour = await text(page.locator("main"));
    for (const w of ["CSV", "OG", "toggle"]) expect(tour).not.toContain(w);
    for (const c of Object.values(ru.tourCat) as string[]) expect(tour.toUpperCase()).toContain(c.toUpperCase());
    expect(await page.locator("[data-gal]").count()).toBe(0);
    await page.locator('[data-tour-tab="tpl"]').click();
    await page.locator('[data-tour-tab="tpl"][aria-selected="true"]').waitFor();
    expect(await page.locator("[data-gal]").count()).toBeGreaterThan(0);
    expect(await page.locator("[data-demo]").count()).toBe(0);
    // Демо открывается: «Попробовать» — страница приглашения в режиме демо.
    await page.locator('[data-tour-tab="feat"]').click();
    await page.locator('[data-demo="envelope"]').click();
    await waitContent(page, ru.tapOpen);
    await e.expectClean(page, problems);
    await close();
  });
});
