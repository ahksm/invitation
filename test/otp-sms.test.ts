import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCache } from "../src/cache.js";
import { smsMessages } from "../src/db/schema.js";
import { createEskiz } from "../src/sms/eskiz.js";
import { otpText } from "../src/sms/texts.js";
import { SmsRejectedError, type SmsProvider } from "../src/sms/types.js";
import { testContext } from "./helpers.js";

/**
 * Тексты SMS с кодом входа. Eskiz пропускает только одобренные шаблоны, а одобренный текст совпадает с отправленным
 * до символа, кроме цифр кода. Поэтому здесь проверяются точные строки, поданные на модерацию 21.10.2026.
 */

const SITE = "https://invitebloom.tech";
const t = testContext({ APP_URL: SITE });
const { smsSent, redis } = t;
const req = (lang: string, phone: string) =>
  t.app.inject({ method: "POST", url: "/api/auth/phone/request", payload: { phone }, headers: { origin: SITE, "x-lang": lang } });

const EXPECTED = {
  uz: "invitebloom.tech saytiga kirish uchun tasdiqlash kodi: 730164. Kodni hech kimga bermang.",
  uzc: "invitebloom.tech сайтига кириш учун тасдиқлаш коди: 730164",
  ru: "Код подтверждения для входа на сайт invitebloom.tech: 730164",
  en: "Verification code to sign in to the invitebloom.tech website: 730164. Do not share it with anyone.",
} as const;
const LANGS = Object.keys(EXPECTED) as (keyof typeof EXPECTED)[];

// Символы GSM 03.38 без расширенной таблицы: такой текст идёт по 160 символов в SMS.
const GSM = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r]*$/;

let realSms: SmsProvider;

beforeAll(async () => {
  await t.start();
  realSms = t.app.ctx.sms;
});

beforeEach(async () => {
  await redis.flushdb();
  smsSent.length = 0;
  t.app.ctx.sms = realSms;
});

afterAll(async () => {
  await t.close();
});

const memoryCache = () => {
  const store = new Map<string, string>();
  return createCache({ get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v), del: async () => {} } as never);
};

/** Eskiz с подменённой сетью: reject решает по тексту, отказать ли (HTTP 400, как для неодобренного шаблона). */
function fakeEskiz(reject: (text: string) => boolean | "network") {
  const attempts: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/auth/login")) return Response.json({ data: { token: "t" } });
    const text = String((init?.body as FormData).get("message"));
    attempts.push(text);
    const r = reject(text);
    if (r === "network") throw new TypeError("fetch failed");
    if (r) return Response.json({ status: "error", message: "Этот смс текст еще не прошел модерацию" }, { status: 400 });
    return Response.json({ id: `sms-${attempts.length}`, status: "waiting" });
  };
  const sms = createEskiz({ baseUrl: "https://e.test/api", email: "e", password: "p", from: "4546", cache: memoryCache(), fetch });
  return { sms, attempts };
}

const lastOtpRow = async () => (await t.db.select().from(smsMessages).where(eq(smsMessages.purpose, "otp"))).at(-1)!;

describe("тексты кода входа", () => {
  it("совпадают с поданными в Eskiz на всех языках", () => {
    for (const lang of LANGS) expect(otpText(lang, "invitebloom.tech", "730164"), lang).toBe(EXPECTED[lang]);
  });

  it("помещаются в одно SMS: латиница в GSM до 160 символов, кириллица до 70", () => {
    for (const lang of LANGS) {
      const text = otpText(lang, "invitebloom.tech", "000000");
      if (GSM.test(text)) expect(text.length, lang).toBeLessThanOrEqual(160);
      else expect(text.length, lang).toBeLessThanOrEqual(70);
    }
    expect(GSM.test(EXPECTED.uz) && GSM.test(EXPECTED.en)).toBe(true);
  });

  it("сайт берётся из APP_URL и в кириллице не транслитерируется", async () => {
    for (const [i, lang] of LANGS.entries()) {
      smsSent.length = 0;
      expect((await req(lang, `99893777000${i}`)).statusCode, lang).toBe(200);
      const code = /\b(\d{6})\b/.exec(smsSent[0]!.text)![1]!;
      expect(smsSent[0]!.text, lang).toBe(EXPECTED[lang].replace("730164", code));
    }
  });
});

describe("пока Eskiz не одобрил текст на языке человека", () => {
  it("код уходит текстом на узбекской латинице, и войти можно", async () => {
    const eskiz = fakeEskiz((text) => text !== otpText("uz", "invitebloom.tech", /\d{6}/.exec(text)![0]));
    t.app.ctx.sms = eskiz.sms;
    expect((await req("ru", "998937770100")).statusCode).toBe(200);
    expect(eskiz.attempts).toHaveLength(2);
    const code = /\d{6}/.exec(eskiz.attempts[0]!)![0];
    expect(eskiz.attempts).toEqual([EXPECTED.ru.replace("730164", code), EXPECTED.uz.replace("730164", code)]);
    expect(await lastOtpRow()).toMatchObject({ status: "sent", providerRef: "sms-2" });

    const res = await t.app.inject({ method: "POST", url: "/api/auth/phone/verify", payload: { phone: "998937770100", code }, headers: { origin: SITE } });
    expect(res.statusCode).toBe(200);
  });

  it("если отказан и узбекский текст, вход отвечает 502 и код сгорает", async () => {
    const eskiz = fakeEskiz(() => true);
    t.app.ctx.sms = eskiz.sms;
    expect((await req("en", "998937770101")).statusCode).toBe(502);
    expect(eskiz.attempts).toHaveLength(2);
    expect(await lastOtpRow()).toMatchObject({ status: "failed" });
    expect(await redis.exists("inv:otp:998937770101")).toBe(0);
  });

  it("узбекский текст не отправляется второй раз", async () => {
    const eskiz = fakeEskiz(() => true);
    t.app.ctx.sms = eskiz.sms;
    expect((await req("uz", "998937770102")).statusCode).toBe(502);
    expect(eskiz.attempts).toHaveLength(1);
  });

  it("ошибку сети не повторяет другим текстом: SMS могло уйти", async () => {
    const eskiz = fakeEskiz(() => "network");
    t.app.ctx.sms = eskiz.sms;
    expect((await req("ru", "998937770103")).statusCode).toBe(502);
    expect(eskiz.attempts).toHaveLength(1);
  });
});

describe("Eskiz", () => {
  it("отказ с HTTP 400 — SmsRejectedError, другие ошибки — обычные", async () => {
    const rejected = fakeEskiz(() => true);
    await expect(rejected.sms.send("998901234567", "x")).rejects.toBeInstanceOf(SmsRejectedError);

    const fetch: typeof globalThis.fetch = async (input) =>
      String(input).endsWith("/auth/login") ? Response.json({ data: { token: "t" } }) : Response.json({ message: "Internal" }, { status: 500 });
    const broken = createEskiz({ baseUrl: "https://e.test/api", email: "e", password: "p", from: "4546", cache: memoryCache(), fetch });
    const err = await broken.send("998901234567", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SmsRejectedError);
  });
});
