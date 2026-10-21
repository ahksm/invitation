import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guests, invitations } from "../../src/db/schema.js";
import { I18N, LANG_NAMES, plural } from "../../web/invito-data.js";
import { startE2E, type E2E } from "./helpers.js";

/**
 * Страница гостя: что гость видит и что из этого публично. Сообщение хозяевам попадает в гостевую книгу только
 * с согласия гостя; пустая книга без «00»; форма ответа (подписи, число гостей до 8, меню по желанию, понятная
 * ошибка пустой формы); срок ответа владельца и закрытый приём; отсчёт после события; длинные имена в героях,
 * конверт, контраст акцентного текста; компактная программа, контакты кнопками, меню языка, частицы под текстом,
 * «Пропустить» у стирающейся карточки.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
const M = { width: 390, height: 844 };
const DESK = { width: 1366, height: 900 };
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

const cookieOf = (userId: string) => `session=${e.app.jwt.sign({ sub: userId })}`;

async function createInvitation(userId: string, body: Dict) {
  const res = await e.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: cookieOf(userId), origin: e.base },
    payload: { template: "wedding-classic", mode: "shared", language: "ru", ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Dict;
}

const publish = (id: string, values: Partial<typeof invitations.$inferInsert> = {}) =>
  e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true, ...values }).where(eq(invitations.id, id));
const invById = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const guestsOf = (id: string) => e.db.select().from(guests).where(eq(guests.invitationId, id)).orderBy(guests.seat);
/** Меняет содержимое приглашения в базе и сбрасывает кэш представлений. */
async function setData(id: string, patch: Dict) {
  const inv = await invById(id);
  await e.db.update(invitations).set({ data: { ...(inv.data as Dict), ...patch } }).where(eq(invitations.id, id));
  await e.redis.flushdb();
}
/** Дата по календарю Ташкента через days дней. */
const tashDay = (days: number) => new Date(Date.now() + days * 864e5 + 5 * 36e5).toISOString().slice(0, 10);
const rsvpApi = (slug: string, body: Dict) =>
  e.app.inject({ method: "POST", url: `/api/public/i/${slug}/rsvp`, headers: { origin: e.base }, payload: { status: "yes", count: 1, diet: [], msg: "", ...body } });

async function toManage(page: Page) {
  await page.locator("#my-inv").getByRole("button", { name: ru.guests, exact: true }).first().click();
  await e.waitText(page, ru.guestList);
}

/** Контраст двух цветов CSS (rgb/rgba) по WCAG. */
function contrast(fg: string, bg: string) {
  const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const a = lum(rgb(fg)), b = lum(rgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Имена в герое: слова целиком на одной строке и внутри окна, без переноса с дефисом. */
const heroNames = (page: Page) =>
  page.evaluate(() => {
    const h = document.querySelector("[data-hero] h1[data-fit]") as HTMLElement;
    const W = document.documentElement.clientWidth;
    const words: { w: string; lines: number; left: number; right: number }[] = [];
    const tw = document.createTreeWalker(h, NodeFilter.SHOW_TEXT), rg = document.createRange();
    for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
      const re = /\S+/g; let m: RegExpExecArray | null;
      while ((m = re.exec(n.data))) {
        rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
        const rects = [...rg.getClientRects()].filter((r) => r.width > 0);
        words.push({ w: m[0], lines: new Set(rects.map((r) => Math.round(r.top))).size, left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) });
      }
    }
    return { W, words, hyphens: getComputedStyle(h).hyphens, hero: (h.closest("[data-hero]") as HTMLElement).innerText };
  });

