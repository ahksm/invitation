import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { buildApp } from "../src/app.js";
import { createCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { seed } from "../src/db/seed.js";
import { createMulticardProvider, multicardSign } from "../src/payments/multicard.js";
import { createMockSms } from "../src/sms/mock.js";

export const APP_URL = "http://localhost:3000";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Окружение интеграционных тестов: тестовая база (схема пересоздаётся в start), Redis,
 * Multicard с подменённой сетью и SMS в память. Файлы пишутся во временный каталог.
 */
export function testContext() {
  const mediaDir = mkdtempSync(join(tmpdir(), "invite-media-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_URL,
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://invite:invite@localhost:5432/invite_test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
    JWT_SECRET: "test-secret-test-secret-test-secret-123",
    ADMIN_TELEGRAM_IDS: "1",
    PAYMENT_PROVIDER: "multicard",
    MULTICARD_APPLICATION_ID: "app",
    MULTICARD_SECRET: "mc-secret",
    MULTICARD_STORE_ID: "6",
    MULTICARD_MXIK: "10305008002000000",
    MULTICARD_PACKAGE_CODE: "1545643",
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_BOT_USERNAME: "invite_test_bot",
    SMS_CALLBACK_SECRET: "sms-cb-secret",
    MEDIA_DIR: mediaDir,
  });

  // Подменяем сеть: Multicard отвечает как в документации, а запросы сохраняются для проверки.
  const calls: { url: string; body: any }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/auth")) return Response.json({ token: "tok", role: "merchant", expiry: "2099-01-01 12:00:00" });
    if (url.endsWith("/payment/invoice")) {
      return Response.json({ success: true, data: { uuid: `uuid-${body.invoice_id}`, checkout_url: `https://checkout.test/${body.invoice_id}` } });
    }
    return new Response("not found", { status: 404 });
  };

  const { db, pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL);
  const cache = createCache(redis);
  const payments = createMulticardProvider({
    baseUrl: config.MULTICARD_BASE_URL,
    applicationId: "app",
    secret: "mc-secret",
    storeId: "6",
    mxik: config.MULTICARD_MXIK,
    packageCode: config.MULTICARD_PACKAGE_CODE,
    cache,
    fetch: fakeFetch,
  });
  const smsSent: { phone: string; text: string }[] = [];
  const sms = createMockSms({ info: () => {} }, smsSent);

  const t = {
    config,
    db,
    pool,
    redis,
    cache,
    calls,
    smsSent,
    mediaDir,
    app: undefined as unknown as Awaited<ReturnType<typeof buildApp>>,

    /** Пересоздаёт схему, применяет миграции и сид, собирает приложение. */
    async start() {
      await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
      await runMigrations(db);
      await seed(db);
      await redis.flushdb();
      t.app = await buildApp({ config, db, cache, payments, sms }, { logger: false });
    },

    async close() {
      await t.app?.close();
      await pool.end();
      await redis.quit();
      rmSync(mediaDir, { recursive: true, force: true });
    },

    /** Пользователь с телефоном и cookie сессии. Telegram ID 1 — админ. */
    async login(telegramId: number, extra: Partial<typeof users.$inferInsert> = {}) {
      const [u] = await db
        .insert(users)
        .values({ telegramId, phone: phoneOf(telegramId), isAdmin: telegramId === 1, ...extra })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: { phone: phoneOf(telegramId), ...(extra.freeAccess !== undefined && { freeAccess: extra.freeAccess }) },
        })
        .returning();
      const token = t.app.jwt.sign({ sub: u!.id });
      return { user: u!, cookie: `session=${token}` };
    },

    req(cookie: string | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
      return t.app.inject({
        method,
        url,
        payload: payload as any,
        headers: { ...(cookie && { cookie }), origin: APP_URL, ...headers },
      });
    },

    /** Колбэк Multicard об оплате заказа. */
    callback(orderNumber: number, amount: number, secret = "mc-secret") {
      return t.app.inject({
        method: "POST",
        url: "/api/payments/multicard/callback",
        payload: {
          store_id: 6,
          invoice_id: String(orderNumber),
          amount,
          uuid: `uuid-${orderNumber}`,
          sign: multicardSign(6, String(orderNumber), amount, secret),
        },
      });
    },

    /** Заказ и его оплата. Бесплатный заказ (доступ, подписка) выполняется сразу. */
    async pay(cookie: string, order: Record<string, unknown>) {
      const res = (await t.req(cookie, "POST", "/api/orders", order)).json();
      if (res.status === "pending") await t.callback(res.order.number, res.order.amount);
      return res;
    },
  };
  return t;
}

export type TestContext = ReturnType<typeof testContext>;

export const phoneOf = (telegramId: number) => `99890${String(telegramId).padStart(7, "0")}`;

export const sessionCookie = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "session");
  return c ? `session=${c.value}` : null;
};

/** Минимальные файлы с настоящими сигнатурами. */
export const samples = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 2)]),
  gif: Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(58, 3)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(48, 4)]),
  mp3: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61, 5)]),
  m4a: Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(52, 6)]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(52, 7)]),
  mov: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(52, 8)]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(48, 9)]),
  ogg: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 10)]),
  wav: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(48, 11)]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  html: Buffer.from("<!doctype html><html><body>hi</body></html>"),
};

/** multipart/form-data с одним файлом. */
export function multipart(field: string, filename: string, mime: string, content: Buffer) {
  const boundary = `----invite${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
