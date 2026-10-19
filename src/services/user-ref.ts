import { normalizePhone } from "./phone.js";

/** Кого админ указал в выдаче доступа или поиске: номер телефона или Telegram ID. */
export type UserRef = { phone: string } | { telegramId: number };

const TG_PREFIXED = /^(?:(?:tg|id)\s*:?\s*|@)(\d{1,15})$/i;

/**
 * Разбирает ссылку на пользователя от админа (админка, команды /grant и /revoke в боте):
 * - телефон: с «+» («+998 90 123-45-67»), 12 цифр «998XXXXXXXXX» или номер с пробелами и дефисами («90 123-45-67»);
 * - Telegram ID: «tg:123456789», «id 123456789», «@123456789» или просто цифры.
 * Девять цифр подряд считаются Telegram ID, а не номером: у многих аккаунтов ID такой же длины,
 * и номер без +998 иначе выдал бы доступ постороннему владельцу этого номера.
 */
export function parseUserRef(input: string): UserRef | null {
  const s = input.trim();
  const tg = TG_PREFIXED.exec(s)?.[1] ?? (/^\d{1,15}$/.test(s) && !/^998\d{9}$/.test(s) ? s : undefined);
  if (tg !== undefined) {
    const telegramId = Number(tg);
    return Number.isSafeInteger(telegramId) && telegramId > 0 ? { telegramId } : null;
  }
  // Остались «+…», 998XXXXXXXXX и номера с разделителями.
  if (!/^\+?[\d\s()-]+$/.test(s)) return null;
  const phone = normalizePhone(s);
  return phone ? { phone } : null;
}
