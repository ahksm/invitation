import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { createBot } from "../../src/bot/index.js";
import { createCache, type Cache } from "../../src/cache.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { users } from "../../src/db/schema.js";
import { seed } from "../../src/db/seed.js";
import { createPaymentProvider } from "../../src/payments/index.js";
import type { PaymentProvider } from "../../src/payments/types.js";
import { createMockSms } from "../../src/sms/mock.js";

/**
 * Общее окружение проверок в браузере (npm run test:e2e): приложение на свободном порту
 * (APP_URL совпадает с адресом, иначе защита от CSRF отклонит запросы страницы), тестовая база,
 * Redis, SMS в память и Chromium. Браузер: PLAYWRIGHT_CHROMIUM, /opt/pw-browsers/chromium или
 * установленный `npx playwright-core install chromium`. Скриншоты пишутся в E2E_SHOTS_DIR, если задана.
 */

/** Ключ бота для подписи initData: ненастоящий, Telegram не вызывается (TELEGRAM_MODE=off). */
export const BOT_TOKEN = "123456:e2e-fake-token";

// 1×1 прозрачный PNG вместо внешних картинок.
export const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/** Ошибка загрузки, которую Chromium пишет в консоль на ответ 401 от GET /api/auth/me без сессии. */
export const ME_401 = "Failed to load resource: the server responded with a status of 401 (Unauthorized)";

// PLAYWRIGHT_CHROMIUM, затем браузер этой машины; undefined — тот, что поставил `npx playwright-core install chromium`.
function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** initData мини-аппа с подписью, как её считает Telegram (ключ — HMAC от токена бота). */
export function signInitData(fields: Record<string, string>, token = BOT_TOKEN) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

type Dict = Record<string, any>;

/**
 * Мини-апп: Telegram.WebApp с initData, подписанной ключом бота. requestContact отвечает window.__contactOk,
 * нажатия кнопок и открытые ссылки записываются в window.__tg.
 */
export async function telegramStub(context: BrowserContext, user: Dict, opts: { authDate?: number; contactOk?: boolean; scanQr?: boolean } = {}) {
  const initData = signInitData({ auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)), query_id: "q1", user: JSON.stringify(user) });
  await context.addInitScript(
    ({ initData, user, contactOk, scanQr }) => {
      const tg: Dict = { contact: 0, links: [], scans: 0, scanFn: null, main: { text: "", visible: false, fn: null }, back: { visible: false, fn: null } };
      (window as any).__tg = tg;
      (window as any).__contactOk = contactOk;
      const WebApp: Dict = {
        initData,
        initDataUnsafe: { user },
        version: "8.0",
        platform: "ios",
        colorScheme: "light",
        themeParams: {},
        ready() {},
        expand() {},
        close() { tg.closed = true; },
        isVersionAtLeast() { return true; },
        requestContact(cb?: (ok: boolean) => void) { tg.contact++; setTimeout(() => cb && cb(!!(window as any).__contactOk), 50); },
        openLink(u: string) { tg.links.push(["link", u]); },
        openTelegramLink(u: string) { tg.links.push(["tg", u]); },
        MainButton: { setText(t: string) { tg.main.text = t; }, show() { tg.main.visible = true; }, hide() { tg.main.visible = false; }, onClick(fn: () => void) { tg.main.fn = fn; } },
        BackButton: { show() { tg.back.visible = true; }, hide() { tg.back.visible = false; }, onClick(fn: () => void) { tg.back.fn = fn; } },
      };
      if (scanQr) WebApp.showScanQrPopup = (_p: Dict, fn: (data: string) => boolean) => { tg.scans++; tg.scanFn = fn; };
      (window as any).Telegram = { WebApp };
    },
    { initData, user, contactOk: opts.contactOk ?? true, scanQr: !!opts.scanQr },
  );
}

/** Что мини-апп сделал с Telegram.WebApp из telegramStub: запросы контакта, ссылки, сканер, MainButton и BackButton. */
export const tgState = (page: Page) =>
  page.evaluate(() => {
    const tg = (window as any).__tg;
    return { contact: tg.contact as number, links: tg.links as string[][], scans: tg.scans as number, main: { text: tg.main.text as string, visible: !!tg.main.visible }, back: !!tg.back.visible };
  });

