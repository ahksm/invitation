import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, templates, users } from "../../src/db/schema.js";
import { I18N, INVITO } from "../../web/invito-data.js";
import { PIXEL, startE2E, uniquePhone, type E2E } from "./helpers.js";

/**
 * Музыка на странице гостя включена по умолчанию: стартует от первого касания гостя (конверт, текст,
 * кнопка), потому что без касания браузер звук не разрешает. Chromium запущен с обычным правилом
 * настольного Chrome (звук только после действия человека на странице).
 *
 * Вызовы Playwright evaluate, waitForFunction и locator сами дают странице право на звук (userGesture),
 * поэтому в сценариях гостя состояние читается через CDP Runtime.evaluate без него, а касания — сырой
 * ввод Input.dispatchTouchEvent в контексте телефона. Звук виден по числу запущенных нот
 * (AudioScheduledSourceNode.start) и по элементам <audio> своей песни, а не только по кнопке.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const D = INVITO as Dict;

let e: E2E;
beforeAll(async () => {
  e = await startE2E({ browserArgs: ["--autoplay-policy=document-user-activation-required"] });
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

/** Своя песня владельца: 3 с тона 440 Гц, WAV прямо в каталоге загрузок. */
function uploadedWav() {
  const id = randomUUID();
  const rate = 8000, n = rate * 3, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  writeFileSync(join(e.config.MEDIA_DIR, `${id}.wav`), buf);
  return `/media/${id}.wav`;
}

/** Счётчики звука страницы: AudioContext, запущенные ноты, вызовы resume и элементы <audio>, которые play(). */
function recordAudio() {
  const w = window as any;
  w.__acs = [];
  w.__notes = 0;
  w.__resumes = 0;
  w.__els = [];
  const AC = w.AudioContext;
  w.AudioContext = class extends AC {
    constructor(...a: any[]) {
      super(...a);
      w.__acs.push(this);
    }
  };
  const start = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...a: any[]) {
    w.__notes++;
    return start.apply(this, a as []);
  };
  const resume = AC.prototype.resume;
  AC.prototype.resume = function () {
    w.__resumes++;
    return resume.call(this);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!w.__els.includes(this)) w.__els.push(this);
    return play.call(this);
  };
}

/** Телефон: касания, внешние адреса заглушены, звук записывается. */
async function phone(init?: () => void): Promise<BrowserContext> {
  const context = await e.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: "ru-RU" });
  await context.route(
    (url) => url.origin !== e.base,
    (route) => {
      const type = route.request().resourceType();
      if (type === "script") return route.fulfill({ contentType: "text/javascript", body: "/* заглушка */" });
      if (type === "stylesheet") return route.fulfill({ contentType: "text/css", body: "" });
      if (type === "image") return route.fulfill({ contentType: "image/png", body: PIXEL, headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ status: 204 });
    },
  );
  await context.addInitScript(recordAudio);
  if (init) await context.addInitScript(init);
  return context;
}

type Guest = { page: Page; cdp: CDPSession; read: (expr: string) => Promise<any>; errors: string[]; close: () => Promise<void> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Страница гостя без единого вызова Playwright, который дал бы ей право на звук. */
async function openGuest(path: string, text: string, init?: () => void): Promise<Guest> {
  const context = await phone(init);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (x) => errors.push(String(x)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(e.base + path);
  const cdp = await context.newCDPSession(page);
  const read = async (expr: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let t0 = Date.now(); !(await read(`!!document.body && document.body.innerText.includes(${JSON.stringify(text)})`)); await sleep(200)) {
    if (Date.now() - t0 > 20_000) throw new Error("нет текста на странице: " + text);
  }
  await sleep(1200);
  return { page, cdp, read, errors, close: () => context.close() };
}

const pressed = (g: Guest) => g.read(`document.querySelector('[data-music]')?.getAttribute('aria-pressed') ?? 'нет кнопки'`);
const notes = (g: Guest): Promise<number> => g.read("window.__notes");
const contexts = (g: Guest): Promise<number> => g.read("window.__acs.length");
/** Звук идёт: за 900 мс запущены новые ноты. */
async function playing(g: Guest) {
  const before = await notes(g);
  await sleep(900);
  return (await notes(g)) > before;
}
async function tap(g: Guest, x: number, y: number) {
  await g.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await g.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(300);
}
/** Касание по середине элемента; прокрутка к нему — без права на звук. */
async function tapOn(g: Guest, selector: string) {
  const r = await g.read(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await sleep(300);
  await tap(g, r.x, r.y);
}
/** Касание кнопки по тексту (первой подходящей). */
async function tapButton(g: Guest, scope: string, label: string) {
  const r = await g.read(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await sleep(300);
  await tap(g, r.x, r.y);
}
/** Палец прокручивает страницу снизу вверх. */
async function swipe(g: Guest) {
  await g.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 700 }] });
  for (let y = 660; y >= 220; y -= 40) await g.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y }] });
  await g.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(600);
}
/** Вкладку свернули или вернули; isActive — было ли у страницы право на звук в этот момент. */
const visibility = (g: Guest, state: "hidden" | "visible") =>
  g.read(`(() => { Object.defineProperty(document, 'visibilityState', { value: '${state}', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); return navigator.userActivation.isActive; })()`);

