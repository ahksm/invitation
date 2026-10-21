export type SmsSendResult = { providerRef: string };

export type SmsDeliveryReport = { providerRef: string; status: "sent" | "delivered" | "failed" };

export interface SmsProvider {
  readonly name: string;
  /** phone в формате 998XXXXXXXXX. */
  send(phone: string, text: string, opts?: { callbackUrl?: string | undefined }): Promise<SmsSendResult>;
  /** Разбирает колбэк о доставке. null, если формат незнаком. */
  parseDelivery(body: unknown): SmsDeliveryReport | null;
}
