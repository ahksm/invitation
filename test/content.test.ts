import { describe, expect, it } from "vitest";
import { coerceContent, contentSchema, isMediaUrl, sectionOn } from "../src/content.js";
import { EVENT_ORDER, EVENTS, SECTIONS, STYLES, TEMPLATES, TRACKS, slugify, toCyr } from "../src/design-data.js";
import { bt, pickLocale, requestLocale, translateError } from "../src/i18n.js";
import { parseRange } from "../src/routes/media.js";
import { sniffMedia } from "../src/services/media.js";
import { isPreviewBot, longDate, shortName } from "../src/services/public.js";
import { inviteText, otpText } from "../src/sms/texts.js";
import { hasUrl, mapLink, mapSearch, mapText } from "../web/invito-engine.js";
import { samples } from "./helpers.js";

describe("данные дизайна", () => {
  it("загружаются из web/invito-data.js", () => {
    expect(TEMPLATES).toHaveLength(60);
    expect(TEMPLATES[0]).toEqual({ id: "wedding-classic", event: "wedding", style: "classic", name: "Ivory" });
    expect(EVENT_ORDER).toHaveLength(12);
    expect(EVENTS.wedding!.label).toMatchObject({ ru: "Свадьба", uz: "To‘y", uzc: "Тўй", en: "Wedding" });
    expect(STYLES.classic!.fonts[0]).toBe("Cormorant Garamond");
    expect(SECTIONS).toContain("guestbook");
    expect(TRACKS).toContain("waltz");
    expect(slugify("Анна и Тимур")).toBe("anna-i-timur");
  });

  it("toCyr: «yo‘» → «йў» при любом апострофе, остальное как раньше", () => {
    expect(toCyr("yo‘nalish")).toBe("йўналиш");
    expect(toCyr("yo'l")).toBe("йўл");
    expect(toCyr("yoʻq")).toBe("йўқ");
    expect(toCyr("Yo‘q")).toBe("Йўқ");
    expect(toCyr("YO‘L")).toBe("ЙЎЛ");
    expect(toCyr("yoz")).toBe("ёз");
    expect(toCyr("Yoshlar")).toBe("Ёшлар");
    expect(toCyr("To‘y")).toBe("Тўй");
    expect(toCyr("o‘g‘il")).toBe("ўғил");
    expect(toCyr("Telegram orqali kirish")).toBe("Telegram орқали кириш");
    expect(toCyr("ertaga choy")).toBe("эртага чой");
    // Названия сервисов и карт остаются латиницей (вопросы и ответы на главной).
    expect(toCyr("Havolani WhatsApp yoki Telegram orqali yuboring")).toBe("Ҳаволани WhatsApp ёки Telegram орқали юборинг");
    expect(toCyr("Multicard, Uzcard yoki Humo karta")).toBe("Multicard, Uzcard ёки Humo карта");
  });
});

describe("языки", () => {
  it("uzc выбирается по коду и по Accept-Language", () => {
    expect(pickLocale("uzc")).toBe("uzc");
    expect(pickLocale("uz-Cyrl-UZ")).toBe("uzc");
    expect(pickLocale("uz")).toBe("uz");
    expect(pickLocale("en-US")).toBe("en");
    expect(pickLocale("de")).toBe("ru");
    expect(requestLocale({ "accept-language": "uz-Cyrl-UZ,uz;q=0.9" })).toBe("uzc");
    expect(requestLocale({ "x-lang": "uzc" })).toBe("uzc");
  });

  it("ошибки, тексты бота и SMS на uzc получаются из uz", () => {
    expect(translateError("Неверный или устаревший код", "uzc")).toBe("Код нотўғри ёки эскирган");
    expect(translateError("Эта ссылка уже занята", "uzc")).toBe("Бу ҳавола банд");
    expect(translateError("Эта ссылка уже занята", "en")).toBe("This link is already taken");
    // Подстановки и команды бота не транслитерируются.
    expect(bt("uzc", "phoneLinked", { phone: "+998 90 123-45-67" })).toBe("+998 90 123-45-67 рақами уланди.");
    expect(bt("uzc", "unknown")).toBe("Буйруқ тушунарсиз. Мавжуд: /login, /my, /prices, /lang");
    expect(otpText("uzc", "Invito", "123456")).toBe("Invito: кириш коди 123456. Бу кодни ҳеч кимга берманг.");
    const link = "https://example.uz/g/Abc_def-12";
    expect(inviteText("uzc", { guestName: "Aziz", event: "Анна ва Темур", date: "12.12.2026", link })).toBe(
      `Aziz, сизни таклиф қиламиз: Анна ва Темур, 12.12.2026. Таклифномангиз: ${link}`,
    );
    expect(inviteText("uzc", { guestName: "Aziz", event: "Тўй", link })).toBe(`Aziz, сизни таклиф қиламиз: Тўй. Таклифномангиз: ${link}`);
    expect(inviteText("ru", { guestName: "Азиз", event: "Анна и Тимур", date: "12.12.2026", link })).toBe(
      `Азиз, приглашаем вас: Анна и Тимур, 12.12.2026. Ваше приглашение: ${link}`,
    );
  });
});