export type Problems = {
  /** Ошибки консоли, кроме ожидаемых 401 от /api/auth/me (они в me401). */
  console: string[];
  me401: number;
  page: string[];
  csp: string[];
  /** Запросы к своему серверу: путь с query. */
  requests: string[];
};

export type OpenOptions = {
  viewport?: { width: number; height: number };
  status?: number;
  /** Текст, появление которого значит, что страница отрисована. */
  waitText?: string;
  locale?: string;
  /** Уже готовый контекст (cookie, init-скрипты); иначе создаётся новый. */
  context?: BrowserContext;
};

export type E2EOptions = {
  /**
   * Платёжный провайдер вместо тестового (PAYMENT_PROVIDER=mock): например, настоящий код Multicard
   * с подменённой сетью (createMulticardProvider с fetch-заглушкой). base — адрес этого сервера.
   */
  payments?: (config: Config, cache: Cache, base: string) => PaymentProvider;
};

export async function startE2E(opts: E2EOptions = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mediaDir = mkdtempSync(join(tmpdir(), "invite-e2e-media-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_URL: base,
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://invite:invite@localhost:5432/invite_test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
    JWT_SECRET: "test-secret-test-secret-test-secret-123",
    PAYMENT_PROVIDER: "mock",
    SMS_PROVIDER: "mock",
    TELEGRAM_MODE: "off",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ANTHROPIC_API_KEY: "",
    MEDIA_DIR: mediaDir,
  });
  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL);
  const cache = createCache(redis);
  // Публичные страницы и шаблоны читают из базы.
  await runMigrations(db);
  await seed(db);
  // Счётчики лимита запросов от прошлых запусков.
  await redis.flushdb();
  const sms: { phone: string; text: string }[] = [];
  const app = await buildApp(
    { config, db, cache, payments: opts.payments ? opts.payments(config, cache, base) : createPaymentProvider(config, cache), sms: createMockSms({ info: () => {} }, sms) },
    { logger: false },
  );
  await app.listen({ port, host: "127.0.0.1" });
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath() });
  const shotsDir = process.env.E2E_SHOTS_DIR;

  const e = {
    config,
    db,
    redis,
    app,
    base,
    browser,
    sms,

    /** Контекст браузера: внешние ресурсы (Telegram, Google Fonts, Unsplash) — заглушки, CSP-нарушения собираются. */
    async newContext(opts: { viewport?: { width: number; height: number }; locale?: string; timezoneId?: string } = {}) {
      const context = await browser.newContext({ viewport: opts.viewport ?? { width: 390, height: 844 }, locale: opts.locale ?? "ru-RU", ...(opts.timezoneId && { timezoneId: opts.timezoneId }) });
      // Сеть наружу не нужна: CSP браузер проверяет до запроса, так что запрещённый адрес всё равно даст нарушение.
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
        document.addEventListener("securitypolicyviolation", (ev) => w.__csp.push(`${ev.violatedDirective} ${ev.blockedURI}`));
      });
      return context;
    },

    /** Открывает страницу и собирает ошибки консоли, исключения, нарушения CSP и запросы к серверу. */
    async open(path: string, opts: OpenOptions = {}) {
      const context = opts.context ?? (await e.newContext(opts));
      const problems: Problems = { console: [], me401: 0, page: [], csp: [], requests: [] };
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // Без сессии GET /api/auth/me отвечает 401, и Chromium пишет это в консоль: ожидаемо, считается отдельно.
        if (m.text() === ME_401 && m.location().url === base + "/api/auth/me") problems.me401++;
        else problems.console.push(m.text());
      });
      page.on("pageerror", (err) => problems.page.push(String(err)));
      page.on("request", (r) => r.url().startsWith(base) && problems.requests.push(r.url().slice(base.length)));
      const res = await page.goto(base + path);
      expect(res?.status()).toBe(opts.status ?? 200);
      if (opts.waitText) await e.waitText(page, opts.waitText);
      // Даём отработать таймерам и циклу анимации после первого кадра.
      await page.waitForTimeout(1200);
      return { page, context, problems, close: () => context.close() };
    },

    waitText(page: Page, text: string, timeout = 20_000) {
      // Во время перехода на новую страницу body ещё может не быть.
      return page.waitForFunction((t) => !!document.body && document.body.innerText.includes(t), text, { timeout });
    },

    async csp(page: Page) {
      return page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    },

    /** Нет ошибок в консоли (кроме ожидаемых 401 от /api/auth/me), исключений и нарушений CSP. */
    async expectClean(page: Page, p: Problems) {
      p.csp = await e.csp(page);
      expect(p.console, "ошибки в консоли").toEqual([]);
      expect(p.page, "исключения на странице").toEqual([]);
      expect(p.csp, "нарушения CSP").toEqual([]);
    },

    async shot(page: Page, name: string) {
      if (!shotsDir) return;
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, name) });
    },

    /** Последний код входа, отправленный на номер (998XXXXXXXXX). */
    lastCode(phone: string) {
      const m = [...sms].reverse().find((s) => s.phone === phone);
      return m ? /\b(\d{6})\b/.exec(m.text)?.[1] ?? null : null;
    },

    /** Пользователь в базе и cookie его сессии в контексте браузера. */
    async signIn(context: BrowserContext, values: Partial<typeof users.$inferInsert> = {}) {
      const [user] = await db
        .insert(users)
        .values({ phone: uniquePhone(), ...values })
        .returning();
      await context.addCookies([{ name: "session", value: app.jwt.sign({ sub: user!.id }), url: base }]);
      return user!;
    },

    async user(id: string) {
      const [u] = await db.select().from(users).where(eq(users.id, id));
      return u!;
    },

    async close() {
      await browser?.close();
      await app?.close();
      await Promise.allSettled([pool.end(), redis.quit()]);
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
  return e;
}

