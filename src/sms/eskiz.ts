import { z } from "zod";
import { cacheKeys, type Cache } from "../cache.js";
import type { SmsProvider } from "./types.js";

/**
 * Eskiz (https://documenter.getpostman.com/view/663428/RzfmES4z):
 * 1. POST {base}/auth/login (form-data: email, password) -> { data: { token } }; токен живёт 30 дней.
 * 2. POST {base}/message/sms/send (form-data: mobile_phone, message, from, callback_url) -> { id, status }.
 * 3. Колбэк о доставке: { request_id, message_id, status: DELIVRD | UNDELIV | REJECTD | EXPIRED ... }.
 *
 * ВНИМАНИЕ: поля описаны по памяти (сайт Eskiz был недоступен из окружения разработки), сверить перед запуском.
 * Тексты SMS в Eskiz проходят модерацию: шаблоны из src/sms/texts.ts нужно отправить им на одобрение.
 */
export type EskizOptions = {
  baseUrl: string;
  email: string;
  password: string;
  from: string;
  cache: Cache;
  fetch?: typeof fetch;
};

const loginResponse = z.object({ data: z.object({ token: z.string().min(1) }) });
const sendResponse = z.object({ id: z.union([z.string(), z.number()]) });
const deliverySchema = z.object({
  request_id: z.union([z.string(), z.number()]).optional(),
  message_id: z.union([z.string(), z.number()]).optional(),
  status: z.string(),
});

const DELIVERED = new Set(["DELIVRD", "DELIVERED"]);
const FAILED = new Set(["UNDELIV", "UNDELIVERABLE", "REJECTD", "REJECTED", "EXPIRED", "DELETED", "FAILED"]);

export function createEskiz(opts: EskizOptions): SmsProvider {
  const http = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function token(): Promise<string> {
    const cached = await opts.cache.get<string>(cacheKeys.eskizToken);
    if (cached) return cached;
    const form = new FormData();
    form.set("email", opts.email);
    form.set("password", opts.password);
    const res = await http(`${base}/auth/login`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Eskiz auth: HTTP ${res.status}`);
    const { data } = loginResponse.parse(await res.json());
    await opts.cache.set(cacheKeys.eskizToken, data.token, 29 * 24 * 3600);
    return data.token;
  }

  async function sendOnce(phone: string, text: string, callbackUrl?: string) {
    const form = new FormData();
    form.set("mobile_phone", phone);
    form.set("message", text);
    form.set("from", opts.from);
    if (callbackUrl) form.set("callback_url", callbackUrl);
    return http(`${base}/message/sms/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
  }

  return {
    name: "eskiz",

    async send(phone, text, o) {
      let res = await sendOnce(phone, text, o?.callbackUrl);
      if (res.status === 401) {
        // Токен истёк раньше срока: получаем новый и пробуем ещё раз.
        await opts.cache.del(cacheKeys.eskizToken);
        res = await sendOnce(phone, text, o?.callbackUrl);
      }
      const json = await res.json().catch(() => null);
      const parsed = sendResponse.safeParse(json);
      if (!res.ok || !parsed.success) throw new Error(`Eskiz send: HTTP ${res.status} ${JSON.stringify(json)?.slice(0, 300)}`);
      return { providerRef: String(parsed.data.id) };
    },

    parseDelivery(body) {
      const parsed = deliverySchema.safeParse(body);
      if (!parsed.success) return null;
      const ref = parsed.data.request_id ?? parsed.data.message_id;
      if (ref === undefined) return null;
      const s = parsed.data.status.toUpperCase();
      const status = DELIVERED.has(s) ? "delivered" : FAILED.has(s) ? "failed" : "sent";
      return { providerRef: String(ref), status };
    },
  };
}