describe("содержимое приглашения (InvContent)", () => {
  const media = "/media/3f0c5a4e-8a2b-4c1d-9e7f-0123456789ab.jpg";
  const unsplash = "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=900&q=70";

  it("MediaUrl: свои файлы и Unsplash, остальное нельзя", () => {
    expect(isMediaUrl(media)).toBe(true);
    expect(isMediaUrl(unsplash)).toBe(true);
    for (const bad of [
      "data:image/png;base64,AAAA",
      "blob:http://localhost/123",
      "https://evil.example/x.jpg",
      "https://images.unsplash.com.evil.example/x",
      "https://images.unsplash.com@evil.example/x",
      "http://images.unsplash.com/photo-1",
      "/media/../etc/passwd",
      "/media/3f0c5a4e-8a2b-4c1d-9e7f-0123456789ab.svg",
      "https://images.unsplash.com/x');background:url('//evil",
      "javascript:alert(1)",
    ]) {
      expect(isMediaUrl(bad), bad).toBe(false);
    }
    const schema = contentSchema("classic");
    expect(() => schema.parse({ cover: "data:image/png;base64,AAAA" })).toThrow();
    expect(() => schema.parse({ gallery: [media, "https://evil.example/x.jpg"] })).toThrow();
    expect(schema.parse({ cover: "", musicSrc: "", video: "", gallery: [media, unsplash] })).toMatchObject({ cover: "", gallery: [media, unsplash] });
  });

  it("проверяет ограничения полей и отбрасывает лишние ключи", () => {
    const schema = contentSchema("classic");
    const ok = schema.parse({
      names: "Анна и Тимур",
      dressColors: ["#AABBCC"],
      program: [
        { time: "16:00", title: "Сбор гостей", place: null },
        { time: "", title: "Ужин" },
        { time: "17:30", title: "Фото", place: "Парк", address: "https://yandex.uz/maps/-/CDabc", extra: 1 },
      ],
      date: "2026-12-26",
      time: "18:30",
      rsvpBy: "2026-12-10",
      palette: 2,
      music: "custom",
      intro: "scratch",
      mapMode: "real",
      motion: "still",
      countdown: false,
      extra: "лишнее",
    });
    expect(ok).not.toHaveProperty("extra");
    expect(ok.dressColors).toEqual(["#aabbcc"]);
    expect(ok.rsvpBy).toBe("2026-12-10");
    expect(schema.parse({ rsvpBy: "" })).toEqual({ rsvpBy: "" });
    expect(ok.program).toEqual([
      { time: "16:00", title: "Сбор гостей", place: "", address: "" },
      { time: "", title: "Ужин", place: "", address: "" },
      { time: "17:30", title: "Фото", place: "Парк", address: "https://yandex.uz/maps/-/CDabc" },
    ]);
    const bad: Record<string, unknown>[] = [
      { names: "x".repeat(201) },
      { message: "x".repeat(3001) },
      { gifts: "x".repeat(1001) },
      { dressColors: ["red"] },
      { dressColors: Array(7).fill("#000000") },
      { program: Array(9).fill({ time: "", title: "x" }) },
      { program: [{ time: "25:00", title: "x" }] },
      { program: [{ time: "", title: "x", address: "x".repeat(301) }] },
      { program: [{ time: "", title: "x", address: 5 }] },
      { date: "2026-02-30" },
      { date: "26.12.2026" },
      { time: "7:00" },
      { rsvpBy: "2026-13-01" },
      { rsvpBy: "10.12.2026" },
      { rsvpBy: null },
      { palette: 3 },
      { palette: 1.5 },
      { music: "rock" },
      { intro: "fade" },
      { mapMode: "satellite" },
      { motion: "fast" },
      { countdown: "yes" },
      { gallery: Array(13).fill(media) },
      { sections: [{ k: "unknown", on: true }] },
    ];
    for (const b of bad) expect(() => schema.parse(b), JSON.stringify(b).slice(0, 80)).toThrow();
  });

  it("подставляет первый шрифт стиля, если шрифта у стиля нет", () => {
    expect(contentSchema("classic").parse({ font: "Prata" }).font).toBe("Prata");
    expect(contentSchema("classic").parse({ font: "Comic Sans" }).font).toBe("Cormorant Garamond");
    expect(contentSchema("neon").parse({ font: "Prata" }).font).toBe("Unbounded");
    // У старых шаблонов без стиля шрифт не проверяется.
    expect(contentSchema(null).parse({ font: "Comic Sans" }).font).toBe("Comic Sans");
  });

  it("убирает повторы секций и дописывает недостающие выключенными", () => {
    const d = contentSchema("classic").parse({
      sections: [
        { k: "rsvp", on: true },
        { k: "message", on: true },
        { k: "rsvp", on: false },
      ],
    });
    expect(d.sections!.map((s) => s.k)).toEqual(["rsvp", "message", ...SECTIONS.filter((k) => k !== "rsvp" && k !== "message")]);
    expect(d.sections![0]).toEqual({ k: "rsvp", on: true });
    expect(d.sections!.slice(2).every((s) => !s.on)).toBe(true);
    expect(sectionOn(d, "rsvp")).toBe(true);
    expect(sectionOn(d, "who")).toBe(false);
    // Без списка секций действуют значения дизайна.
    expect(sectionOn({}, "who")).toBe(true);
    expect(sectionOn({}, "reveal")).toBe(false);
  });

  it("старые данные из базы читаются без ошибок", () => {
    expect(coerceContent({ hosts: "A & B", event: "to'y", date: "2026-12-12", names: 5, time: "18:00" }, "classic")).toEqual({
      date: "2026-12-12",
      time: "18:00",
    });
    expect(coerceContent(null, "classic")).toEqual({});
  });
});

