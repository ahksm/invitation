import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema.js";
import { emptyLegal, getLegal } from "../src/services/settings.js";
import { legalLocale, legalPath, renderLegalPage, type LegalEnv } from "../src/web/legal.js";
import { LEGAL_PAGES, legalTexts } from "../src/web/legal-texts.js";
import { testContext } from "./helpers.js";

/**
 * Юридические страницы для Multicard: /oferta, /privacy, /contacts на ru (по умолчанию), uz, uzc и en,
 * реквизиты из настроек (PUT /api/admin/legal), пустые поля не выводятся, значения экранируются.
 */
const t = testContext();
const { db, redis, login, req } = t;

const page = (path: string, headers: Record<string, string> = {}) => t.app.inject({ method: "GET", url: path, headers: { accept: "text/html", ...headers } });
const h1Of = (html: string) => /<h1>(.*?)<\/h1>/.exec(html)?.[1];
const titleOf = (html: string) => /<title>(.*?)<\/title>/.exec(html)?.[1];
const metaOf = (html: string, prop: string) =>
  [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].find((m) => m[1] === prop)?.[2];
/** Строки реквизитов: data-field → текст значения без разметки. */
const rowsOf = (html: string) =>
  Object.fromEntries([...html.matchAll(/<div data-field="(\w+)"><dt>[^<]*<\/dt><dd>(.*?)<\/dd><\/div>/g)].map((m) => [m[1], m[2]!.replace(/<[^>]+>/g, "")]));

