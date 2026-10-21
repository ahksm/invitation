import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitations, templates, users } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, uniquePhone, type E2E, type Problems } from "./helpers.js";

/**
 * Дымовая проверка фронтенда в настоящем Chromium: оболочка, пропатченный рантайм и логика
 * InviteBloom запускаются без ошибок в консоли и без нарушений CSP (то есть без eval и CDN).
 * Запуск: npm run test:e2e (окружение — test/e2e/helpers.ts).
 */

const HERO = I18N.ru.hero1 as string;
let e: E2E;

function expectLoaded(p: Problems, path: string) {
  // Страница загружается один раз: рантайм не перечитывает её через fetch(location.href).
  expect(p.requests.filter((u) => u === path)).toHaveLength(1);
  // Вложенные DC берутся из бандла, а не из *.dc.html.
  expect(p.requests.filter((u) => u.includes(".dc.html"))).toEqual([]);
}

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.close();
});

describe("фронтенд в браузере", () => {
  it("/app/ показывает главную InviteBloom без ошибок и нарушений CSP", async () => {
    const { page, problems, close } = await e.open("/app/", { waitText: HERO });
    await e.expectClean(page, problems);
    // Без сессии единственная ошибка консоли — 401 от /api/auth/me.
    expect(problems.me401).toBe(1);
    expectLoaded(problems, "/app/");
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
    expect(problems.requests.some((u) => u.startsWith("/app/invito-api.js"))).toBe(true);
    await e.shot(page, "app-390x844.png");
    // Переход в конструктор: выбор события рисуется без новых ошибок.
    await page.getByRole("button", { name: I18N.ru.create }).first().click();
    await e.waitText(page, I18N.ru.chooseEvent as string);
    await page.waitForTimeout(500);
    await e.expectClean(page, problems);
    await e.shot(page, "app-events-390x844.png");
    // Проверка самой проверки: адрес, запрещённый CSP, попадает в список нарушений.
    await page.evaluate(() => void (new Image().src = "https://example.com/csp-probe.png"));
    await expect.poll(() => e.csp(page)).toEqual(["img-src https://example.com/csp-probe.png"]);
    await close();
  });

  it("/app/ на широком экране", async () => {
    const { page, problems, close } = await e.open("/app/", { viewport: { width: 1280, height: 800 }, waitText: HERO });
    await e.expectClean(page, problems);
    expectLoaded(problems, "/app/");
    await e.shot(page, "app-1280x800.png");
    await close();
  });

  it("/i/:slug опубликованного приглашения запускает рантайм с view в загрузочных данных", async () => {
    const [user] = await e.db.insert(users).values({ phone: uniquePhone() }).returning();
    // Шаблон по slug: порядок строк в таблице меняется после правок шаблонов в других проверках.
    const [template] = await e.db.select().from(templates).where(eq(templates.slug, "wedding-classic"));
    const slug = randomBytes(9).toString("base64url");
    // Данные с «</script>» и кавычками: загрузочный JSON не ломает страницу.
    const data = { names: 'Азиз & "Мадина"', message: "</script><script>window.__pwned = 1</script>", date: "2026-12-12" };
    await e.db.insert(invitations).values({ userId: user!.id, templateId: template!.id, mode: "shared", status: "active", unlocked: true, title: "Той", data, slug });
    const { page, problems, close } = await e.open(`/i/${slug}`, { waitText: 'Азиз & "Мадина"' });
    await e.expectClean(page, problems);
    expectLoaded(problems, `/i/${slug}`);
    // Публичная страница не спрашивает сессию и не показывает шапку конструктора.
    expect(problems.requests.filter((u) => u.startsWith("/api/"))).toEqual([]);
    expect(await page.locator("[data-account]").count()).toBe(0);
    const boot = await page.evaluate(() => JSON.parse(document.getElementById("invito-boot")!.textContent!));
    expect(boot).toMatchObject({ mode: "shared", slug, view: { data } });
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex, nofollow");
    await close();
  });

  it("неизвестные /i/ и /g/ отдают 404 с { mode: \"notfound\" } и страницей «не найдено»", async () => {
    for (const path of ["/i/test-slug", "/g/test-token"]) {
      const { page, problems, close } = await e.open(path, { status: 404, waitText: I18N.ru.nfTitle as string });
      // Статус 404 самой страницы Chromium пишет в консоль как ошибку загрузки: это единственная ожидаемая ошибка.
      const own404 = "Failed to load resource: the server responded with a status of 404 (Not Found)";
      expect(problems.console).toEqual([own404]);
      await e.expectClean(page, { ...problems, console: [] });
      expectLoaded(problems, path);
      expect(problems.requests.filter((u) => u.startsWith("/api/"))).toEqual([]);
      expect(await page.evaluate(() => JSON.parse(document.getElementById("invito-boot")!.textContent!))).toEqual({ mode: "notfound" });
      expect(await page.locator(".sc-placeholder, .sc-logic-error").count()).toBe(0);
      if (path.startsWith("/i/")) await e.shot(page, "notfound-ru-390x844.png");
      // Кнопка ведёт в конструктор.
      await page.getByRole("button", { name: I18N.ru.makeOwn as string }).click();
      await page.waitForURL(e.base + "/app/");
      await close();
    }
  });

  it("без dc-bundle.js страница пустая, но причина видна в консоли", async () => {
    const context = await e.browser.newContext();
    await context.route((url) => url.origin !== e.base, (route) => route.fulfill({ status: 204 }));
    // Бандл с синтаксической ошибкой: скрипт падает целиком, window.__dcSources не появляется.
    await context.route((url) => url.pathname === "/app/dc-bundle.js", (route) => route.fulfill({ contentType: "text/javascript", body: "window.__dcSources = ;" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(e.base + "/app/");
    await expect.poll(() => errors.some((x) => x.includes("[invito] /app/dc-bundle.js did not load or failed"))).toBe(true);
    await context.close();
  });
});