describe("ссылки остановок маршрута (web/invito-engine.js)", () => {
  it("ссылкой становится только https-адрес карты из списка, как его записывает URL", () => {
    for (const ok of [
      "https://yandex.uz/maps/-/CDabc",
      "https://yandex.ru/maps/?ll=69.24,41.31&z=16",
      "https://maps.yandex.com/?text=Oqsaroy",
      "https://maps.app.goo.gl/AbCdEf",
      "https://goo.gl/maps/xyz",
      "https://www.google.com/maps/place/Oqsaroy",
      "https://google.co.uz/maps?q=1",
      "https://maps.google.ru/?q=1",
      "https://2gis.uz/tashkent/firm/123",
      "https://go.2gis.com/abc",
    ]) {
      expect(mapLink(ok), ok).toBe(new URL(ok).href);
    }
    for (const bad of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://yandex.uz/maps/-/CDabc",
      "https://yandex.uz.evil.example/maps",
      "https://evil.example/yandex.uz",
      "https://evilyandex.uz/maps",
      "https://yandex.com.evil/maps",
      "https://user:pw@yandex.uz/maps",
      "https://yandex.uz:8443/maps",
      "https://www.google.com/search?q=1",
      "https://goo.gl/abc",
      "www.yandex.uz/maps",
      "ул. Навои, 1",
      "https://yandex.uz/maps/" + "x".repeat(300),
    ]) {
      expect(mapLink(bad), bad).toBe("");
    }
    // Ссылка внутри текста и после чужой ссылки; хвостовая пунктуация — не часть адреса.
    expect(mapLink("ул. Навои, 1 (https://yandex.uz/maps/-/CDx).")).toBe("https://yandex.uz/maps/-/CDx");
    expect(mapLink("https://evil.example/x https://maps.app.goo.gl/abc")).toBe("https://maps.app.goo.gl/abc");
    // Обратная косая черта не уводит на другой хост: адрес остаётся на yandex.uz.
    expect(mapLink("https://yandex.uz\\@evil.example")).toBe("https://yandex.uz/@evil.example");
  });

  it("текст адреса без ссылок, поиск по Яндекс Картам", () => {
    expect(mapText("ул. Навои, 1 (https://yandex.uz/maps/-/CDx).")).toBe("ул. Навои, 1");
    expect(mapText("javascript:alert(1)")).toBe("");
    expect(mapText("http://maps.google.com/?q=x")).toBe("");
    expect(mapText("Toshkent: Navoiy ko‘chasi, 1 (hovli tomondan)")).toBe("Toshkent: Navoiy ko‘chasi, 1 (hovli tomondan)");
    expect(hasUrl("Toshkent: Navoiy ko‘chasi, 1")).toBe(false);
    expect(hasUrl("javascript:alert(1)")).toBe(true);
    expect(hasUrl("см. www.example.com")).toBe(true);
    expect(mapSearch("ЗАГС, ул. Навои 1")).toBe("https://yandex.uz/maps/?text=" + encodeURIComponent("ЗАГС, ул. Навои 1"));
    expect(mapSearch("  ")).toBe("");
  });
});