export type E2E = Awaited<ReturnType<typeof startE2E>>;

/**
 * Бот этого сервера в процессе, как botHarness в test/review-fixes.test.ts: бот не запускается, обновления
 * подаются через handleUpdate, а каждый запрос к Bot API перехватывается и сохраняется в calls — Telegram
 * не вызывается. message — текст или команда, contact — контакт (owner — чей номер, по умолчанию свой),
 * press — нажатие inline-кнопки.
 */
export function botHarness(e: E2E, username = "invito_e2e_bot") {
  const bot = createBot(e.app.ctx);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Invito",
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as typeof bot.botInfo;
  const calls: { method: string; payload: Dict }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Dict });
    return { ok: true, result: true } as never;
  });
  let id = 1;
  const date = Math.floor(Date.now() / 1000);
  const from = (tg: number) => ({ id: tg, is_bot: false, first_name: "Гость", language_code: "ru" });
  const chat = (tg: number) => ({ id: tg, type: "private" as const, first_name: "Гость" });
  const message = (tg: number, text: string) => {
    const command = text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {};
    return bot.handleUpdate({ update_id: id++, message: { message_id: id, date, chat: chat(tg), from: from(tg), text, ...command } } as never);
  };
  const contact = (tg: number, phone: string, owner = tg) =>
    bot.handleUpdate({
      update_id: id++,
      message: { message_id: id, date, chat: chat(tg), from: from(tg), contact: { phone_number: phone, first_name: "Гость", user_id: owner } },
    } as never);
  const press = (tg: number, data: string) =>
    bot.handleUpdate({
      update_id: id++,
      callback_query: { id: String(id), from: from(tg), chat_instance: "ci", data, message: { message_id: 1, date, chat: chat(tg), text: "…" } },
    } as never);
  const of = (method: string) => calls.filter((c) => c.method === method);
  const replies = () => of("sendMessage").map((c) => c.payload.text as string);
  const edits = () => of("editMessageText").map((c) => c.payload.text as string);
  return { bot, calls, message, contact, press, of, replies, edits };
}

let phoneSeq = 0;
/** Неповторяющийся номер 99890XXXXXXX: лимиты на номер и уникальность в базе не мешают тестам. */
export function uniquePhone() {
  phoneSeq++;
  return "99890" + String((Date.now() * 10 + phoneSeq) % 1e7).padStart(7, "0");
}
