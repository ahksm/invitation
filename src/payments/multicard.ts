import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Cache } from "../cache.js";
import { cacheKeys } from "../cache.js";
import type { PaymentProvider } from "./types.js";

/**
 * Интеграция с Multicard (https://docs.multicard.uz/).
 *
 * Схема:
 * 1. POST {base}/auth { application_id, secret } -> { token, expiry }; токен передаётся как Bearer.
 * 2. POST {base}/payment/invoice -> { success, data: { uuid, checkout_url } }; пользователя отправляем на checkout_url.
 * 3. После оплаты Multicard шлёт POST на callback_url с полем sign = md5(store_id + invoice_id + amount + secret).
 *
 * ВНИМАНИЕ: названия полей и формула подписи взяты не из документации напрямую
 * (сайт был недоступен из окружения разработки); сверить с docs.multicard.uz перед запуском.
 * Суммы передаются в тийинах.
 */
export type MulticardOptions = {
  baseUrl: string;
  applicationId: string;
  secret: string;
  storeId: string;
  mxik?: string | undefined;
  packageCode?: string | undefined;
  cache: Cache;
  fetch?: typeof fetch;
};

const authResponse = z.object({ token: z.string().min(1), expiry: z.string().optional() });
const invoiceResponse = z.object({
  success: z.literal(true),
  data: z.object({ uuid: z.string(), checkout_url: z.url() }),
});
const callbackSchema = z.object({
  store_id: z.union([z.string(), z.number()]),
  invoice_id: z.union([z.string(), z.number()]),
  amount: z.union([z.string(), z.number()]),
  uuid: z.string().optional(),
  invoice_uuid: z.string().optional(),
  sign: z.string(),
});

export function multicardSign(storeId: string | number, invoiceId: string | number, amount: string | number, secret: string) {
  return createHash("md5").update(`${storeId}${invoiceId}${amount}${secret}`).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createMulticardProvider(opts: MulticardOptions): PaymentProvider {
  const http = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function token(): Promise<string> {
    const cached = await opts.cache.get<string>(cacheKeys.multicardToken);
    if (cached) return cached;
    const res = await http(`${base}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ application_id: opts.applicationId, secret: opts.secret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Multicard auth: HTTP ${res.status}`);
    const { token, expiry } = authResponse.parse(await res.json());
    const expiresIn = expiry ? Math.floor((Date.parse(expiry) - Date.now()) / 1000) : NaN;
    // Обновляем токен заранее, за 10 минут до истечения; если срок неизвестен, держим час.
    const ttl = Number.isFinite(expiresIn) ? Math.max(60, expiresIn - 600) : 3600;
    await opts.cache.set(cacheKeys.multicardToken, token, ttl);
    return token;
  }

  return {
    name: "multicard",

    async createCheckout({ order, items, callbackUrl, returnUrl }) {
      const ofd = opts.mxik
        ? items.map((i) => ({
            name: i.title,
            qty: i.quantity,
            price: i.unitPrice,
            total: i.unitPrice * i.quantity,
            mxik: opts.mxik,
            package_code: opts.packageCode,
            vat: 0,
          }))
        : undefined;
      const res = await http(`${base}/payment/invoice`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({
          store_id: Number(opts.storeId),
          amount: order.amount,
          invoice_id: String(order.number),
          callback_url: callbackUrl,
          return_url: returnUrl,
          lang: "ru",
          ...(ofd ? { ofd } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) await opts.cache.del(cacheKeys.multicardToken);
      const json = await res.json().catch(() => null);
      const parsed = invoiceResponse.safeParse(json);
      if (!res.ok || !parsed.success) {
        throw new Error(`Multicard invoice: HTTP ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`);
      }
      return { checkoutUrl: parsed.data.data.checkout_url, providerRef: parsed.data.data.uuid };
    },

    async verifyWebhook(body) {
      const parsed = callbackSchema.safeParse(body);
      if (!parsed.success) return null;
      const cb = parsed.data;
      if (String(cb.store_id) !== String(opts.storeId)) return null;
      const expected = multicardSign(cb.store_id, cb.invoice_id, cb.amount, opts.secret);
      if (!safeEqualHex(expected, cb.sign)) return null;
      const orderNumber = Number(cb.invoice_id);
      const amount = Number(cb.amount);
      if (!Number.isInteger(orderNumber) || !Number.isInteger(amount)) return null;
      // Multicard присылает этот колбэк только при успешной оплате.
      return { orderNumber, amount, status: "paid", providerRef: cb.invoice_uuid ?? cb.uuid, raw: body };
    },

    webhookAck(ok, message) {
      return ok ? { status: 200, body: { success: true } } : { status: 400, body: { success: false, message } };
    },
  };
}
