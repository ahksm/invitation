import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebAppInitData } from "../src/auth/telegram.js";
import { contactPhone } from "../src/bot/index.js";
import { createEskiz, ESKIZ_TEST_TEXT } from "../src/sms/eskiz.js";
import { createMulticardProvider, multicardSign, parseMulticardTime } from "../src/payments/multicard.js";
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
    expect(translateError("Неверный или устаревший код", "uz")).toBe("Kod noto‘g‘ri yoki eskirgan");
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
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "DELIVERED" })?.status).toBe("delivered");
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "PARTDELIVERED" })?.status).toBe("delivered");
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "ACCEPTED" })?.status).toBe("sent");
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "REJECTED" })?.status).toBe("failed");
    expect(eskiz.parseDelivery({ request_id: "sms-1", status: "UNDELIV" })?.status).toBe("failed");
  });

  it("в тестовом режиме отправляет разрешённую фразу, а текст пишет в лог", async () => {
    const store = new Map<string, string>();
    const cache = createCache({ get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v), del: async () => {} } as never);
    const sent: Record<string, string>[] = [];
    const logged: unknown[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/auth/login")) return Response.json({ data: { token: "t" } });
      sent.push(Object.fromEntries((init?.body as FormData).entries()) as Record<string, string>);
      return Response.json({ id: "sms-2", status: "waiting" });
    };
    const eskiz = createEskiz({ baseUrl: "https://e.test/api", email: "e", password: "p", from: "4546", testMode: { log: { info: (o: unknown) => logged.push(o) } as never }, cache, fetch: fakeFetch });
    await eskiz.send("998901234567", "Invitations: код для входа 123456");
    expect(sent[0]!.message).toBe(ESKIZ_TEST_TEXT);
    expect(logged).toEqual([{ phone: "998901234567", text: "Invitations: код для входа 123456" }]);
  });
});

describe("Multicard", () => {
  it("читает срок токена в GMT+5", () => {
    expect(parseMulticardTime("2026-10-19 17:00:00")).toBe(Date.parse("2026-10-19T12:00:00Z"));
    expect(Number.isNaN(parseMulticardTime("завтра"))).toBe(true);
  });

  it("перевыпускает токен после 401 и требует коды для чека", async () => {
    const store = new Map<string, string>();
    const cache = createCache({ get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v), del: async (...ks: string[]) => ks.forEach((k) => store.delete(k)) } as never);
    const auths: string[] = [];
    let invoices = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/auth")) {
        auths.push("x");
        return Response.json({ token: `tok${auths.length}`, expiry: "2099-01-01 00:00:00" });
      }
      invoices++;
      if (new Headers(init?.headers).get("authorization") === "Bearer tok1") return Response.json({ success: false }, { status: 401 });
      return Response.json({ success: true, data: { uuid: "u-1", checkout_url: "https://checkout.test/1" } });
    };
    const base = { baseUrl: "https://mc.test", applicationId: "a", secret: "s", storeId: "6", cache, fetch: fakeFetch };
    const request = {
      order: { id: "o", number: 1000, amount: 1_000_000, currency: "UZS" },
      items: [{ title: "Персональное приглашение (1 гость)", quantity: 2, unitPrice: 500_000 }],
      callbackUrl: "https://app.test/cb",
      returnUrl: "https://app.test/r",
    };
    await expect(createMulticardProvider(base).createCheckout(request)).rejects.toThrow("MULTICARD_MXIK");

    const mc = createMulticardProvider({ ...base, mxik: "1", packageCode: "2" });
    expect(await mc.createCheckout(request)).toEqual({ checkoutUrl: "https://checkout.test/1", providerRef: "u-1" });
    expect(auths.length).toBe(2);
    expect(invoices).toBe(2);
    await expect(mc.createCheckout({ ...request, order: { ...request.order, amount: 999 } })).rejects.toThrow("не равна сумме заказа");
  });
});
