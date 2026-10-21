import type { FastifyBaseLogger } from "fastify";
import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import { createEskiz } from "./eskiz.js";
import { createMockSms } from "./mock.js";
import type { SmsProvider } from "./types.js";

export function createSmsProvider(config: Config, cache: Cache, log: Pick<FastifyBaseLogger, "info">): SmsProvider {
  if (config.SMS_PROVIDER === "mock") return createMockSms(log);
  return createEskiz({
    baseUrl: config.ESKIZ_BASE_URL,
    email: config.ESKIZ_EMAIL,
    password: config.ESKIZ_PASSWORD,
    from: config.ESKIZ_FROM,
    testMode: config.ESKIZ_TEST_MODE ? { log } : undefined,
    cache,
  });
}
