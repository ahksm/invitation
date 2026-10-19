import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Redis } from "ioredis";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createCache } from "../../src/cache.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/index.js";
import { createPaymentProvider } from "../../src/payments/index.js";
import { createSmsProvider } from "../../src/sms/index.js";
import { I18N } from "../../web/invito-data.js";

/**
 * Дымовая проверка фронтенда в настоящем Chromium: оболочка, пропатченный рантайм и логика
 * Invito запускаются без ошибок в консоли и без нарушений CSP (то есть без eval и CDN).
 * Запуск: npm run test:e2e. Браузер: PLAYWRIGHT_CHROMIUM, /opt/pw-browsers/chromium или
 * установленный `npx playwright-core install chromium`. Скриншоты пишутся в E2E_SHOTS_DIR, если задана.
 */

const config = loadConfig({
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://invite:invite@localhost:5432/invite_test",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
  JWT_SECRET: "test-secret-test-secret-test-secret-123",
  PAYMENT_PROVIDER: "mock",
  SMS_PROVIDER: "mock",
  TELEGRAM_MODE: "off",
});

const { db, pool } = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);
const cache = createCache(redis);
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let browser: Browser;

const HERO = I18N.ru.hero1 as string;
const shotsDir = process.env.E2E_SHOTS_DIR;

// PLAYWRIGHT_CHROMIUM, затем браузер этой машины; undefined — тот, что поставил `npx playwright-core install chromium`.
function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

// 1×1 прозрачный PNG вместо внешних картинок.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

type Problems = { console: string[]; page: string[]; csp: string[]; requests: string[] };

/**
 * Открывает страницу и собирает ошибки. Внешние ресурсы (Telegram, Google Fonts, Unsplash)
 * подменяются заглушками, чтобы проверка не зависела от сети; CSP при этом проверяется браузером
 * до запроса, так что запрещённый адрес всё равно даст нарушение.
 */
async function open(path: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  const problems: Problems = { console: [], page: [], csp: [], requests: [] };
  await context.route(
    (url) => url.origin !== base,
    (route) => {
      const type = route.request().resourceType();
      if (type === "script") return route.fulfill({ contentType: "text/javascript", body: "/* заглушка */" });
      if (type === "stylesheet") return route.fulfill({ contentType: "text/css", body: "" });
      if (type === "image") return route.fulfill({ contentType: "image/png", body: PIXEL, headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ status: 204 });
    },
  );
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.console.push(m.text()));
  page.on("pageerror", (e) => problems.page.push(String(e)));
  page.on("request", (r) => r.url().startsWith(base) && problems.requests.push(r.url().slice(base.length)));
  const res = await page.goto(base + path);
  expect(res?.status()).toBe(200);
  // Главная Invito: заголовок героя из словаря ru.
  await page.waitForFunction((text) => document.body.innerText.includes(text), HERO, { timeout: 20_000 });
  // Даём отработать таймерам и циклу анимации после первого кадра.
  await page.waitForTimeout(1500);
  problems.csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  return { page, problems, close: () => context.close() };
}

function expectClean(p: Problems, path: string) {
  expect(p.console, "ошибки в консоли").toEqual([]);
  expect(p.page, "исключения на странице").toEqual([]);
  expect(p.csp, "нарушения CSP").toEqual([]);
  // Страница загружается один раз: рантайм не перечитывает её через fetch(location.href).
  expect(p.requests.filter((u) => u === path)).toHaveLength(1);
  // Вложенные DC берутся из бандла, а не из *.dc.html.
  expect(p.requests.filter((u) => u.includes(".dc.html"))).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, name) });
}

beforeAll(async () => {
  // Счётчики лимита запросов от прошлых тестов.
  await redis.flushdb();
  app = await buildApp(
    { config, db, cache, payments: createPaymentProvider(config, cache), sms: createSmsProvider(config, cache, { info: () => {} }) },
    { logger: false },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
});

describe("фронтенд в браузере", () => {
  it("/app/ показывает главную Invito без ошибок и нарушений CSP", async () => {
    const { page, problems, close } = await open("/app/", { width: 390, height: 844 });
    expectClean(problems, "/app/");
    // React из /app/vendor, логика из бандла, шаблон InviteCover отрисован без заглушки.
    expect(await page.evaluate(() => (window as unknown as { React: { version: string } }).React.version)).toBe("18.3.1");
    expect(await page.locator('[data-sc-name="InviteCover"]').count()).toBeGreaterThan(0);
    expect(await page.locator(".sc-placeholder, .sc-logic-error").count()).toBe(0);
    // Шаблон скомпилирован из сырого текста: camelCase-атрибут и <sc-for> внутри <select> на месте
    // (разбор через DOM дал бы onloadeddata и выбросил бы <sc-for>).
    const compiled = await page.evaluate(() => (window as unknown as { __dcAnnotatedTemplate: (n: string) => string }).__dcAnnotatedTemplate("Invito"));
    expect(compiled).toContain("sc-camel-on-loaded-data=");
    expect(compiled).toMatch(/<sc-raw-select[^>]*>\s*<sc-for/);
    expect(problems.requests.some((u) => u.startsWith("/app/invito-data.js"))).toBe(true);
    await shot(page, "app-390x844.png");
    // Переход в конструктор: выбор события рисуется без новых ошибок.
    await page.getByRole("button", { name: I18N.ru.create }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), I18N.ru.chooseEvent as string);
    await page.waitForTimeout(500);
    problems.csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expectClean(problems, "/app/");
    await shot(page, "app-events-390x844.png");
    // Проверка самой проверки: адрес, запрещённый CSP, попадает в список нарушений.
    await page.evaluate(() => void (new Image().src = "https://example.com/csp-probe.png"));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(["img-src https://example.com/csp-probe.png"]);
    await close();
  });

  it("/app/ на широком экране", async () => {
    const { page, problems, close } = await open("/app/", { width: 1280, height: 800 });
    expectClean(problems, "/app/");
    await shot(page, "app-1280x800.png");
    await close();
  });

  it("/i/:slug и /g/:token запускают рантайм с загрузочными данными", async () => {
    for (const [path, boot] of [
      ["/i/test-slug", { mode: "shared", slug: "test-slug" }],
      ["/g/test-token", { mode: "personal", token: "test-token" }],
    ] as const) {
      const { page, problems, close } = await open(path, { width: 390, height: 844 });
      expectClean(problems, path);
      expect(await page.evaluate(() => JSON.parse(document.getElementById("invito-boot")!.textContent!))).toEqual(boot);
      await close();
    }
  });
});