describe("файлы", () => {
  it("тип определяется по сигнатуре", () => {
    expect(sniffMedia(samples.jpeg)).toEqual({ kind: "image", mime: "image/jpeg", ext: "jpg" });
    expect(sniffMedia(samples.png)?.ext).toBe("png");
    expect(sniffMedia(samples.gif)?.ext).toBe("gif");
    expect(sniffMedia(samples.webp)?.ext).toBe("webp");
    expect(sniffMedia(samples.mp3)).toEqual({ kind: "audio", mime: "audio/mpeg", ext: "mp3" });
    expect(sniffMedia(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]))?.ext).toBe("mp3");
    expect(sniffMedia(samples.m4a)).toEqual({ kind: "audio", mime: "audio/mp4", ext: "m4a" });
    expect(sniffMedia(samples.ogg)?.ext).toBe("ogg");
    expect(sniffMedia(samples.wav)?.ext).toBe("wav");
    expect(sniffMedia(samples.mp4)).toEqual({ kind: "video", mime: "video/mp4", ext: "mp4" });
    expect(sniffMedia(samples.mov)?.ext).toBe("mov");
    expect(sniffMedia(samples.webm)?.ext).toBe("webm");
    expect(sniffMedia(samples.svg)).toBeNull();
    expect(sniffMedia(samples.html)).toBeNull();
    expect(sniffMedia(Buffer.alloc(0))).toBeNull();
  });

  it("разбирает заголовок Range", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=9-0", 100)).toBe("invalid");
    expect(parseRange("bytes=-", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });
});

describe("публичные страницы", () => {
  it("сокращает имена гостей", () => {
    expect(shortName("Анна Каримова")).toBe("Анна К.");
    expect(shortName("  Dilnoza   Karimova Akmalovna ")).toBe("Dilnoza K.");
    expect(shortName("Азиз")).toBe("Азиз");
  });

  it("пишет длинную дату на языке приглашения по Ташкенту", () => {
    expect(longDate("2026-12-12", "ru")).toBe("12 декабря 2026 г.");
    expect(longDate("2026-12-12", "en")).toBe("12 December 2026");
    expect(longDate("2026-01-01", "uz")).toContain("2026");
    expect(longDate("2026-01-01", "uzc")).toMatch(/январ/);
  });

  it("узнаёт сборщики превью ссылок", () => {
    expect(isPreviewBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isPreviewBot("WhatsApp/2.23.20.0")).toBe(true);
    expect(isPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPreviewBot(undefined)).toBe(false);
  });
});
