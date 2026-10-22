import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BRAND } from "../src/brand.js";
import { invitations } from "../src/db/schema.js";
import { LEGAL_PAGES } from "../src/web/legal-texts.js";
import { DEFAULT_META } from "../src/web/pages.js";
import { I18N, toCyr } from "../web/invito-data.js";
import { testContext } from "./helpers.js";

/**
 * Название продукта — InviteBloom. «Invito» — имя проекта в Claude Design, откуда пришёл дизайн; оно
 * остаётся только во внутренних именах (файлы web/Invito.dc.html и invito-*.js, ключи localStorage invito.*,
 * #invito-boot), которые пользователь не видит. Строка APP_NAME=Invito в .env сервера ни на что не влияет.
 */

// Старый .env с сервера: APP_NAME из .env.example.
const t = testContext({ APP_NAME: "Invito" });
const { smsSent, redis, req } = t;
const LANGS = ["ru", "uz", "uzc", "en"] as const;
// «InviteBloom» не содержит «invito», так что это ловит только старое название в любом регистре.
const OLD = /invito/i;

type Dict = Record<string, unknown>;
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** Заголовок и содержимое всех мета-тегов страницы: то, что видно во вкладке и в превью ссылки. */
const visibleMeta = (html: string) => [
  /<title>([^<]*)<\/title>/.exec(html)![1]!,
  ...[...html.matchAll(/<meta (?:property|name)="[^"]+" content="([^"]*)">/g)].map((m) => m[1]!),
];
const metaOf = (html: string, prop: string) => [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].find((m) => m[1] === prop)?.[2];

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("название продукта", () => {
  it("постоянное InviteBloom, а не из окружения", () => {
    expect(BRAND).toBe("InviteBloom");
    expect(t.config).not.toHaveProperty("APP_NAME");
  });

  it("SMS с кодом входа называет сайт, а не Invito, на всех языках и при APP_NAME=Invito в окружении", async () => {
    for (const [i, lang] of LANGS.entries()) {
      smsSent.length = 0;
      const phone = `99893555000${i}`;
      expect((await req(null, "POST", "/api/auth/phone/request", { phone }, { "x-lang": lang })).statusCode, lang).toBe(200);
      expect(smsSent, lang).toHaveLength(1);
      // Eskiz одобряет текст кода, только если в нём назван сайт: здесь это домен из APP_URL тестов.
      expect(smsSent[0]!.text, lang).toMatch(/\blocalhost\b/);
      expect(smsSent[0]!.text, lang).not.toMatch(OLD);
    }
  });

  it("словари интерфейса: ни одного Invito, в узбекской кириллице InviteBloom остаётся латиницей", () => {
    const I = I18N as Record<string, Dict>;
    for (const lang of LANGS) {
      const all = strings(I[lang]);
      expect(all.filter((s) => OLD.test(s)), lang).toEqual([]);
      // Бот, тур, подвал, «Сделано в …», оплата в мини-аппе, вопросы на главной.
      expect(all.filter((s) => s.includes(BRAND)).length, lang).toBeGreaterThanOrEqual(9);
      for (const key of ["madeWith", "tourKick", "tgLoginNote", "sharePhoneHint", "paidText"]) expect(I[lang]![key], `${lang}.${key}`).toContain(BRAND);
      expect((I[lang]!.botT as Dict).title, lang).toContain(BRAND);
      expect((I[lang]!.home as Dict).copy, lang).toBe(`© {year} ${BRAND} · ${{ ru: "Ташкент", uz: "Toshkent", uzc: "Тошкент", en: "Tashkent" }[lang]}`);
    }
    expect(I.ru!.madeWith).toBe("Сделано в InviteBloom");
    expect(I.ru!.paidText).toContain("InviteBloom сам проверит оплату");
    expect((I.ru!.botT as Dict).title).toBe("InviteBloom бот");
    // Узбекский: суффикс после латинского названия через ’ (U+2019).
    expect(I.uz!.madeWith).toBe("InviteBloom’da yaratilgan");
    expect(I.uzc!.madeWith).toBe("InviteBloom’да яратилган");
    expect(toCyr("InviteBloom boti")).toBe("InviteBloom боти");
    expect(JSON.stringify(I.uzc)).not.toMatch(/Инвит/);
  });

  it("мета-теги главной, приложения, страниц «не найдено» и приглашения", async () => {
    expect(DEFAULT_META.title).toBe("InviteBloom — электронные приглашения на свадьбу и праздник");
    for (const url of ["/", "/app/", "/app/build", "/i/nothing-here", "/g/" + "a".repeat(20), "/no-such-page"]) {
      const res = await t.app.inject({ url, headers: { accept: "text/html" } });
      expect(res.headers["content-type"], url).toBe("text/html; charset=utf-8");
      const meta = visibleMeta(res.body);
      expect(meta[0], url).toMatch(/^InviteBloom/);
      expect(meta.filter((s) => OLD.test(s)), url).toEqual([]);
      expect(metaOf(res.body, "og:site_name"), url).toBe("InviteBloom");
    }
    // Опубликованное приглашение: в заголовке имена, в превью ссылки — название сайта.
    const { cookie } = await t.login(4242);
    const created = await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", mode: "shared", language: "uzc", data: { names: "Малика ва Жасур" } });
    expect(created.statusCode, created.body).toBe(201);
    const inv = created.json();
    await t.db.update(invitations).set({ status: "active", unlocked: true, publishedAt: new Date() }).where(eq(invitations.id, inv.id));
    const page = await t.app.inject({ url: `/i/${inv.slug}`, headers: { accept: "text/html" } });
    expect(page.statusCode).toBe(200);
    expect(visibleMeta(page.body)[0]).toBe("Малика ва Жасур");
    expect(visibleMeta(page.body).filter((s) => OLD.test(s))).toEqual([]);
    expect(metaOf(page.body, "og:site_name")).toBe("InviteBloom");
  });

  it("юридические страницы на всех языках: InviteBloom в шапке, заголовке, тексте и подвале, Invito нигде", async () => {
    const year = new Date().getUTCFullYear();
    for (const p of LEGAL_PAGES) {
      for (const lang of LANGS) {
        const res = await t.app.inject({ url: lang === "ru" ? `/${p}` : `/${p}?lang=${lang}`, headers: { accept: "text/html" } });
        expect(res.statusCode, `${p} ${lang}`).toBe(200);
        const html = res.body;
        // Страница без скриптов и загрузочных данных: всё в ней видно пользователю или поисковику.
        expect(html, `${p} ${lang}`).not.toMatch(OLD);
        expect(html).toContain('<div class="brand"><a class="logo" href="/">InviteBloom</a></div>');
        expect(/<title>([^<]*)<\/title>/.exec(html)![1]).toMatch(/ — InviteBloom$/);
        expect(metaOf(html, "og:site_name")).toBe("InviteBloom");
        expect(html).toContain(`<span>© ${year} InviteBloom</span>`);
        // Подстановка {app} в описании и тексте; в кириллице название не транслитерируется.
        expect(metaOf(html, "description"), `${p} ${lang}`).toContain("InviteBloom");
        expect(html).not.toMatch(/Инвит/);
      }
    }
  });
});