const full = {
  companyName: "ООО «Инвито Медиа»",
  inn: "309876543",
  address: "Ташкент, ул. Буюк Ипак Йули, 123",
  phone: "+998 90 123-45-67",
  email: "support@invito.uz",
  telegram: "@invito_support",
  bankName: "АКБ «Капиталбанк»",
  bankAccount: "20208000900123456001",
  mfo: "01088",
  director: "Абдурахмонов А.",
};

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await db.delete(settings).where(eq(settings.key, "legal"));
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("страницы /oferta, /privacy, /contacts", () => {
  it("по умолчанию на русском, ?lang= переключает на узбекский (латиница и кириллица) и английский", async () => {
    const h1 = {
      ru: ["Публичная оферта", "Политика конфиденциальности", "Контакты"],
      uz: ["Ommaviy oferta", "Maxfiylik siyosati", "Kontaktlar"],
      uzc: ["Оммавий оферта", "Махфийлик сиёсати", "Контактлар"],
      en: ["Public offer", "Privacy policy", "Contacts"],
    };
    const htmlLang = { ru: "ru", uz: "uz-Latn", uzc: "uz-Cyrl", en: "en" };
    for (const [lang, titles] of Object.entries(h1) as [keyof typeof h1, string[]][]) {
      for (const [i, p] of LEGAL_PAGES.entries()) {
        const res = await page(lang === "ru" ? `/${p}` : `/${p}?lang=${lang}`);
        expect(res.statusCode, `${p} ${lang}`).toBe(200);
        expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
        const html = res.body;
        expect(html).toContain(`<html lang="${htmlLang[lang]}">`);
        expect(h1Of(html)).toBe(titles[i]);
        expect(titleOf(html)).toBe(`${titles[i]} — Invito`);
        expect(metaOf(html, "description")!.length).toBeGreaterThan(40);
        // Страница — не оболочка приложения: без скриптов и загрузочных данных.
        expect(html).not.toContain("<script");
        expect(html).not.toContain("invito-boot");
        expect(html).toContain(`<link rel="canonical" href="http://localhost:3000${legalPath(p, lang)}">`);
        expect(html).toContain('<a class="logo" href="/">');
      }
    }
    // Неизвестный или повторённый язык — русский.
    expect(h1Of((await page("/oferta?lang=de")).body)).toBe("Публичная оферта");
    expect(h1Of((await page("/oferta?lang=uz&lang=en")).body)).toBe("Публичная оферта");
    expect(h1Of((await page("/oferta?lang=uz-Cyrl")).body)).toBe("Оммавий оферта");
  });

  it("разделы оферты и политики: оплата через Multicard, возврат, закон о персональных данных, передача третьим лицам", async () => {
    const oferta = (await page("/oferta")).body;
    for (const s of ["Предмет договора", "Акцепт оферты", "Цены и оплата", "Возврат денег", "Ответственность", "Применимое право", "Реквизиты Исполнителя"]) expect(oferta).toContain(s);
    expect(oferta).toContain("Multicard");
    expect(oferta).toContain("законодательство Республики Узбекистан");
    expect(oferta).toContain('<a href="/privacy">Политику конфиденциальности</a>');
    const privacy = (await page("/privacy")).body;
    expect(privacy).toContain("ЗРУ-547");
    for (const s of ["Eskiz", "Multicard", "Telegram", "cookie"]) expect(privacy).toContain(s);
    expect(privacy).toContain('<a href="/contacts">контактам</a>');
    // Ссылки между документами сохраняют язык.
    const uz = (await page("/oferta?lang=uz")).body;
    expect(uz).toContain('<a href="/privacy?lang=uz">Maxfiylik siyosati</a>');
    expect(uz).toContain("O‘zbekiston Respublikasi");
    const uzc = (await page("/privacy?lang=uzc")).body;
    expect(uzc).toContain("Шахсга доир маълумотлар тўғрисида");
    // Названия сервисов и ссылки в кириллицу не переводятся.
    for (const s of ["Eskiz", "Multicard", "Google Maps", '<a href="/contacts?lang=uzc">']) expect(uzc).toContain(s);
  });

  it("без реквизитов: исполнитель — администрация сайта, пустые поля не выводятся, раздел «Реквизиты» в контактах скрыт", async () => {
    const oferta = (await page("/oferta")).body;
    expect(oferta).toContain("администрация сайта localhost:3000 (далее — «Исполнитель»)");
    // В реквизитах только то, что известно без настроек: бот (он запущен в тестах) и сайт.
    expect(rowsOf(oferta)).toEqual({ bot: "@invite_test_bot", site: "localhost:3000" });
    expect(oferta).not.toMatch(/___|undefined|null|TODO/);
    expect((await page("/privacy?lang=uz")).body).toContain("localhost:3000 sayti ma’muriyati (keyingi o‘rinlarda — «biz»)");
    expect((await page("/privacy?lang=en")).body).toContain("the administration of the localhost:3000 website (“we”)");

    const contacts = (await page("/contacts")).body;
    // Бот запущен (TELEGRAM_BOT_TOKEN и имя заданы): ссылка на него есть и без реквизитов.
    expect(rowsOf(contacts)).toEqual({ bot: "@invite_test_bot", site: "localhost:3000" });
    expect(contacts).toContain('<a href="https://t.me/invite_test_bot">@invite_test_bot</a>');
    expect(contacts).not.toContain('id="details"');
    expect(contacts).toContain('id="write"');
  });

  it("реквизиты из админки видны на страницах сразу после сохранения; незаполненные поля не выводятся", async () => {
    const admin = await login(1);
    // Страница уже открывалась: кэш настроек сбрасывается при сохранении.
    expect(rowsOf((await page("/oferta")).body)).toEqual({ bot: "@invite_test_bot", site: "localhost:3000" });
    const { bankName: _b, bankAccount: _a, mfo: _m, ...partial } = full;
    expect((await req(admin.cookie, "PUT", "/api/admin/legal", partial)).statusCode).toBe(200);

    const oferta = (await page("/oferta")).body;
    expect(oferta).toContain("ООО «Инвито Медиа» (далее — «Исполнитель»)");
    expect(oferta).not.toContain("администрация сайта");
    expect(rowsOf(oferta)).toEqual({
      companyName: "ООО «Инвито Медиа»",
      inn: "309876543",
      address: "Ташкент, ул. Буюк Ипак Йули, 123",
      director: "Абдурахмонов А.",
      telegram: "@invito_support",
      bot: "@invite_test_bot",
      phone: "+998 90 123-45-67",
      email: "support@invito.uz",
      site: "localhost:3000",
    });
    expect(oferta).not.toMatch(/data-field="(bankName|bankAccount|mfo)"/);
    expect(oferta).toContain('<a href="tel:+998901234567">+998 90 123-45-67</a>');
    expect(oferta).toContain('<a href="mailto:support@invito.uz">support@invito.uz</a>');
    expect(oferta).toContain('<a href="https://t.me/invito_support">@invito_support</a>');

    // Реквизиты в контактах — отдельным разделом; подписи на языке страницы, значения как есть.
    const contacts = (await page("/contacts?lang=uz")).body;
    expect(contacts).toContain('id="details"');
    expect(contacts).toContain("<dt>STIR</dt><dd>309876543</dd>");
    expect(contacts).toContain("<dt>Nomi</dt><dd>ООО «Инвито Медиа»</dd>");
    const uzc = (await page("/contacts?lang=uzc")).body;
    expect(uzc).toContain("<dt>СТИР</dt><dd>309876543</dd>");
    expect(uzc).toContain("Абдурахмонов А.");

    // Полные реквизиты: банк, счёт и МФО появляются.
    await req(admin.cookie, "PUT", "/api/admin/legal", full);
    expect(rowsOf((await page("/contacts")).body)).toMatchObject({ bankName: "АКБ «Капиталбанк»", bankAccount: "20208000900123456001", mfo: "01088" });
  });

  it("значения из настроек экранируются (XSS)", async () => {
    const admin = await login(1);
    const evil = {
      companyName: `<script>alert(1)</script> "Evil" & 'Co'`,
      address: `<img src=x onerror=alert(1)>`,
      director: `{site} [x](oferta)`,
      phone: `"><svg onload=alert(1)>`,
    };
    expect((await req(admin.cookie, "PUT", "/api/admin/legal", evil)).statusCode).toBe(200);
    for (const p of LEGAL_PAGES) {
      const html = (await page(`/${p}`)).body;
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<svg");
      if (p === "privacy") expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;Evil&quot; &amp; &#39;Co&#39; (далее — «мы»)");
    }
    const contacts = (await page("/contacts")).body;
    expect(contacts).toContain("<dd>&lt;img src=x onerror=alert(1)&gt;</dd>");
    // Подстановки и ссылки-разметка в значениях не срабатывают.
    expect(contacts).toContain("<dd>{site} [x](oferta)</dd>");
    // Номер без цифр не становится ссылкой tel:.
    expect(contacts).toContain("<dd>&quot;&gt;&lt;svg onload=alert(1)&gt;</dd>");
    expect(contacts).not.toContain('href="tel:');
  });

  it("испорченная запись в настройках не ломает страницы, лишние ключи в записи не мешают", async () => {
    await db.insert(settings).values({ key: "legal", value: { telegram: "@@", companyName: 5 } });
    expect(await getLegal(t.app.ctx)).toEqual(emptyLegal);
    const res = await page("/oferta");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("администрация сайта localhost:3000");

    // Поле, которое когда-то было в схеме, не обнуляет остальные реквизиты.
    await db.update(settings).set({ value: { companyName: "ООО «Инвито Медиа»", oldField: "x" } }).where(eq(settings.key, "legal"));
    await redis.flushdb();
    expect(await getLegal(t.app.ctx)).toEqual({ ...emptyLegal, companyName: "ООО «Инвито Медиа»" });
  });

  it("заголовки: CSP как у страниц приложения, без X-Frame-Options, кэш как у главной, индексируются; HEAD работает", async () => {
    for (const p of LEGAL_PAGES) {
      const res = await page(`/${p}`);
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' https://telegram.org");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
      expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
      expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
      expect(csp).not.toContain("unsafe-eval");
      expect(res.headers["x-frame-options"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, no-cache");
      expect(res.headers["x-robots-tag"]).toBeUndefined();
      expect(res.body).not.toContain('name="robots"');
      const head = await t.app.inject({ method: "HEAD", url: `/${p}` });
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
    // Стили и шрифты страницы укладываются в CSP: только встроенный <style> и Google Fonts.
    const html = (await page("/privacy")).body;
    expect([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]!.split("?")[0])).toEqual(["https://fonts.googleapis.com/css2"]);
    expect(html).not.toMatch(/ on\w+="/);
  });
});

describe("PUT /api/admin/legal", () => {
  it("только для администратора", async () => {
    expect((await req(null, "GET", "/api/admin/legal")).statusCode).toBe(401);
    expect((await req(null, "PUT", "/api/admin/legal", full)).statusCode).toBe(401);
    const user = await login(5001);
    expect((await req(user.cookie, "GET", "/api/admin/legal")).statusCode).toBe(403);
    expect((await req(user.cookie, "PUT", "/api/admin/legal", full)).statusCode).toBe(403);
    // Изменение с чужого сайта отклоняется до проверки прав.
    const admin = await login(1);
    expect((await req(admin.cookie, "PUT", "/api/admin/legal", full, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect(await getLegal(t.app.ctx)).toEqual(emptyLegal);
  });

  it("GET отдаёт все поля, PUT заменяет их целиком и приводит значения к виду для страниц", async () => {
    const admin = await login(1);
    expect((await req(admin.cookie, "GET", "/api/admin/legal")).json()).toEqual(emptyLegal);
    const saved = (
      await req(admin.cookie, "PUT", "/api/admin/legal", { ...full, telegram: "https://t.me/Invito_Support/", address: "  Ташкент,\n  ул. Навои, 1  ", email: " support@invito.uz " })
    ).json();
    expect(saved).toEqual({ ...full, telegram: "Invito_Support", address: "Ташкент, ул. Навои, 1" });
    expect((await req(admin.cookie, "GET", "/api/admin/legal")).json()).toEqual(saved);
    // Поля, которых нет в запросе, очищаются.
    expect((await req(admin.cookie, "PUT", "/api/admin/legal", { phone: "+998 71 200-00-00" })).json()).toEqual({ ...emptyLegal, phone: "+998 71 200-00-00" });
  });

  it("проверка данных: email, Telegram, длина, лишние поля и типы", async () => {
    const admin = await login(1);
    const bad = async (body: unknown, lang = "ru") => {
      const res = await req(admin.cookie, "PUT", "/api/admin/legal", body, { "x-lang": lang });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      return res.json().error as string;
    };
    expect(await bad({ email: "not-an-email" })).toBe("Email: адрес вида name@example.com");
    expect(await bad({ email: "not-an-email" }, "uz")).toBe("Elektron pochta: name@example.com ko‘rinishidagi manzil");
    expect(await bad({ email: "not-an-email" }, "en")).toBe("Email: an address like name@example.com");
    expect(await bad({ telegram: "@ab" })).toBe("Telegram: имя пользователя, например @invito_support");
    expect(await bad({ telegram: "javascript:alert(1)" }, "uzc")).toBe("Telegram: фойдаланувчи номи, масалан @invito_support");
    expect(await bad({ companyName: "x".repeat(201) })).toBe("Неверные данные");
    expect(await bad({ bankAccount: "1".repeat(41) })).toBe("Неверные данные");
    expect(await bad({ inn: 309876543 })).toBe("Неверные данные");
    expect(await bad({ ...full, website: "https://evil.example" })).toBe("Неверные данные");
    expect(await bad(null)).toBe("Неверные данные");
    expect(await getLegal(t.app.ctx)).toEqual(emptyLegal);
  });
});

describe("renderLegalPage", () => {
  const env = (over: Partial<LegalEnv> = {}): LegalEnv => ({ lang: "ru", legal: emptyLegal, appUrl: "https://invitebloom.tech", appName: "Invito", bot: null, ...over });

  it("язык из ?lang=: по умолчанию и для неизвестного — русский", () => {
    expect(legalLocale(undefined)).toBe("ru");
    expect(legalLocale(["uz"])).toBe("ru");
    expect(legalLocale("xx")).toBe("ru");
    expect(legalLocale("uz")).toBe("uz");
    expect(legalLocale("uzc")).toBe("uzc");
    expect(legalLocale("EN")).toBe("en");
  });

  it("переключатель языка, альтернативные адреса и ссылки на другие документы", () => {
    const html = renderLegalPage("privacy", env({ lang: "uz" }));
    expect(html).toContain('<a href="/privacy?lang=uz" hreflang="uz-Latn" lang="uz-Latn" aria-current="page">UZ</a>');
    expect(html).toContain('<a href="/privacy" hreflang="ru" lang="ru">RU</a>');
    for (const [l, q] of [["ru", ""], ["uz-Latn", "?lang=uz"], ["uz-Cyrl", "?lang=uzc"], ["en", "?lang=en"]]) {
      expect(html).toContain(`<link rel="alternate" hreflang="${l}" href="https://invitebloom.tech/privacy${q}">`);
    }
    expect(html).toContain('<a href="/oferta?lang=uz">Oferta</a>');
    expect(html).toContain('<a href="/contacts?lang=uz">Kontaktlar</a>');
    expect(html).toContain('<a href="https://invitebloom.tech/">invitebloom.tech</a> sayti foydalanuvchilari');
  });

  it("оглавление и нумерация пунктов у оферты и политики, у контактов — нет", () => {
    const oferta = renderLegalPage("oferta", env());
    const sections = legalTexts.ru.docs.oferta.sections;
    expect([...oferta.matchAll(/<section id="(\w+)">/g)].map((m) => m[1])).toEqual(sections.map((s) => s.id));
    expect(oferta).toContain('<h2><span class="num">6.</span><span>Возврат денег</span></h2>');
    expect(oferta).toContain('<span class="pn">6.1</span>');
    expect(oferta).toContain('<a href="#refunds">Возврат денег</a>');
    expect(oferta).toContain("Редакция от 20 октября 2026 г.");
    const contacts = renderLegalPage("contacts", env());
    expect(contacts).not.toContain('class="pn"');
    expect(contacts).not.toContain('class="toc');
    // Без бота строки «Telegram-бот» нет.
    expect(contacts).not.toContain('data-field="bot"');
  });

  it("английский перевод с пометкой о приоритете русского и узбекского текстов", () => {
    const html = renderLegalPage("oferta", env({ lang: "en" }));
    expect(html).toContain("the administration of the invitebloom.tech website (the “Provider”)");
    expect(html).toContain("those versions prevail");
    expect(renderLegalPage("oferta", env())).not.toContain('class="note"');
  });

  it("телефон становится ссылкой tel: только с полным номером", () => {
    const rows = (phone: string) => renderLegalPage("contacts", env({ legal: { ...emptyLegal, phone } }));
    expect(rows("90 123 45 67")).toContain('<a href="tel:+998901234567">90 123 45 67</a>');
    expect(rows("+998 (71) 200-00-00")).toContain('href="tel:+998712000000"');
    expect(rows("1234")).toContain("<dd>1234</dd>");
    // Добавочный номер и текст вокруг номера в ссылку не попадают.
    expect(rows("+998 71 200-00-00 (доб. 105)")).toContain('<a href="tel:+998712000000">+998 71 200-00-00 (доб. 105)</a>');
    expect(rows("javascript:alert(4) +998 90 123 45 67")).toContain('href="tel:+998901234567"');
    expect(rows("+998 90 123 45 67, +998 71 200 00 00")).toContain('href="tel:+998901234567"');
  });
});
