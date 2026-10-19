import type { Order } from "../db/schema.js";

export type CheckoutItem = { title: string; quantity: number; unitPrice: number };

export type CheckoutRequest = {
  order: Pick<Order, "id" | "number" | "amount" | "currency">;
  items: CheckoutItem[];
  callbackUrl: string;
  returnUrl: string;
};

export type CheckoutResult = { checkoutUrl: string; providerRef: string };

/** Проверенное уведомление об оплате от платёжной системы. */
export type PaymentNotification = {
  orderNumber: number;
  amount: number;
  status: "paid" | "failed" | "cancelled";
  providerRef?: string | undefined;
  raw: unknown;
};

export type WebhookResponse = { status: number; body: unknown };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Проверяет подпись. Возвращает null, если уведомление поддельное или неполное. */
  verifyWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): Promise<PaymentNotification | null>;
  /** Что ответить платёжной системе после обработки уведомления. */
  webhookAck(ok: boolean, message?: string): WebhookResponse;
}
