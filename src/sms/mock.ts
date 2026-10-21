import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { SmsProvider } from "./types.js";

/** Для разработки: SMS не отправляются, а пишутся в лог (в том числе коды входа). */
export function createMockSms(log: Pick<FastifyBaseLogger, "info">, sent: { phone: string; text: string }[] = []): SmsProvider {
  return {
    name: "mock",
    async send(phone, text) {
      sent.push({ phone, text });
      log.info({ phone, text }, "SMS (тестовый режим, не отправлено)");
      return { providerRef: randomUUID() };
    },
    parseDelivery() {
      return null;
    },
  };
}
