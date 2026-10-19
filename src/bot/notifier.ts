import { InlineKeyboard, type Api } from "grammy";
import type { Ctx } from "../context.js";
import type { Notifier, NotifyOptions } from "../notifier.js";
import { getUser } from "../services/users.js";

/** Сколько ждать ответа Telegram на одно сообщение (по умолчанию grammY ждёт 500 секунд). */
const SEND_TIMEOUT_MS = 10_000;
const MAX_TEXT = 4096;

/**
 * Уведомления через Bot API (bot.api.sendMessage). Ошибки (бот заблокирован, сеть, неверный чат)
 * пишутся в лог и превращаются в false: уведомление никогда не ломает основной запрос.
 */
export function createTelegramNotifier(api: Pick<Api, "sendMessage">, ctx: Pick<Ctx, "db" | "cache" | "config" | "log">): Notifier {
  async function sendToChat(chatId: number, text: string, opts: NotifyOptions = {}) {
    const buttons = opts.buttons ?? [];
    const https = buttons.filter((b) => b.url.startsWith("https://"));
    // Локальный адрес (http://localhost) кнопкой не отправить: ссылка уходит текстом.
    const inline = buttons.filter((b) => !b.url.startsWith("https://")).map((b) => `${b.text}: ${b.url}`);
    const body = [text, ...inline].join("\n").slice(0, MAX_TEXT);
    try {
      await api.sendMessage(
        chatId,
        body,
        {
          link_preview_options: { is_disabled: true },
          ...(https.length && { reply_markup: new InlineKeyboard(https.map((b) => [InlineKeyboard.url(b.text, b.url)])) }),
        },
        // grammY описывает сигнал типом из пакета abort-controller; во время выполнения подходит встроенный.
        AbortSignal.timeout(SEND_TIMEOUT_MS) as Parameters<Api["sendMessage"]>[3],
      );
      return true;
    } catch (err) {
      ctx.log.warn({ err, chatId }, "сообщение в Telegram не отправлено");
      return false;
    }
  }

  async function sendToUser(userId: string, text: string, opts?: NotifyOptions) {
    let user;
    try {
      user = await getUser(ctx, userId);
    } catch (err) {
      ctx.log.warn({ err, userId }, "не удалось найти получателя уведомления");
      return false;
    }
    if (!user || user.telegramId === null || user.blocked) return false;
    return sendToChat(user.telegramId, text, opts);
  }

  return { enabled: true, sendToUser, sendToChat };
}
