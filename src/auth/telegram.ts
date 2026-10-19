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
 */
const TTL = 300;
const key = (nonce: string) => `tglogin:${nonce}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export type TelegramLogin = { secretHash: string; device: string; userId?: string };

export const isNonce = (s: string) => /^[\w-]{16,64}$/.test(s);

export async function startTelegramLogin(cache: Cache, device: string) {
  const nonce = randomToken(18);
  const secret = randomToken(24);
  await cache.set(key(nonce), { secretHash: hash(secret), device } satisfies TelegramLogin, TTL);
  return { nonce, secret, ttl: TTL };
}

export async function getTelegramLogin(cache: Cache, nonce: string) {
  return isNonce(nonce) ? cache.get<TelegramLogin>(key(nonce)) : undefined;
}

/** Бот подтверждает вход. false, если запрос истёк или уже подтверждён. */
export async function approveTelegramLogin(cache: Cache, nonce: string, userId: string): Promise<boolean> {
  const login = await getTelegramLogin(cache, nonce);
  if (!login || login.userId) return false;
  const ttl = await cache.redis.ttl(`inv:${key(nonce)}`);
  await cache.set(key(nonce), { ...login, userId }, Math.max(ttl, 30));
  return true;
}

/** Браузер забирает подтверждённый вход. Возвращает userId один раз. */
export async function claimTelegramLogin(cache: Cache, nonce: string, secret: string): Promise<"pending" | "expired" | { userId: string }> {
  const login = await getTelegramLogin(cache, nonce);
  if (!login) return "expired";
  const a = Buffer.from(hash(secret));
  const b = Buffer.from(login.secretHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "expired";
  if (!login.userId) return "pending";
  const taken = await cache.take<TelegramLogin>(key(nonce));
  return taken?.userId ? { userId: taken.userId } : "expired";
}

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