async function expectClean(g: Guest) {
  expect(g.errors, "ошибки на странице").toEqual([]);
}

describe("музыка на странице гостя", () => {
  it("конверт: до касания тишина, касание включает, гость выключает, и касания её больше не включают", async () => {
    const slug = await published({ names: "Азиз и Мадина", date: "2026-12-12" });
    const g = await openGuest(`/i/${slug}`, "Азиз и Мадина");
    expect(await g.read("navigator.userActivation.hasBeenActive")).toBe(false);
    expect(await pressed(g)).toBe("false");
    expect(await contexts(g)).toBe(0);
    // Касание конверта открывает приглашение и включает музыку.
    await tap(g, 195, 420);
    expect(await pressed(g)).toBe("true");
    expect(await playing(g)).toBe(true);
    await sleep(2500);
    // Гость выключил музыку кнопкой: дальше касания её не включают, кнопка включает снова.
    await tapOn(g, "[data-music]");
    expect(await pressed(g)).toBe("false");
    expect(await playing(g)).toBe(false);
    await tapButton(g, "#rsvp", ru.yes);
    expect(await pressed(g)).toBe("false");
    expect(await playing(g)).toBe(false);
    await tapOn(g, "[data-music]");
    expect(await pressed(g)).toBe("true");
    expect(await playing(g)).toBe(true);
    await expectClean(g);
    await g.close();
  });

  it("без заставки: прокрутка пальцем не включает, касание текста включает; первое касание кнопки музыки — тоже", async () => {
    const slug = await published({ names: "Лола и Тимур", intro: "none" });
    const a = await openGuest(`/i/${slug}`, "Лола и Тимур");
    // Прокрутка не даёт права на звук: музыка ждёт касания.
    await swipe(a);
    expect(await pressed(a)).toBe("false");
    expect(await contexts(a)).toBe(0);
    await tap(a, 195, 300);
    expect(await pressed(a)).toBe("true");
    expect(await playing(a)).toBe(true);
    await expectClean(a);
    await a.close();

    // Первое касание — сама кнопка музыки: музыка включается, а не включается и сразу выключается.
    const b = await openGuest(`/i/${slug}`, "Лола и Тимур");
    await tapOn(b, "[data-music]");
    expect(await pressed(b)).toBe("true");
    expect(await playing(b)).toBe(true);
    await expectClean(b);
    await b.close();
  });

  it("ввод имени в ответе музыку не включает, касание кнопки ответа включает", async () => {
    const slug = await published({ names: "Нодира и Фарход", intro: "none" });
    const g = await openGuest(`/i/${slug}`, "Нодира и Фарход");
    await tapOn(g, `#rsvp input[placeholder="${ru.yourName}"]`);
    await g.page.keyboard.type("Гость");
    await sleep(300);
    expect(await pressed(g)).toBe("false");
    expect(await contexts(g)).toBe(0);
    await tapButton(g, "#rsvp", ru.yes);
    expect(await pressed(g)).toBe("true");
    expect(await playing(g)).toBe(true);
    await expectClean(g);
    await g.close();
  });

  it("вкладку свернули: тишина; вернули без касания — музыка продолжается", async () => {
    const slug = await published({ names: "Нигора и Бахром", intro: "none" });
    const g = await openGuest(`/i/${slug}`, "Нигора и Бахром");
    await tap(g, 195, 300);
    expect(await playing(g)).toBe(true);
    await visibility(g, "hidden");
    await sleep(300);
    expect(await playing(g)).toBe(false);
    // Право на звук от касания уже истекло: возвращение его не даёт, а музыка всё равно идёт дальше.
    await sleep(5000);
    expect(await visibility(g, "visible")).toBe(false);
    expect(await pressed(g)).toBe("true");
    expect(await playing(g)).toBe(true);
    await expectClean(g);
    await g.close();
  });

  it("своя песня: после смены вкладки продолжается с того же места; файла нет — кнопка «выключено», касание пробует снова", async () => {
    const slug = await published({ names: "Своя песня", intro: "none", music: "custom", musicSrc: uploadedWav() });
    const g = await openGuest(`/i/${slug}`, "Своя песня");
    await tap(g, 195, 300);
    await sleep(1200);
    expect(await pressed(g)).toBe("true");
    const at = await g.read("window.__els[0].currentTime");
    expect(await g.read("window.__els[0].paused")).toBe(false);
    expect(at).toBeGreaterThan(0.5);
    await visibility(g, "hidden");
    await sleep(500);
    expect(await g.read("window.__els[0].paused")).toBe(true);
    await visibility(g, "visible");
    await sleep(500);
    // Тот же элемент и та же секунда, а не новый трек с начала.
    expect(await g.read("window.__els.length")).toBe(1);
    expect(await g.read("window.__els[0].paused")).toBe(false);
    expect(await g.read("window.__els[0].currentTime")).toBeGreaterThanOrEqual(at);
    await expectClean(g);
    await g.close();

    const missing = await published({ names: "Нет файла", intro: "none", music: "custom", musicSrc: `/media/${randomUUID()}.mp3` });
    const m = await openGuest(`/i/${missing}`, "Нет файла");
    await tap(m, 195, 300);
    await expect.poll(() => pressed(m), { timeout: 5000 }).toBe("false");
    await tap(m, 195, 300);
    expect(await m.read("window.__els.length")).toBe(2);
    await expect.poll(() => pressed(m), { timeout: 5000 }).toBe("false");
    // Ошибки 404 файла песни в консоли ожидаемы.
    expect(m.errors.filter((x) => !/404/.test(x))).toEqual([]);
    await m.close();
  });

  it("браузер не дал включить звук (resume не завершается): кнопка возвращается в «выключено», следующее касание пробует снова", async () => {
    const slug = await published({ names: "Заблокировано", intro: "none" });
    const g = await openGuest(`/i/${slug}`, "Заблокировано", () => {
      Object.defineProperty(BaseAudioContext.prototype, "state", { get: () => "suspended", configurable: true });
      AudioContext.prototype.resume = function () {
        (window as any).__resumes++;
        return new Promise(() => {});
      };
    });
    await tap(g, 195, 300);
    await expect.poll(() => pressed(g), { timeout: 3000 }).toBe("false");
    const tries = await g.read("window.__resumes");
    expect(tries).toBeGreaterThanOrEqual(1);
    await tap(g, 195, 300);
    await expect.poll(() => g.read("window.__resumes")).toBeGreaterThan(tries);
    await expect.poll(() => pressed(g), { timeout: 3000 }).toBe("false");
    await expectClean(g);
    await g.close();
  });

  it("за паролем касания не включают звук; после пароля касание конверта включает", async () => {
    const slug = await published({ names: "Секретный ужин" }, { accessCode: "tulip-26" });
    const g = await openGuest(`/i/${slug}`, ru.unlock);
    // Касание текста страницы с паролем, а не поля.
    await tap(g, 195, 120);
    await tapOn(g, "input[type=password]");
    await g.page.keyboard.type("tulip-26");
    expect(await contexts(g)).toBe(0);
    expect(await notes(g)).toBe(0);
    await tapButton(g, "", ru.unlock);
    for (let t0 = Date.now(); !(await g.read(`document.body.innerText.includes("Секретный ужин")`)); await sleep(200)) {
      if (Date.now() - t0 > 20_000) throw new Error("пароль не открыл страницу");
    }
    await sleep(1200);
    expect(await pressed(g)).toBe("false");
    await tap(g, 195, 420);
    expect(await pressed(g)).toBe("true");
    expect(await playing(g)).toBe(true);
    await expectClean(g);
    await g.close();
  });
});

