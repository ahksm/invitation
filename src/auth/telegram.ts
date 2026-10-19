import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Cache } from "../cache.js";
import { randomToken } from "../services/invitations.js";
import type { TelegramProfile } from "../services/users.js";

/**
 * Вход через Telegram без ввода данных на сайте:
 * 1. Сайт создаёт запрос входа и открывает t.me/<бот>?start=auth_<nonce>.
 * 2. В боте человек делится номером (если ещё не делился) и подтверждает вход.
 * 3. Браузер, создавший запрос, опрашивает сервер и получает сессию.
 * Сессию получает только браузер с секретом из cookie, поэтому чужая ссылка входа бесполезна.
 *
 * «Подключить Telegram» в аккаунте идёт тем же путём: запрос, начатый с сессией, помнит её
 * пользователя (linkUserId), и бот подключает Telegram к нему, а не входит в аккаунт этого Telegram.
 * Подключается только Telegram, подтвердивший своим контактом номер этого аккаунта (Telegram без
 * номера бот сначала просит поделиться номером): чужая ссылка подключения бесполезна. Telegram
 * с другим номером или уже другого аккаунта — отказ (conflict): ничего не привязывается, и браузер
 * остаётся в прежнем аккаунте.
 */
const TTL = 300;
const key = (nonce: string) => `tglogin:${nonce}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export type TelegramLogin = {
  secretHash: string;
  device: string;
  /** Подтверждённый вход: этот пользователь получит сессию. */
  userId?: string;
  /** Подключение Telegram к аккаунту, из которого начат запрос. */
  linkUserId?: string;
  /** Отказ подключения: сообщение об ошибке (ключ перевода), браузер получит его вместо сессии. */
  conflict?: string;
};

/** linked: Telegram подключён к аккаунту, из которого начат запрос (а не новый вход). */
export type TelegramLoginResult = "pending" | "expired" | { userId: string; linked: boolean } | { conflict: string };

export const isNonce = (s: string) => /^[\w-]{16,64}$/.test(s);

/** linkUserId: запрос начат из аккаунта («Подключить Telegram»). */
export async function startTelegramLogin(cache: Cache, device: string, linkUserId?: string) {
  const nonce = randomToken(18);
  const secret = randomToken(24);
  await cache.set(key(nonce), { secretHash: hash(secret), device, ...(linkUserId && { linkUserId }) } satisfies TelegramLogin, TTL);
  return { nonce, secret, ttl: TTL };
}

export async function getTelegramLogin(cache: Cache, nonce: string) {
  return isNonce(nonce) ? cache.get<TelegramLogin>(key(nonce)) : undefined;
}

/** Запрос уже завершён: вход подтверждён или подключение отклонено. */
const settled = (login: TelegramLogin) => Boolean(login.userId || login.conflict);

/**
 * Бот завершает запрос: подтверждает вход (userId) или отклоняет подключение (conflict).
 * false, если запрос истёк или уже завершён.
 */
export async function settleTelegramLogin(cache: Cache, nonce: string, outcome: { userId: string } | { conflict: string }): Promise<boolean> {
  const login = await getTelegramLogin(cache, nonce);
  if (!login || settled(login)) return false;
  const ttl = await cache.redis.ttl(`inv:${key(nonce)}`);
  await cache.set(key(nonce), { ...login, ...outcome }, Math.max(ttl, 30));
  return true;
}

/** Бот подтверждает вход. false, если запрос истёк или уже подтверждён. */
export const approveTelegramLogin = (cache: Cache, nonce: string, userId: string) => settleTelegramLogin(cache, nonce, { userId });

/**
 * Одна обработка нажатия «Подтвердить» на запрос: повторное или параллельное нажатие той же кнопки
 * не выполняет подключение второй раз. Отметка живёт не дольше самого запроса.
 */
export const claimTelegramApproval = (cache: Cache, nonce: string) => cache.claim(`${key(nonce)}:approve`, TTL);

/** Секрет браузера совпадает с запросом. */
function secretMatches(login: TelegramLogin, secret: string | undefined) {
  if (!secret) return false;
  const a = Buffer.from(hash(secret));
  const b = Buffer.from(login.secretHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Браузер забирает завершённый запрос: userId для сессии или отказ подключения, один раз.
 * Доказательство, что запрос свой: секрет из cookie, а у подключения Telegram и сессия того же
 * пользователя (cookie или Bearer). Во фрейме Telegram Web cookie tglogin не сохраняется, а результат
 * подключения — сессия этого же аккаунта или отказ, поэтому его владельцу сессии отдать можно.
 */
export async function claimTelegramLogin(
  cache: Cache,
  nonce: string,
  proof: { secret?: string | undefined; sessionUserId?: string | undefined },
): Promise<TelegramLoginResult> {
  const login = await getTelegramLogin(cache, nonce);
  if (!login) return "expired";
  const ownSession = login.linkUserId !== undefined && proof.sessionUserId === login.linkUserId;
  if (!secretMatches(login, proof.secret) && !ownSession) return "expired";
  if (!settled(login)) return "pending";
  const taken = await cache.take<TelegramLogin>(key(nonce));
  if (taken?.conflict) return { conflict: taken.conflict };
  return taken?.userId ? { userId: taken.userId, linked: taken.linkUserId !== undefined } : "expired";
}

/** Запрос больше не действует (например, аккаунт, к которому подключали Telegram, заблокирован). */
export const dropTelegramLogin = (cache: Cache, nonce: string) => cache.del(key(nonce));

/**
 * Последний отказ бота принять контакт этого Telegram: номер уже привязан к другому Telegram-аккаунту
 * (сообщение HttpError, ключ перевода), чужой контакт или нераспознанный номер (текст бота). Мини-апп,
 * который ждёт номер, получает причину в ответе /api/auth/webapp. Новый контакт отказ сбрасывает.
 */
export type ContactRejection = { error: string } | { text: "ownPhoneOnly" | "badPhone" };
const rejectionKey = (telegramId: number) => `tgcontact:rejected:${telegramId}`;
// Мини-апп с теми же initData живёт сутки (verifyWebAppInitData): дольше причина не нужна.
const REJECTION_TTL = 86_400;

export const setContactRejection = (cache: Cache, telegramId: number, r: ContactRejection) => cache.set(rejectionKey(telegramId), r, REJECTION_TTL);
export const getContactRejection = (cache: Cache, telegramId: number) => cache.get<ContactRejection>(rejectionKey(telegramId));
export const clearContactRejection = (cache: Cache, telegramId: number) => cache.del(rejectionKey(telegramId));

/** Краткое описание устройства для сообщения в боте: «Chrome, Windows». */
export function describeDevice(userAgent: string | undefined) {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "браузер";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}

/**
 * Проверка initData мини-аппа Telegram:
 * secret = HMAC_SHA256(key="WebAppData", bot_token), hash = HMAC_SHA256(secret, data_check_string).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyWebAppInitData(initData: string, botToken: string, now = Date.now(), maxAgeSeconds = 86_400): TelegramProfile | null {
  if (!botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = Buffer.from(createHmac("sha256", secret).update(checkString).digest("hex"));
  const got = Buffer.from(hash);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: unknown; username?: string; first_name?: string; last_name?: string; language_code?: string } | null;
    if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
    return { id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name, language_code: user.language_code };
  } catch {
    return null;
  }
}
