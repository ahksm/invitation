import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { BRAND } from "../brand.js";
import { cacheKeys } from "../cache.js";
import type { Ctx } from "../context.js";
import { invitations, media, orders, smsMessages, subscriptions, usageEvents, users, type User } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { Locale } from "../i18n.js";
import { otpText } from "../sms/texts.js";
import { invalidateUser, isConfiguredAdmin, syncAdmin } from "./users.js";

/** Приводит номер к виду 998XXXXXXXXX. Принимает +998 90 123-45-67, 998901234567 и 901234567. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const full = digits.length === 9 ? `998${digits}` : digits;
  return /^998\d{9}$/.test(full) ? full : null;
}

export const formatPhone = (p: string) => `+${p.slice(0, 3)} ${p.slice(3, 5)} ${p.slice(5, 8)}-${p.slice(8, 10)}-${p.slice(10)}`;

/**
 * Номер со скрытой серединой для сообщений бота: «+998 90 ***-**-67». Номер из Telegram-контакта
 * может быть и не узбекским (только цифры): тогда видны код страны и две последние цифры.
 */
export const maskPhone = (p: string) => (/^998\d{9}$/.test(p) ? `+998 ${p.slice(3, 5)} ***-**-${p.slice(10)}` : `+${p.slice(0, 3)}***${p.slice(-2)}`);

const OTP_TTL = 300;
const OTP_ATTEMPTS = 5;