describe("страница гостя: ответ и гостевая книга", () => {
  it("сообщение хозяевам по умолчанию видно только владельцу; в книге — только с согласия гостя; пустая книга без «00»", async () => {
    const owner = await e.newContext();
    const user = await e.signIn(owner);
    const inv = await createInvitation(user.id, { data: { names: "Книга тест", date: tashDay(30), time: "18:00", intro: "none" } });
    await publish(inv.id);
    const slug = inv.slug as string;
    const { page, problems, close } = await e.open(`/i/${slug}`, { viewport: M, waitText: "Книга тест" });

    // Пустая книга: подсказка и кнопка, а не огромное «00».
    const book = page.locator("section").filter({ has: page.locator("[data-gb-empty]") });
    await book.scrollIntoViewIfNeeded();
    expect(await page.locator("[data-gb-count]").count()).toBe(0);
    expect(await page.locator("[data-gb-empty]").innerText()).toBe(ru.guestbookHint);
    expect(await book.innerText()).not.toMatch(/\b0+\b/);
    await e.shot(page, "guest-book-empty-ru-390x844.png");
    // «Оставить первое пожелание» ведёт к полю сообщения, и отметка «Показать в гостевой книге» уже стоит.
    await page.locator("[data-gb-first]").click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    const pub = page.locator("#rsvp [data-msg-public]");
    expect(await pub.getAttribute("aria-checked")).toBe("true");
    // Гость передумал: снимает отметку — сообщение уходит только хозяевам.
    await pub.click();
    expect(await pub.getAttribute("aria-checked")).toBe("false");
    expect(await page.locator("#rsvp").innerText()).toContain(ru.msgPrivHint);
    await page.locator("#rsvp input[name=rsvp-name]").fill("Скрытый Гость");
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await page.locator("#rsvp textarea").fill("Секретное поздравление");
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    await expect.poll(async () => (await guestsOf(inv.id)).length).toBe(1);
    expect((await guestsOf(inv.id))[0]).toMatchObject({ message: "Секретное поздравление", messagePublic: false });
    await page.reload();
    await e.waitText(page, ru.thanks);
    expect(await page.locator("body").innerText()).not.toContain("Секретное поздравление");

    // Другой гость сам решил показать пожелание: оно в книге, а скрытое — нет, и в данных страницы тоже.
    expect((await rsvpApi(slug, { name: "Феруза Алиева", msg: "Публичное поздравление", public: true })).statusCode).toBe(200);
    expect((await rsvpApi(slug, { name: "Тихий Гость", msg: "Ещё одно личное" })).statusCode).toBe(200);
    const view = (await e.app.inject({ method: "GET", url: `/api/public/i/${slug}` })).body;
    expect(view).toContain("Публичное поздравление");
    expect(view).not.toContain("Секретное поздравление");
    expect(view).not.toContain("Ещё одно личное");
    await page.reload();
    await e.waitText(page, "Публичное поздравление");
    expect(await page.locator("[data-gb-count]").innerText()).toBe("01");
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("Секретное поздравление");
    expect(body).not.toContain("Ещё одно личное");
    await e.expectClean(page, problems);
    await close();

    // Владелец видит все сообщения и отметку, какое из них в гостевой книге.
    const app = await e.open("/app/", { context: owner, waitText: "Книга тест" });
    await toManage(app.page);
    const priv = app.page.locator('[data-guest-msg="private"]');
    await expect.poll(() => priv.count()).toBe(2);
    expect(await priv.first().innerText()).toContain(ru.msgHidden);
    expect(await app.page.locator('[data-guest-msg="public"]').innerText()).toContain("Публичное поздравление");
    expect(await app.page.locator('[data-guest-msg="public"]').innerText()).toContain(ru.msgShown);
    expect(await app.page.locator("[data-guest-msg]").allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining("Секретное поздравление")]));
    await e.shot(app.page, "guest-book-owner-ru-390x844.png");
    await e.expectClean(app.page, app.problems);
    await app.close();
  });

  it("форма: подпись без «RSVP», понятное число гостей до 8, меню по желанию и не для «нет», пустая отправка объясняет и ведёт к имени", async () => {
    const user = await e.signIn(await e.newContext());
    const inv = await createInvitation(user.id, { data: { names: "Форма тест", date: tashDay(20), time: "18:00", intro: "none" } });
    await publish(inv.id);
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport: M, waitText: "Форма тест" });
    const rsvp = page.locator("#rsvp");
    await rsvp.scrollIntoViewIfNeeded();
    expect(await rsvp.innerText()).not.toMatch(/RSVP/i);
    expect(await rsvp.locator(":scope > div > div").first().innerText()).toBe(ru.rsvpKick.toUpperCase());

    // Пустая форма: подсказка про имя и ответ, курсор и прокрутка — к полю имени.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await rsvp.getByRole("button", { name: ru.send }).click();
    expect(await rsvp.locator("[data-rsvp-need]").innerText()).toBe(ru.needBoth);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("rsvp-name");
    await expect.poll(() => page.locator("input[name=rsvp-name]").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    await e.shot(page, "guest-rsvp-need-both-ru-390x844.png");

    // «Да»: сколько вас будет (вместе с вами), не больше 8.
    await rsvp.getByRole("button", { name: ru.yes }).click();
    expect(await rsvp.getByRole("button", { name: ru.yes }).getAttribute("aria-pressed")).toBe("true");
    const count = rsvp.locator("[data-rsvp-count]");
    expect(await count.innerText()).toContain(ru.guestsCount);
    const plus = count.getByRole("button", { name: "+" });
    for (let i = 0; i < 7; i++) await plus.click();
    expect(await count.locator("[data-count-n]").innerText()).toBe("8");
    // У предела «+» недоступна (aria-disabled), и нажатие всё равно не прибавляет.
    expect(await plus.getAttribute("aria-disabled")).toBe("true");
    await plus.click({ force: true });
    expect(await count.locator("[data-count-n]").innerText()).toBe("8");
    expect(await count.locator("[data-count-max]").innerText()).toBe(ru.countMax);

    // Пожелания по меню свёрнуты и необязательны.
    const diet = rsvp.locator("[data-diet]");
    expect(await diet.locator("[data-diet-opt]").count()).toBe(0);
    await diet.getByRole("button", { name: ru.dietMore }).click();
    await expect.poll(() => diet.locator("[data-diet-opt]").count()).toBeGreaterThan(0);
    await diet.locator('[data-diet-opt="veg"]').click();
    expect(await diet.locator('[data-diet-opt="veg"]').getAttribute("aria-pressed")).toBe("true");
    await e.shot(page, "guest-rsvp-count-diet-ru-390x844.png");

    // «Нет»: ни числа гостей, ни меню.
    await rsvp.getByRole("button", { name: ru.no }).click();
    expect(await rsvp.locator("[data-rsvp-count]").count()).toBe(0);
    expect(await rsvp.locator("[data-diet]").count()).toBe(0);
    await rsvp.getByRole("button", { name: ru.yes }).click();
    await page.locator("input[name=rsvp-name]").fill("Восемь Гостей");
    await rsvp.getByRole("button", { name: ru.send }).click();
    await e.waitText(page, ru.thanks);
    await expect.poll(async () => (await guestsOf(inv.id))[0]?.plus).toBe(7);
    expect((await guestsOf(inv.id))[0]!.diet).toEqual(["veg"]);
    // QR для входа можно сохранить картинкой.
    const save = page.locator("[data-entry-qr] [data-qr-save]");
    expect(await save.getAttribute("download")).toBe("invitebloom-qr.png");
    expect(await save.getAttribute("href")).toMatch(/^data:image\/png;base64,/);
    await e.expectClean(page, problems);
    await close();

    // На узбекском: «Javob», халяль не предлагается (на узбекском той он подразумевается).
    const uzInv = await createInvitation(user.id, { language: "uz", data: { names: "Forma test", date: tashDay(20), intro: "none" } });
    await publish(uzInv.id);
    const p2 = await e.open(`/i/${uzInv.slug}`, { viewport: M, waitText: "Forma test" });
    const r2 = p2.page.locator("#rsvp");
    await r2.scrollIntoViewIfNeeded();
    expect(await r2.innerText()).not.toMatch(/RSVP/i);
    expect(await r2.locator(":scope > div > div").first().innerText()).toBe(uz.rsvpKick.toUpperCase());
    await r2.getByRole("button", { name: uz.yes }).click();
    expect(await r2.locator("[data-rsvp-count]").innerText()).toContain(uz.guestsCount);
    await r2.locator("[data-diet]").getByRole("button", { name: uz.dietMore }).click();
    await expect.poll(() => r2.locator("[data-diet-opt]").count()).toBeGreaterThan(0);
    expect(await r2.locator('[data-diet-opt="halal"]').count()).toBe(0);
    await e.shot(p2.page, "guest-rsvp-uz-390x844.png");
    await e.expectClean(p2.page, p2.problems);
    await p2.close();
  });

  it("срок ответа: поле в конструкторе сохраняется; гость видит «ответьте до» только при сроке; после срока и после события приём закрыт, 410 тоже закрывает форму", async () => {
    const owner = await e.newContext();
    const user = await e.signIn(owner);
    const date = tashDay(40);
    const inv = await createInvitation(user.id, { data: { names: "Срок тест", date, time: "18:00", intro: "none" } });

    // Конструктор: шаг «Дата и время», поле «Ответить до» необязательное, со стиранием.
    const app = await e.open("/app/", { context: owner, waitText: "Срок тест" });
    await app.page.locator("#my-inv [data-rv]").filter({ hasText: "Срок тест" }).getByRole("button", { name: ru.edit }).click();
    await app.page.getByTitle(ru.steps.when).click();
    const by = app.page.locator('input[name="rsvp-by"]');
    await by.waitFor();
    expect(await by.inputValue()).toBe("");
    expect(await by.getAttribute("max")).toBe(date);
    expect(await app.page.locator("[data-rsvpby-note]").innerText()).toBe(ru.rsvpByHint);
    const deadline = tashDay(20);
    await by.fill(deadline);
    await expect.poll(async () => ((await invById(inv.id)).data as Dict).rsvpBy).toBe(deadline);
    await e.shot(app.page, "guest-rsvpby-builder-ru-390x844.png");
    await app.page.locator("[data-rsvpby-clear]").click();
    await expect.poll(async () => ((await invById(inv.id)).data as Dict).rsvpBy ?? "").toBe("");
    expect(await by.inputValue()).toBe("");
    await by.fill(deadline);
    await expect.poll(async () => ((await invById(inv.id)).data as Dict).rsvpBy).toBe(deadline);
    await e.expectClean(app.page, app.problems);
    await app.close();
    await publish(inv.id);

    // Гость видит срок, выбранный владельцем.
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport: M, waitText: "Срок тест" });
    const line = page.locator("#rsvp [data-rsvp-by]");
    const day = String(Number(deadline.slice(8)));
    expect(await line.innerText()).toMatch(new RegExp("^" + ru.replyBy.split("{date}")[0] + day + "\\s[а-я]+$"));

    // Срок прошёл: формы нет, вместо неё — «Приём ответов завершён».
    await setData(inv.id, { rsvpBy: tashDay(-1) });
    await page.reload();
    await e.waitText(page, "Срок тест");
    const closed = page.locator('#rsvp [data-rsvp-closed="1"]');
    await closed.waitFor();
    expect(await closed.innerText()).toContain(ru.rsvpClosedT);
    expect(await closed.innerText()).toContain(ru.rsvpClosedBy.split("{date}")[0]);
    expect(await page.locator("#rsvp input[name=rsvp-name]").count()).toBe(0);
    expect(await page.locator("#rsvp [data-rsvp-by]").count()).toBe(0);
    await closed.scrollIntoViewIfNeeded();
    await e.shot(page, "guest-rsvp-closed-ru-390x844.png");
    await e.expectClean(page, problems);

    // Срок истёк, пока гость заполнял форму: сервер отвечает 410, форма сменяется на «закрыто».
    await setData(inv.id, { rsvpBy: tashDay(5) });
    await page.reload();
    await e.waitText(page, "Срок тест");
    await page.locator("#rsvp input[name=rsvp-name]").fill("Поздний Гость");
    await page.locator("#rsvp").getByRole("button", { name: ru.yes }).click();
    await setData(inv.id, { rsvpBy: tashDay(-1) });
    await page.locator("#rsvp").getByRole("button", { name: ru.send }).click();
    await closed.waitFor();
    expect(await guestsOf(inv.id)).toHaveLength(0);
    // Ошибку 410 Chromium пишет в консоль сам: она ожидаема.
    expect(problems.console.every((m) => m.includes("410"))).toBe(true);
    problems.console.length = 0;
    await e.expectClean(page, problems);
    await close();

    // Без срока строки «ответьте до» нет; событие прошло — приём закрыт, отсчёта нет, пустой книги тоже.
    const past = await createInvitation(user.id, { data: { names: "Прошло тест", date: tashDay(-2), time: "18:00", intro: "none" } });
    await publish(past.id);
    const p2 = await e.open(`/i/${past.slug}`, { viewport: M, waitText: "Прошло тест" });
    expect(await p2.page.locator("[data-rsvp-by]").count()).toBe(0);
    expect(await p2.page.locator("body").innerText()).not.toContain(ru.replyBy.split("{date}")[0].trim());
    expect(await p2.page.locator('#rsvp [data-rsvp-closed="1"]').innerText()).toContain(ru.rsvpClosedPast);
    expect(await p2.page.locator("[data-cd-past]").innerText()).toBe(ru.eventPast);
    expect(await p2.page.locator("[data-cd]").count()).toBe(0);
    expect(await p2.page.locator("body").innerText()).not.toMatch(/00\s*:?\s*00/);
    expect(await p2.page.locator("[data-gb-empty]").count()).toBe(0);
    await p2.page.locator("[data-cd-past]").scrollIntoViewIfNeeded();
    await e.shot(p2.page, "guest-event-past-ru-390x844.png");
    const r = await rsvpApi(past.slug, { name: "После события" });
    expect(r.statusCode).toBe(410);
    expect(r.json().error).toBe("Приём ответов завершён");
    await e.expectClean(p2.page, p2.problems);
    await p2.close();
  });

  it("обратный отсчёт: подписи по числу («1 день»), на узбекском без изменений", async () => {
    const user = await e.signIn(await e.newContext());
    // Послезавтра в 00:00 по Ташкенту — до события от 24 до 48 часов в любое время суток («завтра в 23:59» в последнюю
    // минуту ташкентских суток давало меньше суток и «00»).
    const inv = await createInvitation(user.id, { data: { names: "Отсчёт тест", date: tashDay(2), time: "00:00", intro: "none" } });
    await publish(inv.id);
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport: M, waitText: "Отсчёт тест" });
    await page.locator('[data-cd="d"]').scrollIntoViewIfNeeded();
    expect(await page.locator('[data-cd="d"]').innerText()).toBe("01");
    expect(await page.locator('[data-cdl="d"]').innerText()).toBe(plural("ru", 1, ru.cdN.d).toUpperCase());
    // Каждая подпись согласована со своим числом (часы, минуты, секунды).
    await expect
      .poll(() => page.evaluate(() => ["h", "m", "s"].map((k) => [Number(document.querySelector(`[data-cd="${k}"]`)!.textContent), document.querySelector(`[data-cdl="${k}"]`)!.textContent])))
      .toSatisfy((list: [number, string][]) => list.every(([n, l], i) => l === plural("ru", n, ru.cdN[["h", "m", "s"][i]!])));
    await e.shot(page, "guest-countdown-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();
  });
});

