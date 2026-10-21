import { isIP } from "node:net";
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

// Имена диапазонов, которые понимает Fastify (proxy-addr): 127.0.0.0/8 и ::1, 169.254.0.0/16 и fe80::/10, частные сети.
const PROXY_RANGES = new Set(["loopback", "linklocal", "uniquelocal"]);
const isProxyAddress = (s: string) => {
  if (PROXY_RANGES.has(s)) return true;
  const [ip = "", bits, ...rest] = s.split("/");
  const v = isIP(ip);
  if (!v || rest.length) return false;
  return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128));
};

/**
 * Каким прокси верить в X-Forwarded-For (от этого зависит req.ip, а на нём держатся все лимиты).
 * false: никаким; число: столько прокси перед приложением (1 для одного nginx); иначе адреса или
 * подсети прокси через запятую. true не принимается: тогда адрес клиента подделывается заголовком.
 */
const trustProxy = z
  .string()
  .default("false")
  .transform((raw, c): false | number | string[] => {
    const s = raw.trim().toLowerCase();
    if (s === "" || s === "false" || s === "0") return false;
    if (s === "true") {
      c.addIssue({ code: "custom", message: "TRUST_PROXY=true доверяет любому X-Forwarded-For: укажите число прокси (обычно 1) или их адреса" });
      return z.NEVER;
    }
    if (/^\d+$/.test(s)) {
      const hops = Number(s);
      if (hops > 10) c.addIssue({ code: "custom", message: "TRUST_PROXY: прокси не может быть больше 10" });
      return hops;
    }
    const list = s.split(",").map((x) => x.trim()).filter(Boolean);
    const bad = list.filter((x) => !isProxyAddress(x));
    if (bad.length) c.addIssue({ code: "custom", message: `TRUST_PROXY: ожидается число прокси или их адреса через запятую, неверно: ${bad.join(", ")}` });
    return list;
  });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    APP_URL: z.url().default("http://localhost:3000"),
    TRUST_PROXY: trustProxy,
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, "JWT_SECRET должен быть не короче 32 символов"),
    ADMIN_TELEGRAM_IDS: csvIds,
    // Админы, которые входят по телефону: номера через запятую в формате 998XXXXXXXXX.
    ADMIN_PHONES: csvIds,
    // Каталог загруженных файлов (картинки, музыка, видео). В Docker — отдельный том.
    MEDIA_DIR: z.string().min(1).default("./data/media"),
    // Помощник с текстом (POST /api/ai/write). Пусто: выключен.
    ANTHROPIC_API_KEY: z.string().default(""),
    // Модель для помощника; должна принимать output_config.effort. Пусто: модель по умолчанию.
    AI_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("claude-opus-5-5")),

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
    // Числовой ID кассы: в счёт он уходит числом, в колбэке сверяется с тем, что прислал Multicard.
    MULTICARD_STORE_ID: z.string().default(""),
    // ИКПУ (MXIK) и код упаковки для фискального чека; выдаются при регистрации в soliq.uz.
    MULTICARD_MXIK: z.string().default(""),
    MULTICARD_PACKAGE_CODE: z.string().default(""),
    // Ставка НДС в чеке, %. Пусто: не передаётся.
    MULTICARD_VAT: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0).max(100).optional()),
    // Колбэки Multicard приходят с 195.158.26.90. Пусто: проверяется только подпись.
    // Включайте, только если TRUST_PROXY настроен верно, иначе настоящие оплаты будут отклонены.
    MULTICARD_CALLBACK_IPS: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
    MOCK_PAYMENT_SECRET: z.string().default("mock-secret"),

    SMS_PROVIDER: z.enum(["eskiz", "mock"]).default("mock"),
    ESKIZ_BASE_URL: z.url().default("https://notify.eskiz.uz/api"),
    ESKIZ_EMAIL: z.string().default(""),
    ESKIZ_PASSWORD: z.string().default(""),
    // Имя отправителя; 4546 — общий номер Eskiz, своё имя подключается через их поддержку.
    ESKIZ_FROM: z.string().default("4546"),
    // Тестовый аккаунт Eskiz отправляет только фиксированные фразы: вместо текста уходит
    // «This is test from Eskiz», а настоящий текст (с кодом) пишется в лог. Только для разработки.
    ESKIZ_TEST_MODE: z.stringbool().default(false),
    // Секрет в адресе колбэка о доставке SMS: Eskiz не подписывает колбэки.
    SMS_CALLBACK_SECRET: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    // Без секрета вебхук принимает поддельные обновления (в том числе подтверждение входа), поэтому в любом окружении.
    if (env.TELEGRAM_MODE === "webhook" && env.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      ctx.addIssue({ code: "custom", message: "TELEGRAM_WEBHOOK_SECRET обязателен (от 16 символов) в режиме webhook" });
    }
    // UUID кассы в счёте стал бы store_id: null, и каждая оплата падала бы с 502 уже у покупателя.
    if (env.PAYMENT_PROVIDER === "multicard" && env.MULTICARD_STORE_ID && !/^\d+$/.test(env.MULTICARD_STORE_ID)) {
      ctx.addIssue({ code: "custom", message: "MULTICARD_STORE_ID: укажите числовой ID кассы из кабинета Multicard" });
    }
    if (env.NODE_ENV !== "production") return;
    // Сайт работает только по https за прокси: CSP переводит скрипты на https (upgrade-insecure-requests),
    // проверка Origin, ссылки в SMS, адреса возврата и колбэков Multicard строятся от APP_URL.
    const appUrl = new URL(env.APP_URL);
    if (appUrl.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(appUrl.hostname)) {
      ctx.addIssue({ code: "custom", message: "APP_URL: публичный https-адрес сайта, например https://invitebloom.tech" });
    }
    if (env.PAYMENT_PROVIDER === "mock") {
      ctx.addIssue({ code: "custom", message: "В production нельзя использовать PAYMENT_PROVIDER=mock" });
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
    if (env.PAYMENT_PROVIDER === "multicard" && (!env.MULTICARD_MXIK || !env.MULTICARD_PACKAGE_CODE)) {
      ctx.addIssue({ code: "custom", message: "Заполните MULTICARD_MXIK и MULTICARD_PACKAGE_CODE: без них Multicard не создаёт счёт" });
    }
    if (env.ESKIZ_TEST_MODE) {
      ctx.addIssue({ code: "custom", message: "ESKIZ_TEST_MODE пишет коды входа в лог и запрещён в production" });
    }
  });

export type Config = z.infer<typeof schema>;

type BotConfig = Pick<Config, "TELEGRAM_MODE" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME">;

/** Бот запускается: режим не off и задан токен. */
export const botEnabled = (c: BotConfig) => c.TELEGRAM_MODE !== "off" && c.TELEGRAM_BOT_TOKEN !== "";

/** Имя бота для сайта (вход через Telegram, «Напомнить мне в Telegram»); null, если бот не запущен. */
export const botUsername = (c: BotConfig): string | null => (botEnabled(c) && c.TELEGRAM_BOT_USERNAME) || null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Неверная конфигурация окружения:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