function otpHash(secret: string, phone: string, code: string) {
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

/** Отправляет код входа. Лимиты: раз в минуту и 5 в час на номер, 20 в час с одного IP. */
export async function requestOtp(ctx: Ctx, phone: string, ip: string, locale: Locale) {
  const { cache } = ctx;
  if (await cache.hit(`otp:minute:${phone}`, 1, 60)) throw new HttpError(429, "Код уже отправлен, повторить можно через минуту");
  if (await cache.hit(`otp:hour:${phone}`, 5, 3600)) throw new HttpError(429, "Слишком много запросов кода, попробуйте через час");
  if (await cache.hit(`otp:ip:${ip}`, 20, 3600)) throw new HttpError(429, "Слишком много запросов кода, попробуйте позже");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const key = `inv:${cacheKeys.otp(phone)}`;
  await cache.redis.multi().del(key).hset(key, { hash: otpHash(ctx.config.JWT_SECRET, phone, code), attempts: 0 }).expire(key, OTP_TTL).exec();

  const [row] = await ctx.db.insert(smsMessages).values({ purpose: "otp", phone, provider: ctx.sms.name }).returning({ id: smsMessages.id });
  try {
    const { providerRef } = await ctx.sms.send(phone, otpText(locale, BRAND, code));
    await ctx.db.update(smsMessages).set({ status: "sent", providerRef }).where(eq(smsMessages.id, row!.id));
  } catch (err) {
    await ctx.db.update(smsMessages).set({ status: "failed", error: String(err).slice(0, 500) }).where(eq(smsMessages.id, row!.id));
    await cache.redis.del(key);
    ctx.log.error({ err }, "не удалось отправить код входа");
    throw new HttpError(502, "Не удалось отправить SMS, попробуйте позже");
  }
  return { ttl: OTP_TTL };
}

/**
 * Попытка ввода кода одной командой Redis: хэш читается и счётчик попыток растёт атомарно.
 * Нет кода — nil (ключ не создаётся заново без срока жизни); попытки кончились — код удаляется, nil.
 */
const OTP_ATTEMPT_SCRIPT = `
local hash = redis.call('HGET', KEYS[1], 'hash')
if not hash then return false end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return false
end
return hash`;

/** Проверяет код. После 5 неверных попыток код сгорает; верный код срабатывает один раз. */
export async function verifyOtp(ctx: Pick<Ctx, "cache" | "config">, phone: string, code: string): Promise<boolean> {
  const key = `inv:${cacheKeys.otp(phone)}`;
  const hash = (await ctx.cache.redis.eval(OTP_ATTEMPT_SCRIPT, 1, key, OTP_ATTEMPTS)) as string | null;
  if (!hash) return false;
  const a = Buffer.from(otpHash(ctx.config.JWT_SECRET, phone, code));
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Из двух одновременных верных попыток проходит одна: та, что удалила код.
  return (await ctx.cache.redis.del(key)) === 1;
}

export async function upsertPhoneUser(ctx: Pick<Ctx, "db" | "cache" | "config">, phone: string, locale: Locale): Promise<User> {
  const [row] = await ctx.db
    .insert(users)
    .values({ phone, locale, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: users.phone, set: { lastSeenAt: new Date() } })
    .returning();
  // Права админа пересчитываются по ADMIN_PHONES и ADMIN_TELEGRAM_IDS (у аккаунта может быть и Telegram).
  const user = await syncAdmin(ctx, row!);
  await invalidateUser(ctx, user.id);
  return user;
}

/** Таблицы с данными пользователя: при объединении аккаунтов строки переходят к оставшемуся. */
const USER_DATA = [invitations, orders, subscriptions, usageEvents, smsMessages, media] as const;

/** Переносит данные пользователя from к пользователю to и удаляет from (в транзакции). */
async function mergeInto(tx: Pick<Ctx["db"], "update" | "delete">, fromId: string, toId: string) {
  for (const t of USER_DATA) await tx.update(t).set({ userId: toId }).where(eq(t.userId, fromId));
  await tx.delete(users).where(eq(users.id, fromId));
}

/**
 * Привязывает номер из Telegram-контакта к пользователю Telegram.
 * Если этот номер уже есть у аккаунта, созданного входом по SMS, аккаунты объединяются:
 * данные Telegram-аккаунта переносятся в аккаунт с номером. Это единственный путь Telegram в такой
 * аккаунт, в том числе для «Подключить Telegram» (linkTelegramToUser) и для записи без номера,
 * которую админ создал выдачей доступа по Telegram ID: её данные и бесплатный доступ переходят к аккаунту.
 */
export async function attachPhoneToTelegramUser(ctx: Pick<Ctx, "db" | "cache" | "config">, tgUser: User, phone: string): Promise<User> {
  if (tgUser.phone === phone) return tgUser;
  const result = await ctx.db.transaction(async (tx) => {
    const [owner] = await tx.select().from(users).where(eq(users.phone, phone)).for("update");
    if (!owner || owner.id === tgUser.id) {
      const isAdmin = isConfiguredAdmin(ctx.config, { phone, telegramId: tgUser.telegramId });
      const [u] = await tx.update(users).set({ phone, isAdmin }).where(eq(users.id, tgUser.id)).returning();
      return { user: u!, removed: null };
    }
    if (owner.telegramId !== null && owner.telegramId !== tgUser.telegramId) {
      throw new HttpError(409, "Этот номер уже привязан к другому Telegram-аккаунту");
    }
    await mergeInto(tx, tgUser.id, owner.id);
    const [u] = await tx
      .update(users)
      .set({
        telegramId: tgUser.telegramId,
        username: tgUser.username,
        // Имя, изменённое в профиле аккаунта, остаётся как есть (и фамилия, которую стёрли).
        firstName: owner.nameEdited ? owner.firstName : (owner.firstName ?? tgUser.firstName),
        lastName: owner.nameEdited ? owner.lastName : (owner.lastName ?? tgUser.lastName),
        isAdmin: isConfiguredAdmin(ctx.config, { phone, telegramId: tgUser.telegramId }),
        freeAccess: owner.freeAccess || tgUser.freeAccess,
        freeAccessNote: owner.freeAccessNote ?? tgUser.freeAccessNote,
        blocked: owner.blocked || tgUser.blocked,
      })
      .where(eq(users.id, owner.id))
      .returning();
    return { user: u!, removed: tgUser.id };
  });
  await invalidateUser(ctx, result.user.id);
  if (result.removed) await invalidateUser(ctx, result.removed);
  return result.user;
}

/** Отказ подключения Telegram: он уже у другого аккаунта (с номером). Ключ перевода в src/i18n.ts. */
export const TELEGRAM_TAKEN = "Этот Telegram уже привязан к другому аккаунту";

/**
 * Отказ подключения Telegram: номер, которым этот Telegram поделился в боте, — не номер аккаунта
 * (или номер не подтверждён). Ключ перевода в src/i18n.ts.
 */
export const TELEGRAM_PHONE_MISMATCH = "Номер этого Telegram отличается от номера аккаунта: подключите Telegram с тем же номером";

/**
 * «Подключить Telegram» из аккаунта на сайте: проверяет, что Telegram tgUser (пользователь бота) —
 * это аккаунт targetId. Здесь ничего не привязывается и не объединяется: Telegram попадает в аккаунт
 * только через собственный контакт в боте с номером аккаунта (attachPhoneToTelegramUser объединяет
 * его с аккаунтом этого номера). Иначе ссылку подключения, попавшую к другому человеку (пересланную,
 * увиденную на чужом экране), мог бы подтвердить его Telegram и потом входить им в этот аккаунт.
 * Telegram этого аккаунта — аккаунт (ничего не меняется). Telegram с номером — другой аккаунт:
 * HttpError(409, TELEGRAM_TAKEN). Telegram без номера (номер не подтверждён) не подключается:
 * HttpError(409, TELEGRAM_PHONE_MISMATCH), бот сначала просит его контакт.
 * null — аккаунта больше нет, он заблокирован или без номера (вход по нему всё равно невозможен).
 */
export async function linkTelegramToUser(ctx: Pick<Ctx, "db">, targetId: string, tgUser: Pick<User, "telegramId">): Promise<User | null> {
  const telegramId = tgUser.telegramId;
  if (telegramId === null) throw new Error("linkTelegramToUser: у пользователя бота нет Telegram ID");
  // Обе записи читаются из базы, а не из кэша: бот мог объединить Telegram с аккаунтом, пока шёл запрос.
  const [target] = await ctx.db.select().from(users).where(eq(users.id, targetId));
  if (!target || target.blocked || !target.phone) return null;
  if (target.telegramId === telegramId) return target;
  const [owner] = await ctx.db.select({ phone: users.phone }).from(users).where(eq(users.telegramId, telegramId));
  throw new HttpError(409, owner?.phone ? TELEGRAM_TAKEN : TELEGRAM_PHONE_MISMATCH);
}