describe("музыка у владельца", () => {
  async function owner() {
    const context = await e.newContext();
    await context.addInitScript(recordAudio);
    const user = await e.signIn(context);
    const res = await e.app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie: `session=${e.app.jwt.sign({ sub: user.id })}`, origin: e.base },
      payload: { template: "wedding-classic", mode: "shared", language: "ru", data: { names: "Черновик владельца" } },
    });
    expect(res.statusCode).toBeLessThan(300);
    return context;
  }

  it("редактор: касания не включают музыку; включённая кнопкой продолжается после смены вкладки", async () => {
    const { page, problems, close } = await e.open("/app/", { context: await owner(), waitText: "Черновик владельца" });
    await page.locator("#my-inv").getByRole("button", { name: ru.edit }).first().click();
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: ru.toEditor + " →" }).click();
    await page.locator("[data-music]").waitFor();
    // Касание в редакторе открыло бы лист правки: клавиша — тоже действие человека.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    expect(await page.locator("[data-music]").getAttribute("aria-pressed")).toBe("false");
    expect(await page.evaluate(() => (window as any).__notes)).toBe(0);
    await page.locator("[data-music]").click();
    expect(await page.locator("[data-music]").getAttribute("aria-pressed")).toBe("true");
    const vis = (v: string) => page.evaluate((s) => { Object.defineProperty(document, "visibilityState", { value: s, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, v);
    await vis("hidden");
    await vis("visible");
    await page.waitForTimeout(300);
    const n = await page.evaluate(() => (window as any).__notes);
    await page.waitForTimeout(900);
    expect(await page.locator("[data-music]").getAttribute("aria-pressed")).toBe("true");
    expect(await page.evaluate(() => (window as any).__notes)).toBeGreaterThan(n);
    await e.expectClean(page, problems);
    await close();
  });

  it("превью шаблона: музыка не уходит в конструктор и не включается под листом входа", async () => {
    // Вошедший владелец: «Использовать шаблон», пока черновик создаётся, гость-владелец касается страницы.
    const context = await owner();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await context.route(`${e.base}/api/invitations`, async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Черновик владельца" });
    await page.getByRole("button", { name: ru.create }).first().click();
    await e.waitText(page, ru.chooseEvent);
    await page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label.ru }).first().click();
    await page.getByRole("button", { name: ru.preview, exact: true }).first().click();
    await page.locator("[data-music]").waitFor();
    await page.mouse.click(195, 420);
    expect(await page.locator("[data-music]").getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: ru.useTpl + " →" }).last().click();
    await page.mouse.click(195, 300);
    release();
    await e.waitText(page, ru.steps.basics);
    await page.waitForTimeout(600);
    const n = await page.evaluate(() => (window as any).__notes);
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => (window as any).__notes)).toBe(n);
    await e.expectClean(page, problems);
    await close();

    // Без входа: «Использовать шаблон» открывает лист входа; касания в нём музыку не включают.
    const anon = await e.newContext();
    await anon.addInitScript(recordAudio);
    const p2 = await e.open("/app/", { context: anon, waitText: ru.create });
    await p2.page.getByRole("button", { name: ru.create }).first().click();
    await e.waitText(p2.page, ru.chooseEvent);
    await p2.page.locator("[data-rv]").filter({ hasText: D.EVENTS.wedding.label.ru }).first().click();
    await p2.page.getByRole("button", { name: ru.preview, exact: true }).first().click();
    await p2.page.locator("[data-music]").waitFor();
    await p2.page.mouse.click(195, 420);
    await p2.page.waitForTimeout(2800);
    await p2.page.getByRole("button", { name: ru.useTpl + " →" }).last().click();
    await p2.page.locator('[data-sheet="login"]').waitFor();
    await p2.page.waitForTimeout(600);
    const before = await p2.page.evaluate(() => (window as any).__notes);
    await p2.page.locator('[data-sheet="login"]').click({ position: { x: 40, y: 20 } });
    await p2.page.waitForTimeout(900);
    expect(await p2.page.evaluate(() => (window as any).__notes)).toBe(before);
    expect(p2.problems.page).toEqual([]);
    await p2.close();
  });
});
