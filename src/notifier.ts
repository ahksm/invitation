/** Кнопка-ссылка под сообщением. Telegram принимает в кнопках только https: другие ссылки дописываются в текст. */
export type NotifyButton = { text: string; url: string };
export type NotifyOptions = { buttons?: NotifyButton[] | undefined };

/**
 * Сообщения в Telegram: владельцу приглашения (уведомления, проверка бота) и гостям (напоминания).
 * Реализует бот (src/bot/notifier.ts), без бота работает заглушка. Методы не бросают ошибок:
 * true значит, что Telegram принял сообщение, false — что отправить не удалось (ошибка уже в логе).
 */
export interface Notifier {
  /** false у заглушки: бот выключен. */
  readonly enabled: boolean;
  /** Пользователю платформы по id, если у него есть Telegram и он не заблокирован. */
  sendToUser(userId: string, text: string, opts?: NotifyOptions): Promise<boolean>;
  /** В чат по его id (например, гостю, который подключил бота). */
  sendToChat(chatId: number, text: string, opts?: NotifyOptions): Promise<boolean>;
}

export const noopNotifier: Notifier = {
  enabled: false,
  sendToUser: async () => false,
  sendToChat: async () => false,
};
