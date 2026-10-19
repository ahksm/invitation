import { setTimeout as sleep } from "node:timers/promises";
import { webhookCallback, type Bot } from "grammy";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { setBotCommands, createBot, type BotContext } from "./bot/index.js";
import { createTelegramNotifier } from "./bot/notifier.js";
import { createCache } from "./cache.js";
import { botEnabled, loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { createPaymentProvider } from "./payments/index.js";
import { startReminderJob } from "./services/reminders.js";
import { createSmsProvider } from "./sms/index.js";

const config = loadConfig();
// До запуска приложения ошибки соединений с Postgres и Redis пишем в консоль, потом в лог Fastify.
let logError = (err: Error, msg: string) => console.error(`${msg}:`, err.message);
const { db, pool } = createDb(config.DATABASE_URL, (err) => logError(err, "ошибка соединения с Postgres"));
// Недоступный Redis: команда ждёт переподключения не дольше 2 с, а не десятки секунд на каждый запрос.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, commandTimeout: 2000 });
// Лимиты запросов на отдельном клиенте, который без соединения сразу отвечает ошибкой: лимит
// пропускается (skipOnError), и страницы и файлы, которым Redis не нужен, отдаются без задержки.
const rateLimitRedis = new Redis(config.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 500 });
// ioredis сообщает о каждой неудачной попытке переподключения; в лог — не чаще раза в 30 с.
for (const [client, name] of [[redis, "Redis"], [rateLimitRedis, "Redis (лимиты)"]] as const) {
  let last = 0;
  client.on("error", (err: Error) => {
    if (Date.now() - last < 30_000) return;
    last = Date.now();
    logError(err, `${name} недоступен`);
  });
}
const cache = createCache(redis);
const payments = createPaymentProvider(config, cache);
const sms = createSmsProvider(config, cache, { info: (obj: object, msg?: string) => console.log(msg, JSON.stringify(obj)) });

await runMigrations(db);
await seed(db);
const app = await buildApp({ config, db, cache, payments, sms, rateLimitRedis });
logError = (err, msg) => app.log.error({ err }, msg);

const bot = botEnabled(config) ? createBot(app.ctx) : null;
// Уведомления владельцам и напоминания гостям. Отправка не требует bot.init, ошибки только в лог.
if (bot) app.ctx.notifier = createTelegramNotifier(bot.api, app.ctx);
// Напоминания гостям по расписанию (r1d, r3h, morning) уходят только через бота.
const stopReminders = bot ? startReminderJob(app.ctx) : null;

if (bot && config.TELEGRAM_MODE === "webhook") {
  // Telegram подписывает каждый запрос заголовком X-Telegram-Bot-Api-Secret-Token.
  // webhookCallback сам вызывает bot.init при первом обновлении.
  const handle = webhookCallback(bot, "fastify", { secretToken: config.TELEGRAM_WEBHOOK_SECRET });
  app.post("/telegram/webhook", { config: { rateLimit: false } }, handle);
}

await app.listen({ port: config.PORT, host: config.HOST });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "остановка");
  stopReminders?.();
  if (bot?.isRunning()) await bot.stop();
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit(), rateLimitRedis.quit()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/** Настройка бота в Telegram. Вызывается после app.listen: сайт работает и без бота. */
async function setupBot(bot: Bot<BotContext>) {
  await bot.init();
  await setBotCommands(bot);
  // Кнопка мини-аппа в чате с ботом. Telegram открывает мини-апп только по https.
  if (config.APP_URL.startsWith("https://")) {
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: config.APP_NAME, web_app: { url: `${config.APP_URL.replace(/\/+$/, "")}/app/` } },
    });
  }
  if (config.TELEGRAM_MODE === "webhook") {
    await bot.api.setWebhook(`${config.APP_URL.replace(/\/+$/, "")}/telegram/webhook`, {
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  } else {
    await bot.api.deleteWebhook();
    // bot.start завершается ошибкой при 401 (неверный токен) и 409 (тот же бот уже опрашивается
    // в другом процессе): это не повод останавливать сайт.
    bot
      .start({ allowed_updates: ["message", "callback_query"] })
      .catch((err) => app.log.error({ err }, "бот остановился, сайт работает без него"));
  }
  app.log.info(`бот @${bot.botInfo.username} запущен (${config.TELEGRAM_MODE})`);
}

if (bot) {
  // Сеть или Telegram недоступны при старте: пробуем ещё несколько раз, сайт тем временем работает.
  void (async () => {
    for (let attempt = 1; !stopping; attempt++) {
      try {
        return await setupBot(bot);
      } catch (err) {
        app.log.error({ err, attempt }, "не удалось настроить бота в Telegram");
        if (attempt === 5) return;
        await sleep(attempt * 10_000);
      }
    }
  })();
} else {
  app.log.warn("бот выключен: нет TELEGRAM_BOT_TOKEN или TELEGRAM_MODE=off");
}
