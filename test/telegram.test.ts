import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebAppInitData } from "../src/auth/telegram.js";
import { contactPhone } from "../src/bot/index.js";
import { createEskiz } from "../src/sms/eskiz.js";
import { multicardSign } from "../src/payments/multicard.js";
import { normalizePhone } from "../src/services/phone.js";
import { translateError } from "../src/i18n.js";
import { createCache } from "../src/cache.js";

const botToken = "123:abc";

export function signInitData(fields: Record<string, string>, token = botToken) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("мини-апп Telegram", () => {
  const now = Date.now();
  const fields = { auth_date: String(Math.floor(now / 1000)), query_id: "q1", user: JSON.stringify({ id: 42, first_name: "Ali", language_code: "uz" }) };

  it("принимает правильную подпись", () => {
    expect(verifyWebAppInitData(signInitData(fields), botToken, now)).toMatchObject({ id: 42, language_code: "uz" });
  });

  it("отклоняет подделку, чужой токен и устаревшие данные", () => {
    const tampered = signInitData(fields).replace("%22id%22%3A42", "%22id%22%3A43");
    expect(verifyWebAppInitData(tampered, botToken, now)).toBeNull();
    expect(verifyWebAppInitData(signInitData(fields, "999:other"), botToken, now)).toBeNull();
    const old = { ...fields, auth_date: String(Math.floor(now / 1000) - 90_000) };
    expect(verifyWebAppInitData(signInitData(old), botToken, now)).toBeNull();
  });
});

describe("номера телефонов", () => {
  it("приводит узбекские номера к 998XXXXXXXXX", () => {
    expect(normalizePhone("+998 (90) 123-45-67")).toBe("998901234567");
    expect(normalizePhone("901234567")).toBe("998901234567");
    expect(normalizePhone("+7 999 123 45 67")).toBeNull();
    expect(contactPhone("+7 999 123 45 67")).toBe("79991234567");
  });
});

describe("подпись Multicard", () => {
  it("md5(store_id + invoice_id + amount + secret)", () => {
    expect(multicardSign(6, "1000", 500000, "s")).toBe(createHash("md5").update("61000500000s").digest("hex"));
  });
});

describe("переводы ошибок", () => {
  it("переводит известные и оставляет неизвестные", () => {
    expect(translateError("Неверный или устаревший код", "uz")).toBe("Kod noto'g'ri yoki eskirgan");
    expect(translateError("Неверный или устаревший код", "en")).toBe("Wrong or expired code");
    expect(translateError("Что-то новое", "en")).toBe("Что-то новое");
  });
});

describe("Eskiz", () => {
  it("получает токен, отправляет SMS и повторяет после 401", async () => {
    const store = new Map<string, string>();
    const fakeRedis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      del: async (...ks: string[]) => ks.forEach((k) => store.delete(k)),
    };
    const cache = createCache(fakeRedis as never);
    const calls: { url: string; auth: string | null; form: Record<string, string> }[] = [];
    let logins = 0;
    let first = true;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const form = Object.fromEntries((init?.body as FormData).entries()) as Record<string, string>;
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), form });
      if (url.endsWith("/auth/login")) return Response.json({ data: { token: `tok${++logins}` } });
      if (first) {
        first = false;
        return new Response("expired", { status: 401 });
      }
      return Response.json({ id: "sms-1", status: "waiting" });
    };
    const eskiz = createEskiz({ baseUrl: "https://e.test/api", email: "e", password: "p", from: "4546", cache, fetch: fakeFetch });
    expect(await eskiz.send("998901234567", "hi", { callbackUrl: "https://x/cb" })).toEqual({ providerRef: "sms-1" });
    expect(logins).toBe(2);
    const last = calls.at(-1)!;
    expect(last.auth).toBe("Bearer tok2");
    expect(last.form).toMatchObject({ mobile_phone: "998901234567", message: "hi", from: "4546", callback_url: "https://x/cb" });
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "DELIVRD" })).toEqual({ providerRef: "sms-1", status: "delivered" });
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "UNDELIV" })?.status).toBe("failed");
  });
});
