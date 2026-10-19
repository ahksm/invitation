import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/index.js";
import { createPaymentProvider } from "../src/payments/index.js";
import { createSmsProvider } from "../src/sms/index.js";
import { assetUrl, buildDesign, createDesignStore, parseDcFile, webDir } from "../src/web/design.js";
import { renderShell } from "../src/web/pages.js";
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

beforeAll(async () => {
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
    expect(design.preload).toEqual(["/app/invito-data.js", "/app/invito-engine.js"]);
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
    });
    expect(parseDcFile("t", "<x-dc></x-dc>")).toEqual({ template: "", props: null, preview: null, logic: null });
    expect(() => parseDcFile("t", "<div></div>")).toThrow(/нет блока/);
    expect(() => parseDcFile("t", '<x-dc></x-dc><script data-dc-script data-props="&hellip;"></script>')).toThrow(/сущность/);
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

describe("маршруты фронтенда", () => {
  it("страницы приложения и публичные ссылки отдают оболочку", async () => {
    for (const url of ["/", "/app", "/app/", "/app/orders/1"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(bootOf(res.body)).toEqual({ mode: "app" });
    }
    expect(bootOf((await app.inject({ url: "/i/my-wedding?code=1" })).body)).toEqual({ mode: "shared", slug: "my-wedding" });
    expect(bootOf((await app.inject({ url: "/g/tok123" })).body)).toEqual({ mode: "personal", token: "tok123" });
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

  it("файлы: хэш в адресе, долгий кэш, ETag и сжатие", async () => {
    for (const path of design.assets.keys()) {
      const res = await app.inject({ url: assetUrl(design, path) });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(res.rawPayload.equals(design.assets.get(path)!.body)).toBe(true);
    }
    // Модули логика грузит без ?v=: сверка по ETag.
    const mod = await app.inject({ url: "/app/invito-data.js" });
    expect(mod.headers["cache-control"]).toBe("no-cache");
    const etag = String(mod.headers.etag);
    expect((await app.inject({ url: "/app/invito-data.js", headers: { "if-none-match": etag } })).statusCode).toBe(304);
    expect((await app.inject({ url: "/app/invito-data.js?v=old", headers: { "if-none-match": `"x", ${etag}` } })).statusCode).toBe(304);
    expect((await app.inject({ url: "/app/support.js?v=old" })).headers["cache-control"]).toBe("no-cache");

    const br = await app.inject({ url: assetUrl(design, "/app/support.js"), headers: { "accept-encoding": "br" } });
    expect(br.headers["content-encoding"]).toBe("br");
    const page = await app.inject({ url: "/app/", headers: { "accept-encoding": "gzip" } });
    expect(page.headers["content-encoding"]).toBe("gzip");
  });
});
