import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PaymentProvider } from "./types.js";

/** Тестовый провайдер для разработки: страница оплаты внутри самого приложения. */
export function mockSign(secret: string, orderNumber: number, amount: number, status: string) {
  return createHmac("sha256", secret).update(`${orderNumber}:${amount}:${status}`).digest("hex");
}

const bodySchema = z.object({
  order_number: z.number().int(),
  amount: z.number().int(),
  status: z.enum(["paid", "failed", "cancelled"]),
  sign: z.string(),
});

export function createMockProvider(opts: { appUrl: string; secret: string }): PaymentProvider {
  return {
    name: "mock",
    async createCheckout({ order }) {
      return {
        checkoutUrl: `${opts.appUrl}/api/payments/mock/checkout/${order.id}`,
        providerRef: `mock-${order.number}`,
      };
    },
    async verifyWebhook(body) {
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) return null;
      const { order_number, amount, status, sign } = parsed.data;
      const expected = Buffer.from(mockSign(opts.secret, order_number, amount, status));
      const got = Buffer.from(sign);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
      return { orderNumber: order_number, amount, status, providerRef: `mock-${order_number}`, raw: body };
    },
    webhookAck(ok, message) {
      return { status: ok ? 200 : 400, body: { success: ok, message } };
    },
  };
}