describe("страница гостя: герои и мелочи", () => {
  const STYLES = ["wedding-classic", "party-brutal", "date-editorial", "date-cinema", "date-neon", "birthday-retro", "party-riso", "birthday-polaroid", "corporate-minimal", "wedding-luxe", "wedding-boho", "wedding-watercolor", "kids-pastel", "wedding-botanical"];

  it("длинные узбекские имена во всех героях на 390 px: слова целиком и в окне, без «Admit one», «REC», «№» и названия сайта", async () => {
    const user = await e.signIn(await e.newContext());
    const context = await e.newContext({ viewport: M, locale: "uz-UZ" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    for (const template of STYLES) {
      const inv = await createInvitation(user.id, { template, language: "uz", data: { names: "Muhammadamin & Gulnoraxon", host: "Abdullayevlar oilasi", venue: "Oqsaroy", date: "2026-12-20", time: "18:00", intro: "none" } });
      await publish(inv.id);
      await page.goto(`${e.base}/i/${inv.slug}`);
      // Заглавные буквы у части стилей — из CSS, поэтому ждём по textContent.
      await page.waitForFunction(() => !!document.querySelector("[data-hero] h1[data-fit]")?.textContent?.includes("Muhammadamin"), undefined, { timeout: 20_000 });
      await page.waitForTimeout(900);
      const fit = await heroNames(page);
      expect(fit.words.map((w) => w.w), template).toEqual(["Muhammadamin", "&", "Gulnoraxon"]);
      for (const w of fit.words) {
        expect(w.lines, `${template}: «${w.w}» разорвано`).toBe(1);
        expect(w.left, `${template}: «${w.w}» за левым краем`).toBeGreaterThanOrEqual(-1);
        expect(w.right, `${template}: «${w.w}» за правым краем`).toBeLessThanOrEqual(fit.W + 1);
      }
      expect(fit.hyphens, template).not.toBe("auto");
      expect(fit.hero, template).not.toMatch(/Admit one|\bREC\b|№|Invito|InviteBloom/i);
      await e.shot(page, `guest-hero-${template}-uz-390x844.png`);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  it("русская дата во всех героях без «г.»; мелкий акцентный текст читается (4.5:1) и на светлых шаблонах", async () => {
    const user = await e.signIn(await e.newContext());
    const context = await e.newContext({ viewport: M });
    const page = await context.newPage();
    for (const template of STYLES) {
      const inv = await createInvitation(user.id, { template, data: { names: "Тимур и Мадина", date: "2026-12-20", time: "18:00", intro: "none" } });
      await publish(inv.id);
      await page.goto(`${e.base}/i/${inv.slug}`);
      await page.waitForFunction(() => !!document.querySelector("[data-hero] h1[data-fit]")?.textContent?.includes("Тимур и Мадина"), undefined, { timeout: 20_000 });
      await page.waitForTimeout(600);
      const hero = await page.locator("[data-hero]").innerText();
      expect(hero, template).toMatch(/20/);
      expect(hero, template).not.toMatch(/\d{4}\s*г\.?(?![а-я])/i);
      // Подпись «Ответ» над формой — акцентным цветом, но читаемая: не меньше 4.5:1 к фону раздела.
      const [fg, bg] = await page.locator("#rsvp").evaluate((s) => [getComputedStyle(s.querySelector(":scope > div > div")!).color, getComputedStyle(s).backgroundColor]);
      expect(contrast(fg!, bg!), `${template}: ${fg} на ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    await context.close();
  });

  it("конверт личной ссылки: длинное имя гостя в одну строку и не под печатью", async () => {
    const owner = await e.newContext();
    const user = await e.signIn(owner);
    const inv = await createInvitation(user.id, { mode: "personal", language: "uz", data: { names: "Malika va Jasur", intro: "envelope", date: tashDay(20) } });
    await publish(inv.id, { paidSeats: 1 });
    const res = await e.app.inject({ method: "POST", url: `/api/invitations/${inv.id}/guests`, headers: { cookie: cookieOf(user.id), origin: e.base }, payload: { guests: [{ name: "Muhammadamin Abdurahmonov" }] } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const token = (res.json() as Dict[])[0]!.token as string;
    for (const viewport of [M, DESK]) {
      const { page, problems, close } = await e.open(`/g/${token}`, { viewport, waitText: "Malika va Jasur" });
      const to = page.locator("[data-env-to]");
      await to.waitFor();
      const g = await page.evaluate(() => {
        const box = document.querySelector("[data-env-to]")!.getBoundingClientRect();
        const name = document.querySelector('[data-env-to] [data-fit="line"]') as HTMLElement;
        const seal = document.querySelector("[data-seal]")!.getBoundingClientRect();
        return { top: box.top, sealBottom: seal.bottom, nameH: name.getBoundingClientRect().height, lineH: parseFloat(getComputedStyle(name).fontSize) * 1.6, fits: name.scrollWidth <= name.clientWidth + 1 };
      });
      expect(g.top, "имя под печатью").toBeGreaterThanOrEqual(g.sealBottom);
      expect(g.nameH).toBeLessThanOrEqual(g.lineH);
      expect(g.fits).toBe(true);
      await e.shot(page, `guest-envelope-uz-${viewport.width}.png`);
      await e.expectClean(page, problems);
      await close();
    }
  });

  it("программа на телефоне — компактный список; контакты кнопками; дресс-код без кодов цветов; номер карты копируется", async () => {
    const user = await e.signIn(await e.newContext());
    const program = ["Сбор гостей", "Никах", "Фотосессия", "Банкет", "Танцы", "Торт"].map((title, i) => ({ time: `${String(15 + i).padStart(2, "0")}:00`, title, place: "" }));
    const inv = await createInvitation(user.id, {
      data: {
        names: "Детали тест", date: tashDay(20), time: "18:00", intro: "none", program,
        contact: "Азиз +998 90 123 45 67, @gulnora_t\ninfo@example.uz",
        gifts: "Карта для тоёны: 8600 1234 5678 9012", dress: "Светлые тона", dressColors: ["#ffffff", "#e8dcc6", "#93723f"],
      },
    });
    await publish(inv.id);
    const context = await e.newContext({ viewport: M });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: e.base });
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { context, waitText: "Детали тест" });

    // Программа: строки «время — название», без закреплённого счётчика на несколько экранов.
    const prog = page.locator('section[data-prog="list"]');
    await prog.scrollIntoViewIfNeeded();
    expect(await prog.locator("[data-prog-row]").count()).toBe(6);
    expect(await page.locator("section[data-pin]").count()).toBe(0);
    expect((await prog.boundingBox())!.height).toBeLessThan(M.height * 1.4);
    await page.waitForTimeout(900);
    await e.shot(page, "guest-program-ru-390x844.png");

    // Контакты: телефон — «Позвонить» (и Telegram по номеру), @имя — «Написать в Telegram», почта — письмо.
    const card = page.locator('[data-info="contact"]');
    await card.scrollIntoViewIfNeeded();
    expect(await card.locator("[data-contact]").evaluateAll((els) => els.map((x) => x.getAttribute("data-contact")))).toEqual(["tel", "tg", "mail"]);
    const links = await card.locator("a[data-contact-link]").evaluateAll((els) => els.map((a) => [a.textContent!.trim(), a.getAttribute("href"), a.getAttribute("target")]));
    expect(links).toEqual([
      [ru.callBtn, "tel:+998901234567", "_self"],
      ["Telegram", "https://t.me/+998901234567", "_blank"],
      [ru.tgBtn, "https://t.me/gulnora_t", "_blank"],
      [ru.mailBtn, "mailto:info@example.uz", "_self"],
    ]);
    expect(await card.locator('[data-contact="tel"]').innerText()).toContain("Азиз");
    expect((await card.innerText()).toLowerCase()).toContain(ru.contact.toLowerCase());

    // Дресс-код: только кружки цветов, без «#ffffff».
    expect(await page.locator("[data-dress]").innerText()).not.toMatch(/#[0-9a-f]{3,6}/i);

    // Подарки: номер карты копируется цифрами.
    const gifts = page.locator('[data-info="gifts"]');
    await gifts.scrollIntoViewIfNeeded();
    await gifts.getByRole("button", { name: ru.copyCard }).click();
    await e.waitText(page, ru.cardCopied);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("8600123456789012");
    await e.shot(page, "guest-info-cards-ru-390x844.png");
    await e.expectClean(page, problems);
    await close();

    // На компьютере короткая программа остаётся закреплённой, длинная — тем же списком.
    const short = await createInvitation(user.id, { data: { names: "Коротко тест", date: tashDay(20), intro: "none", program: program.slice(0, 3) } });
    await publish(short.id);
    const d1 = await e.open(`/i/${short.slug}`, { viewport: DESK, waitText: "Коротко тест" });
    expect(await d1.page.locator('section[data-prog="pin"]').count()).toBe(1);
    await d1.close();
    const d2 = await e.open(`/i/${inv.slug}`, { viewport: DESK, waitText: "Детали тест" });
    expect(await d2.page.locator('section[data-prog="list"] [data-prog-row]').count()).toBe(6);
    await e.expectClean(d2.page, d2.problems);
    await d2.close();
  });

  it("кнопка языка: название языка, меню с выбором, понятный aria-label; частицы под текстом и не рисуются при «меньше движения»", async () => {
    const user = await e.signIn(await e.newContext());
    const inv = await createInvitation(user.id, { language: "uz", data: { names: "Til tugmasi", date: tashDay(20), intro: "none" } });
    await publish(inv.id);
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport: M, locale: "uz-UZ", waitText: "Til tugmasi" });
    const btn = page.locator("[data-lang-btn]");
    expect(await btn.innerText()).toContain(LANG_NAMES.uz);
    expect(await btn.getAttribute("aria-label")).toBe(uz.langAria.replace("{lang}", LANG_NAMES.uz));
    expect(await btn.getAttribute("aria-expanded")).toBe("false");
    await btn.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    expect(await btn.getAttribute("aria-expanded")).toBe("true");
    expect(await menu.getByRole("menuitemradio").allInnerTexts()).toEqual(["ru", "en", "uz", "uzc"].map((c) => expect.stringContaining((LANG_NAMES as Dict)[c])));
    expect(await menu.locator('[data-lang="uz"]').getAttribute("aria-checked")).toBe("true");
    await e.shot(page, "guest-lang-menu-uz-390x844.png");
    await menu.getByRole("menuitemradio", { name: LANG_NAMES.ru }).click();
    await expect.poll(() => page.locator("#rsvp h2").innerText()).toBe(ru.rsvp);
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await btn.getAttribute("aria-label")).toBe(ru.langAria.replace("{lang}", LANG_NAMES.ru));

    // Частицы — под текстом (z-index -1 внутри страницы), вспышка конфетти — отдельным слоем.
    const z = await page.locator("[data-particles]").evaluate((c) => getComputedStyle(c).zIndex);
    expect(z).toBe("-1");
    await e.expectClean(page, problems);
    await close();

    const reduced: BrowserContext = await e.newContext({ viewport: M });
    const p2 = await reduced.newPage();
    await p2.emulateMedia({ reducedMotion: "reduce" });
    await p2.goto(`${e.base}/i/${inv.slug}`);
    await e.waitText(p2, "Til tugmasi");
    await p2.waitForTimeout(800);
    expect(await p2.locator("[data-particles]").count()).toBe(0);
    await reduced.close();
  });

  it("стирающаяся карточка: через 4 секунды появляется «Открыть приглашение», и она открывает страницу", async () => {
    const user = await e.signIn(await e.newContext());
    const inv = await createInvitation(user.id, { data: { names: "Стереть тест", date: tashDay(20), intro: "scratch" } });
    await publish(inv.id);
    const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport: M, waitText: "Стереть тест" });
    const skip = page.getByRole("button", { name: ru.skipIntro });
    expect(await skip.count()).toBe(0);
    await skip.waitFor({ timeout: 8000 });
    await e.shot(page, "guest-scratch-skip-ru-390x844.png");
    await skip.click();
    await page.locator("[data-skip-intro]").waitFor({ state: "detached" });
    await page.locator("#rsvp").waitFor();
    expect(await page.locator("[data-hero] h1").innerText()).toBe("Стереть тест");
    await e.expectClean(page, problems);
    await close();
  });
});
