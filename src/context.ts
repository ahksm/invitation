import type { FastifyBaseLogger } from "fastify";
import type { Cache } from "./cache.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Notifier } from "./notifier.js";
import type { PaymentProvider } from "./payments/types.js";
import type { SmsProvider } from "./sms/types.js";

export type Ctx = {
  config: Config;
  db: Db;
  cache: Cache;
  payments: PaymentProvider;
  sms: SmsProvider;
  /** Сообщения в Telegram; server.ts подставляет бота после его создания. */
  notifier: Notifier;
  log: FastifyBaseLogger;
};
