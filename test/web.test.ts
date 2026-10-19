import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { createDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { guests, invitations, templates, users, type Invitation } from "../src/db/schema.js";
import { seed } from "../src/db/seed.js";
import { createPaymentProvider } from "../src/payments/index.js";
import { longDate } from "../src/services/public.js";
import { createSmsProvider } from "../src/sms/index.js";
import { assetUrl, buildDesign, createDesignStore, parseDcFile, webDir } from "../src/web/design.js";
import { pickEncoding, publicShell, renderShell, webRoutes, type PublicPage, type PublicPageRequest } from "../src/web/pages.js";
import { applyPatches, supportPatches } from "../src/web/support-patches.js";

const config = loadConfig({
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
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

const design = buildDesign();
const text = (path: string) => design.assets.get(path)!.body.toString("utf8");
const bootOf = (html: string) => JSON.parse(/<script type="application\/json" id="invito-boot">(.*?)<\/script>/.exec(html)![1]!);
/** content мета-тега по property или name (как есть, с HTML-сущностями); undefined, если тега нет. */
const metaOf = (html: string, prop: string) =>
  [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].find((m) => m[1] === prop)?.[2];

beforeAll(async () => {
  // Публичные страницы читают приглашения из базы: схема с нуля, как в api.test.ts.
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  await seed(db);
  // Счётчики лимита запросов от прошлых тестов.
  await redis.flushdb();
  app = await buildApp(
    { config, db, cache, payments: createPaymentProvider(config, cache), sms: createSmsProvider(config, cache, { info: () => {} }) },
    { logger: false },
  );
});

afterAll(async () => {
  await app?.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
});

describe("сборка дизайна", () => {
  it("support.js: логика без eval, без CDN, без повторной загрузки и postMessage", () => {
    const js = text("/app/support.js");
    expect(js).not.toMatch(/new Function\(\s*"DCLogic"/);
    expect(js).not.toContain("fetch(location.href)");
    expect(js).not.toContain("fetch(target)");
    expect(js).not.toContain(".postMessage(");
    expect(js).not.toContain('addEventListener("message"');
    expect(js).not.toContain("loadScript(react.src");
    expect(js).toContain("window.__dcLogic");
    // Бандл не загрузился или упал: причина пустой страницы видна в консоли.
    expect(js).toContain('console.error("[invito] /app/dc-bundle.js did not load or failed');
    // Исходник рантайма не меняется: патчи накладываются при сборке.
    expect(readFileSync(join(webDir, "support.js"), "utf8")).toContain("const fn = new Function(");
  });

  it("патч без своего фрагмента останавливает сборку", () => {
    expect(() => applyPatches("нет такого кода", supportPatches)).toThrow(/не найден/);
    expect(() => applyPatches("a a", [{ why: "тест", find: "a", replace: "b" }])).toThrow(/больше одного раза/);
    // Символы $ в замене вставляются как есть.
    expect(applyPatches("x", [{ why: "тест", find: "x", replace: "$&$1" }])).toBe("$&$1");
  });

  it("dc-bundle.js: сырые шаблоны, пропсы и логика как функции", () => {
    const window: Record<string, any> = {};
    runInNewContext(text("/app/dc-bundle.js"), { window });
    expect(window.__dcRoot).toBe("Invito");
    const invito = window.__dcSources.Invito;
    // Сырой текст: camelCase-атрибуты и <sc-for> внутри <select> не испорчены разбором DOM.
    expect(invito.template).toContain("onLoadedData=");
    expect(invito.template).toMatch(/<select[^>]*>\s*<sc-for/);
    expect(invito.template).not.toContain("telegram-web-app.js");
    expect(invito.props.platform.default).toBe("web");
    expect(invito.preview).toBeUndefined();
    const cover = window.__dcSources.InviteCover;
    expect(cover.preview).toEqual({ width: 300, height: 400 });
    expect(cover.props.names.default).toBe("Anna & Timur");
    expect(cover.props.$preview).toBeUndefined();

    class Base {}
    for (const name of ["Invito", "InviteCover"]) {
      const Component = window.__dcLogic[name](Base, Base, {});
      expect(Component.prototype).toBeInstanceOf(Base);
    }
  });

  it("модули, шрифты и предзагрузка", () => {
    for (const p of ["/app/invito-data.js", "/app/invito-engine.js", "/app/invito-api.js", "/app/vendor/qrcode.js"]) expect(design.assets.has(p)).toBe(true);
    expect(text("/app/vendor/react.production.min.js")).toContain("18.3.1");
    expect(text("/app/vendor/qrcode.js")).toContain("var qrcode = function");
    expect(design.preload).toEqual(["/app/invito-data.js", "/app/invito-engine.js", "/app/invito-api.js"]);
    expect(design.fontsHref).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond.*&family=Onest/);
  });

  it("невыполненные правки дизайна и чужой рантайм останавливают сборку; в development она обновляется", () => {
    const dir = mkdtempSync(join(tmpdir(), "invito-web-"));
    try {
      cpSync(webDir, dir, { recursive: true });
      const file = join(dir, "Invito.dc.html");
      const orig = readFileSync(file, "utf8");
      writeFileSync(file, orig.replace("</helmet>", '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n</helmet>'));
      expect(() => buildDesign(dir)).toThrow(/telegram-web-app/);
      writeFileSync(file, orig.replace("import('/app/invito-data.js')", "import(new URL('./invito-data.js', document.baseURI).href)"));
      expect(() => buildDesign(dir)).toThrow(/абсолютному пути/);
      writeFileSync(file, orig);

      const api = join(dir, "invito-api.js");
      const watched = createDesignStore({ watch: true, dir });
      const fixed = createDesignStore({ watch: false, dir });
      const before = watched.get().assets.get("/app/invito-api.js")!.hash;
      writeFileSync(api, "export const changed = true;\n");
      const later = new Date(Date.now() + 60_000);
      utimesSync(api, later, later);
      expect(watched.get().assets.get("/app/invito-api.js")!.hash).not.toBe(before);
      expect(fixed.get().assets.get("/app/invito-api.js")!.hash).toBe(before);

      writeFileSync(join(dir, "support.js"), "// другой рантайм\n");
      expect(() => buildDesign(dir)).toThrow(/патч .* не применился/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseDcFile разбирает файл как parseDcText", () => {
    const src = [
      "<x-dc data-a='1'><b>{{ x }}</b></x-dc>",
      "<!-- <script data-dc-script>не этот</script> -->",
      "<script>const s = '<script data-dc-script>';</script>",
      `<script type="text/x-dc" data-dc-script data-props="{&quot;$preview&quot;:{&quot;width&quot;:1},&quot;a&quot;:{&quot;default&quot;:&quot;&lt;&#39;&#x41;&quot;}}">class Component {}</script>`,
    ].join("\n");
    expect(parseDcFile("t", src)).toEqual({
      template: "<b>{{ x }}</b>",
      props: { a: { default: "<'A" } },
      preview: { width: 1 },
      logic: "class Component {}",
      logicLine: 4,
    });
    expect(parseDcFile("t", "<x-dc></x-dc>")).toEqual({ template: "", props: null, preview: null, logic: null, logicLine: 1 });
    expect(() => parseDcFile("t", "<div></div>")).toThrow(/нет блока/);
    expect(() => parseDcFile("t", '<x-dc></x-dc><script data-dc-script data-props="&hellip;"></script>')).toThrow(/сущность/);
  });

  it("checkout с CRLF собирается так же, как с LF", () => {
    const dir = mkdtempSync(join(tmpdir(), "invito-web-"));
    try {
      cpSync(webDir, dir, { recursive: true });
      for (const f of readdirSync(dir)) writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").replace(/\n/g, "\r\n"));
      const crlf = buildDesign(dir);
      for (const path of ["/app/dc-bundle.js", "/app/support.js"]) expect(crlf.assets.get(path)!.hash, path).toBe(design.assets.get(path)!.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("синтаксическая ошибка в логике любого DC останавливает сборку с именем файла и строкой", () => {
    const dir = mkdtempSync(join(tmpdir(), "invito-web-"));
    try {
      cpSync(webDir, dir, { recursive: true });
      const file = join(dir, "InviteCover.dc.html");
      const orig = readFileSync(file, "utf8");
      const at = orig.indexOf("class Component");
      writeFileSync(file, `${orig.slice(0, at)}const [a] = ;\n${orig.slice(at)}`);
      const line = orig.slice(0, at).split("\n").length;
      expect(() => buildDesign(dir)).toThrow(`web/InviteCover.dc.html:${line}: ошибка в логике DC`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("файлы сжимаются один раз при сборке", () => {
    for (const [path, a] of design.assets) {
      expect(Object.keys(a.encoded).sort(), path).toEqual(["br", "gzip"]);
      expect(brotliDecompressSync(a.encoded.br!).equals(a.body), path).toBe(true);
      expect(gunzipSync(a.encoded.gzip!).equals(a.body), path).toBe(true);
    }
  });

  it("выбор сжатия по Accept-Encoding", () => {
    const both = { br: Buffer.from("b"), gzip: Buffer.from("g") };
    expect(pickEncoding(undefined, both)).toBeNull();
    expect(pickEncoding("", both)).toBeNull();
    expect(pickEncoding("identity", both)).toBeNull();
    expect(pickEncoding("gzip, deflate, br", both)).toBe("br");
    expect(pickEncoding("gzip, deflate", both)).toBe("gzip");
    expect(pickEncoding("x-gzip", both)).toBe("gzip");
    expect(pickEncoding("br;q=0.5, gzip;q=0.8", both)).toBe("gzip");
    expect(pickEncoding("BR;Q=0, gzip", both)).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip;q=0", both)).toBeNull();
    expect(pickEncoding("*", both)).toBe("br");
    expect(pickEncoding("*;q=0.1, br;q=0", both)).toBe("gzip");
    expect(pickEncoding("br;q=abc", both)).toBeNull();
    // Копии нет (сжатие не уменьшило файл): отдаётся как есть или другим способом.
    expect(pickEncoding("br", { gzip: both.gzip })).toBeNull();
    expect(pickEncoding("br, gzip", { gzip: both.gzip })).toBe("gzip");
  });
});

describe("оболочка", () => {
  it("загрузочные данные не закрывают <script>, мета экранируется", () => {
    const html = renderShell(design, {
      boot: { mode: "shared", slug: "</script><script>alert(1)</script>" },
      meta: { title: 'A & "B" <C>', description: "d", image: "https://x.test/i.png", url: "https://x.test/i/a" },
      lang: "uzc",
    });
    expect(html).not.toContain("</script><script>alert");
    expect(bootOf(html)).toEqual({ mode: "shared", slug: "</script><script>alert(1)</script>" });
    expect(html).toContain("<title>A &amp; &quot;B&quot; &lt;C&gt;</title>");
    expect(html).toContain('<meta property="og:image" content="https://x.test/i.png">');
    expect(html).toContain('<html lang="uz-Cyrl">');
  });

  it("страницы приглашений закрыты от индексации, приложение — нет", () => {
    for (const boot of [{ mode: "shared", slug: "a" }, { mode: "personal", token: "t" }, { mode: "notfound" }] as const) {
      expect(metaOf(renderShell(design, { boot }), "robots"), boot.mode).toBe("noindex, nofollow");
    }
    expect(metaOf(renderShell(design, { boot: { mode: "app" } }), "robots")).toBeUndefined();
  });

  it("порядок скриптов: Telegram, React, ReactDOM, qrcode, бандл, рантайм", () => {
    const html = renderShell(design, { boot: { mode: "app" } });
    const order = [
      "https://telegram.org/js/telegram-web-app.js",
      assetUrl(design, "/app/vendor/react.production.min.js"),
      assetUrl(design, "/app/vendor/react-dom.production.min.js"),
      assetUrl(design, "/app/vendor/qrcode.js"),
      assetUrl(design, "/app/dc-bundle.js"),
      assetUrl(design, "/app/support.js"),
    ].map((src) => html.indexOf(`<script src="${src}"></script>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf('id="invito-boot"')).toBeLessThan(order[0]!);
  });
});

describe("публичная страница по ответу бэкенда", () => {
  const meta = { title: "Той", description: "", image: null, url: "https://x.test/i/abc" };
  const look = { template: "wedding-classic", font: "Cormorant Garamond", palette: 1 };

  /** Подставной бэкенд: отвечает по очереди и запоминает запросы. */
  function backend(...pages: PublicPage[]) {
    const calls: PublicPageRequest[] = [];
    const resolve = async (r: PublicPageRequest) => {
      calls.push(r);
      const page = pages.shift();
      if (!page) throw new Error("лишний запрос к бэкенду");
      return page;
    };
    return { calls, resolve };
  }

  it("найдено: view в загрузочных данных, мета-теги и язык приглашения", async () => {
    const view = { kind: "shared", language: "uzc", data: { names: "A" } };
    const full = { title: "A — 1", description: "Текст", image: "https://x.test/og.png", url: "https://x.test/i/abc" };
    expect(await publicShell(backend({ status: 200, view, meta: full }).resolve, { kind: "shared", key: "abc" })).toEqual({
      boot: { mode: "shared", slug: "abc", view },
      meta: full,
      lang: "uzc",
    });
    // Пустое описание и отсутствующая картинка в теги не попадают.
    expect(await publicShell(backend({ status: 200, view, meta }).resolve, { kind: "personal", key: "tok" })).toEqual({
      boot: { mode: "personal", token: "tok", view },
      meta: { title: "Той", url: meta.url },
      lang: "uzc",
    });
  });

  it("пароль: look для формы ввода на языке приглашения; попытки исчерпаны — та же форма со статусом 429 и limited", async () => {
    expect(await publicShell(backend({ status: 401, locked: { look }, meta }).resolve, { kind: "shared", key: "abc", code: "1" })).toEqual({
      boot: { mode: "shared", slug: "abc", locked: { look } },
      meta: { title: "Той", url: meta.url },
    });
    // Язык приглашения из look: атрибут lang страницы, форма пароля на нём же.
    const uzLook = { ...look, language: "uz" };
    expect(await publicShell(backend({ status: 401, locked: { look: uzLook }, meta }).resolve, { kind: "shared", key: "abc" })).toEqual({
      boot: { mode: "shared", slug: "abc", locked: { look: uzLook } },
      meta: { title: "Той", url: meta.url },
      lang: "uz",
    });

    const limited = backend({ status: 429, meta }, { status: 401, locked: { look }, meta });
    const req = { kind: "shared", key: "abc", code: "bad", ip: "203.0.113.5", userAgent: "UA" } as const;
    expect(await publicShell(limited.resolve, req)).toEqual({
      boot: { mode: "shared", slug: "abc", locked: { look, limited: true } },
      meta: { title: "Той", url: meta.url },
      status: 429,
    });
    // Повторный запрос без пароля: он не считается попыткой и возвращает look.
    expect(limited.calls).toEqual([req, { ...req, code: undefined }]);
    // Пароль сняли между запросами: страница открывается как обычно, без 429.
    const view = { kind: "shared", language: "ru", data: {} };
    expect(await publicShell(backend({ status: 429, meta }, { status: 200, view, meta }).resolve, req)).toEqual({
      boot: { mode: "shared", slug: "abc", view },
      meta: { title: "Той", url: meta.url },
      lang: "ru",
    });
  });

  it("не найдено и ответы вне контракта — «не найдено» с 404", async () => {
    const notFound = { boot: { mode: "notfound" }, meta: { title: "Той", url: meta.url }, status: 404 };
    expect(await publicShell(backend({ status: 404, meta }).resolve, { kind: "shared", key: "abc" })).toEqual(notFound);
    expect(await publicShell(backend({ status: 404, meta }).resolve, { kind: "personal", key: "tok" })).toEqual(notFound);
    // 429 без пароля в запросе и 401 у личной ссылки бэкенд не отдаёт; повторного запроса нет.
    expect(await publicShell(backend({ status: 429, meta }).resolve, { kind: "shared", key: "abc" })).toEqual(notFound);
    expect(await publicShell(backend({ status: 401, locked: { look }, meta }).resolve, { kind: "personal", key: "tok" })).toEqual(notFound);
  });

  it("маршруты передают бэкенду ключ, пароль, IP и User-Agent; статус доходит до ответа", async () => {
    const api = backend(
      { status: 401, locked: { look }, meta },
      { status: 429, meta },
      { status: 401, locked: { look }, meta },
      { status: 401, locked: { look }, meta },
      { status: 200, view: { language: "en" }, meta },
    );
    const mini = Fastify({ logger: false });
    mini.decorate("ctx", { config } as unknown as Ctx);
    await mini.register(webRoutes, { publicPage: api.resolve });
    try {
      const bot = { "user-agent": "TelegramBot (like TwitterBot)" };
      const browser = { "user-agent": "Mozilla/5.0" };
      // Повтор ?code= не выбирается наугад, а считается отсутствием пароля.
      const locked = await mini.inject({ url: "/i/abc?code=a&code=b", headers: bot });
      expect(locked.statusCode).toBe(200);
      expect(bootOf(locked.body)).toEqual({ mode: "shared", slug: "abc", locked: { look } });
      const limited = await mini.inject({ url: `/i/abc?code=${"x".repeat(64)}`, headers: browser });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(bootOf(limited.body)).toEqual({ mode: "shared", slug: "abc", locked: { look, limited: true } });
      // Пароль длиннее 64 символов не бывает: бэкенд получает запрос без него.
      expect(bootOf((await mini.inject({ url: `/i/abc?code=${"x".repeat(65)}`, headers: browser })).body).locked).toEqual({ look });
      const guest = await mini.inject({ url: "/g/tok", headers: bot });
      expect(guest.statusCode).toBe(200);
      expect(guest.body).toContain('<html lang="en">');
      expect(api.calls.map(({ kind, key, code, userAgent }) => ({ kind, key, code, userAgent }))).toEqual([
        { kind: "shared", key: "abc", code: undefined, userAgent: bot["user-agent"] },
        { kind: "shared", key: "abc", code: "x".repeat(64), userAgent: browser["user-agent"] },
        { kind: "shared", key: "abc", code: undefined, userAgent: browser["user-agent"] },
        { kind: "shared", key: "abc", code: undefined, userAgent: browser["user-agent"] },
        { kind: "personal", key: "tok", code: undefined, userAgent: bot["user-agent"] },
      ]);
      expect(api.calls.every((c) => c.ip === "127.0.0.1")).toBe(true);
    } finally {
      await mini.close();
    }
  });
});

describe("публичные страницы на данных приглашений", () => {
  let userId: string;
  let templateId: string;
  const token = () => randomBytes(12).toString("base64url");

  /** Приглашение прямо в базе: по умолчанию общее, опубликованное и оплаченное. */
  async function invitation(values: Partial<typeof invitations.$inferInsert> = {}): Promise<Invitation> {
    const [inv] = await db
      .insert(invitations)
      .values({ userId, templateId, mode: "shared", status: "active", unlocked: true, title: "Той", language: "ru", data: {}, slug: token(), ...values })
      .returning();
    return inv!;
  }

  beforeAll(async () => {
    const [u] = await db.insert(users).values({ phone: "998901112233" }).returning();
    const [t] = await db.select().from(templates);
    userId = u!.id;
    templateId = t!.id;
  });

  it("общая ссылка: view как у /api/public, OG-теги и язык приглашения", async () => {
    const message = `Дорогие друзья!\n\n  ${"Ждём вас на нашей свадьбе. ".repeat(10)}`;
    const inv = await invitation({ language: "uz", data: { names: "Азиз & Мадина", date: "2026-12-12", message, cover: "/media/3f2b8c1e-0d4a-4c6e-9b1a-7e5d2c9f8a10.jpg" } });
    const res = await app.inject({ url: `/i/${inv.slug}` });
    expect(res.statusCode).toBe(200);
    const api = await app.inject({ url: `/api/public/i/${inv.slug}` });
    expect(bootOf(res.body)).toEqual({ mode: "shared", slug: inv.slug, view: api.json() });
    expect(res.body).toContain('<html lang="uz-Latn">');

    // Длинная дата на языке приглашения (узбекский латиницей), имена экранированы.
    expect(longDate("2026-12-12", "uz")).toContain("dekabr");
    const title = `Азиз &amp; Мадина — ${longDate("2026-12-12", "uz")}`;
    expect(res.body).toContain(`<title>${title}</title>`);
    expect(metaOf(res.body, "og:title")).toBe(title);
    // Текст одной строкой, до 160 символов с многоточием.
    const description = metaOf(res.body, "og:description")!;
    expect(Array.from(description)).toHaveLength(160);
    expect(description).toMatch(/^Дорогие друзья! Ждём вас на нашей свадьбе\. .*…$/);
    expect(metaOf(res.body, "description")).toBe(description);
    expect(metaOf(res.body, "og:image")).toBe(`${config.APP_URL}/media/3f2b8c1e-0d4a-4c6e-9b1a-7e5d2c9f8a10.jpg`);
    expect(metaOf(res.body, "og:url")).toBe(`${config.APP_URL}/i/${inv.slug}`);
    expect(metaOf(res.body, "twitter:card")).toBe("summary_large_image");
  });

  it("личная ссылка: гость с оплаченным местом; гость сверх оплаченных — «не найдено»", async () => {
    const inv = await invitation({ mode: "personal", unlocked: false, paidSeats: 1, language: "en", data: { names: "Tom & Ann", date: "2026-02-31" } });
    const [paid, unpaid] = await db
      .insert(guests)
      .values([
        { invitationId: inv.id, name: "Bob", seat: 1, token: token() },
        { invitationId: inv.id, name: "Eve", seat: 2, token: token() },
      ])
      .returning();
    const res = await app.inject({ url: `/g/${paid!.token}` });
    expect(res.statusCode).toBe(200);
    const view = (await app.inject({ url: `/api/public/g/${paid!.token}` })).json();
    expect(view.guest.name).toBe("Bob");
    expect(bootOf(res.body)).toEqual({ mode: "personal", token: paid!.token, view });
    expect(res.body).toContain('<html lang="en">');
    // Несуществующая дата в заголовок не попадает; без текста и обложки нет description и image.
    expect(metaOf(res.body, "og:title")).toBe("Tom &amp; Ann");
    expect(metaOf(res.body, "og:description")).toBeUndefined();
    expect(metaOf(res.body, "og:image")).toBeUndefined();
    expect(metaOf(res.body, "og:url")).toBe(`${config.APP_URL}/g/${paid!.token}`);

    const missing = await app.inject({ url: `/g/${unpaid!.token}` });
    expect(missing.statusCode).toBe(404);
    expect(bootOf(missing.body)).toEqual({ mode: "notfound" });
  });

  it("черновик, архив, без оплаты, личное по общей ссылке, неизвестный и пустой адрес — 404", async () => {
    const slugs = [
      (await invitation({ status: "draft" })).slug,
      (await invitation({ status: "archived" })).slug,
      (await invitation({ unlocked: false })).slug,
      (await invitation({ mode: "personal", paidSeats: 1 })).slug,
      "no-such-invitation",
    ];
    for (const url of [...slugs.map((s) => `/i/${s}`), "/i/", "/g/", "/g/short", `/g/${"a".repeat(65)}`, "/i/%3Cb%3E"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toBe("text/html; charset=utf-8");
      expect(bootOf(res.body), url).toEqual({ mode: "notfound" });
      // Без данных приглашения: только название сайта и адрес страницы.
      expect(res.body, url).toContain(`<title>${config.APP_NAME}</title>`);
      expect(metaOf(res.body, "og:description"), url).toBeUndefined();
      expect(metaOf(res.body, "og:image"), url).toBeUndefined();
    }
    expect(metaOf((await app.inject({ url: "/i/%3Cb%3E" })).body, "og:url")).toBe(`${config.APP_URL}/i/%3Cb%3E`);
  });

  it("страницы приглашений не индексируются и не кэшируются, страницы приложения — как раньше", async () => {
    const inv = await invitation();
    for (const url of [`/i/${inv.slug}`, "/i/no-such-invitation", "/g/no-such-token"]) {
      const res = await app.inject({ url });
      expect(res.headers["x-robots-tag"], url).toBe("noindex, nofollow");
      expect(metaOf(res.body, "robots"), url).toBe("noindex, nofollow");
      expect(res.headers["cache-control"], url).toBe("private, no-store");
    }
    for (const url of ["/", "/app/"]) {
      const res = await app.inject({ url });
      expect(res.headers["x-robots-tag"], url).toBeUndefined();
      expect(metaOf(res.body, "robots"), url).toBeUndefined();
      expect(res.headers["cache-control"], url).toBe("private, no-cache");
    }
  });
});

describe("маршруты фронтенда", () => {
  it("страницы приложения отдают оболочку", async () => {
    for (const url of ["/", "/app", "/app/", "/app/orders/1"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(bootOf(res.body)).toEqual({ mode: "app" });
    }
    // Похожее на файл под /app/ — 404, а не страница.
    for (const url of ["/app/nope.js", "/app/vendor/nope.js", "/app/Invito.dc.html", "/index.html"]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
  });

  it("CSP: без eval и CDN, Telegram Web может встроить приложение, админку — никто", async () => {
    for (const url of ["/", "/app/", "/i/a", "/g/t", assetUrl(design, "/app/support.js")]) {
      const res = await app.inject({ url });
      const csp = String(res.headers["content-security-policy"]);
      expect(csp, url).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
      expect(res.headers["x-frame-options"], url).toBeUndefined();
      expect(csp).toContain("script-src 'self' https://telegram.org;");
      expect(csp).toContain("media-src 'self' blob: data:");
      expect(csp).toContain("frame-src https://maps.google.com https://www.google.com https://oauth.telegram.org");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toContain("unpkg");
    }
    for (const url of ["/admin/", "/shared/api.js", "/health"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(String(res.headers["content-security-policy"]), url).toContain("frame-ancestors 'none'");
      expect(res.headers["x-frame-options"], url).toBe("DENY");
    }
  });

  it("файлы: хэш в адресе, долгий кэш, ETag, готовые сжатые копии и Vary", async () => {
    for (const [path, a] of design.assets) {
      const res = await app.inject({ url: assetUrl(design, path) });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      // Свой лимит у каждого файла, выше общего: один клиент не выкачивает файлы без конца.
      expect(res.headers["x-ratelimit-limit"], path).toBe("600");
      // Несжатый ответ тоже с Vary: общий кэш не отдаст его клиенту, который умеет сжатие.
      expect(res.headers.vary, path).toBe("accept-encoding");
      expect(res.headers["content-encoding"], path).toBeUndefined();
      expect(res.rawPayload.equals(a.body)).toBe(true);
      // Сжатые ответы — копии из сборки, а не сжатие на каждый запрос.
      for (const [enc, header] of [["br", "gzip, deflate, br"], ["gzip", "gzip"]] as const) {
        const z = await app.inject({ url: assetUrl(design, path), headers: { "accept-encoding": header } });
        expect(z.headers["content-encoding"], `${path} ${enc}`).toBe(enc);
        expect(z.headers.vary).toBe("accept-encoding");
        expect(z.headers["content-length"]).toBe(String(a.encoded[enc]!.length));
        expect(z.rawPayload.equals(a.encoded[enc]!), `${path} ${enc}`).toBe(true);
      }
    }
    // Модули логика грузит без ?v=: сверка по ETag.
    const mod = await app.inject({ url: "/app/invito-data.js" });
    expect(mod.headers["cache-control"]).toBe("no-cache");
    const etag = String(mod.headers.etag);
    const notModified = await app.inject({ url: "/app/invito-data.js", headers: { "if-none-match": etag, "accept-encoding": "br" } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers.vary).toBe("accept-encoding");
    expect(notModified.rawPayload).toHaveLength(0);
    expect((await app.inject({ url: "/app/invito-data.js?v=old", headers: { "if-none-match": `"x", ${etag}` } })).statusCode).toBe(304);
    expect((await app.inject({ url: "/app/support.js?v=old" })).headers["cache-control"]).toBe("no-cache");

    // Оболочка сжимается на лету.
    const page = await app.inject({ url: "/app/", headers: { "accept-encoding": "gzip" } });
    expect(page.headers["content-encoding"]).toBe("gzip");
  });
});
