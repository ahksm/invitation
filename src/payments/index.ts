import type { Cache } from "../cache.js";
import type { Config } from "../config.js";
import { createMockProvider } from "./mock.js";
import { createMulticardProvider } from "./multicard.js";
import type { PaymentProvider } from "./types.js";

export function createPaymentProvider(config: Config, cache: Cache): PaymentProvider {
  if (config.PAYMENT_PROVIDER === "mock") {
    return createMockProvider({ appUrl: config.APP_URL.replace(/\/+$/, ""), secret: config.MOCK_PAYMENT_SECRET });
  }
  return createMulticardProvider({
    baseUrl: config.MULTICARD_BASE_URL,
    applicationId: config.MULTICARD_APPLICATION_ID,
    secret: config.MULTICARD_SECRET,
    storeId: config.MULTICARD_STORE_ID,
    mxik: config.MULTICARD_MXIK || undefined,
    packageCode: config.MULTICARD_PACKAGE_CODE || undefined,
    cache,
  });
}
