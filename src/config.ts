import { z } from "zod";

const csvIds = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^\d+$/, "ожидаются числа через запятую")));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    APP_URL: z.url().default("http://localhost:3000"),
    TRUST_PROXY: z.stringbool().default(false),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, "JWT_SECRET должен быть не короче 32 символов"),
    ADMIN_TELEGRAM_IDS: csvIds,
    // Админы, которые входят по телефону: номера через запятую в формате 998XXXXXXXXX.
    ADMIN_PHONES: csvIds,
    APP_NAME: z.string().default("Invitations"),

    TELEGRAM_BOT_TOKEN: z.string().default(""),
    TELEGRAM_BOT_USERNAME: z.string().default(""),
    // Секрет, который Telegram присылает в заголовке X-Telegram-Bot-Api-Secret-Token.
    TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
    // polling удобен локально, webhook нужен на сервере.
    TELEGRAM_MODE: z.enum(["polling", "webhook", "off"]).default("polling"),

    PAYMENT_PROVIDER: z.enum(["multicard", "mock"]).default("mock"),
    CURRENCY: z.string().default("UZS"),
    MULTICARD_BASE_URL: z.url().default("https://dev-mesh.multicard.uz"),
    MULTICARD_APPLICATION_ID: z.string().default(""),
    MULTICARD_SECRET: z.string().default(""),
    MULTICARD_STORE_ID: z.string().default(""),
    // ИКПУ (MXIK) и код упаковки для фискального чека; выдаются при регистрации в soliq.uz.
    MULTICARD_MXIK: z.string().default(""),
    MULTICARD_PACKAGE_CODE: z.string().default(""),
    MOCK_PAYMENT_SECRET: z.string().default("mock-secret"),

    SMS_PROVIDER: z.enum(["eskiz", "mock"]).default("mock"),
    ESKIZ_BASE_URL: z.url().default("https://notify.eskiz.uz/api"),
    ESKIZ_EMAIL: z.string().default(""),
    ESKIZ_PASSWORD: z.string().default(""),
    // Имя отправителя; 4546 — общий номер Eskiz, своё имя подключается через их поддержку.
    ESKIZ_FROM: z.string().default("4546"),
    // Секрет в адресе колбэка о доставке SMS: Eskiz не подписывает колбэки.
    SMS_CALLBACK_SECRET: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (env.PAYMENT_PROVIDER === "mock") {
      ctx.addIssue({ code: "custom", message: "В production нельзя использовать PAYMENT_PROVIDER=mock" });
    }
    if (env.TELEGRAM_MODE === "webhook" && env.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      ctx.addIssue({ code: "custom", message: "TELEGRAM_WEBHOOK_SECRET обязателен (от 16 символов) в режиме webhook" });
    }
    if (env.SMS_PROVIDER === "mock") {
      ctx.addIssue({ code: "custom", message: "В production нельзя использовать SMS_PROVIDER=mock" });
    }
    if (env.SMS_PROVIDER === "eskiz" && (!env.ESKIZ_EMAIL || !env.ESKIZ_PASSWORD)) {
      ctx.addIssue({ code: "custom", message: "Заполните ESKIZ_EMAIL и ESKIZ_PASSWORD" });
    }
    if (env.PAYMENT_PROVIDER === "multicard" && (!env.MULTICARD_APPLICATION_ID || !env.MULTICARD_SECRET || !env.MULTICARD_STORE_ID)) {
      ctx.addIssue({ code: "custom", message: "Заполните MULTICARD_APPLICATION_ID, MULTICARD_SECRET и MULTICARD_STORE_ID" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Неверная конфигурация окружения:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
