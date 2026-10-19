import { and, desc, eq, gt } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import type { Config } from "../config.js";
import type { Ctx } from "../context.js";
import { subscriptions, users, type User } from "../db/schema.js";
import { pickLocale, type Locale } from "../i18n.js";
import { accessFor, type Access } from "../pricing.js";

export type TelegramProfile = {
  id: number;
  username?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  language_code?: string | undefined;
};

/**
 * Админ ли пользователь по конфигурации: телефон из ADMIN_PHONES или Telegram ID из ADMIN_TELEGRAM_IDS.
 * Оба источника проверяются всегда, поэтому вход одним способом не снимает права, выданные другим.
 */
export function isConfiguredAdmin(config: Pick<Config, "ADMIN_PHONES" | "ADMIN_TELEGRAM_IDS">, u: Pick<User, "phone" | "telegramId">): boolean {
  return (u.phone !== null && config.ADMIN_PHONES.includes(u.phone)) || (u.telegramId !== null && config.ADMIN_TELEGRAM_IDS.includes(String(u.telegramId)));
}

/**
 * Пересчитывает users.is_admin по конфигурации после входа: номер убрали из ADMIN_PHONES — права
 * снимаются, номер или Telegram ID добавили — выдаются. Колонка нужна админке и запросам по базе.
 */
export async function syncAdmin(ctx: Pick<Ctx, "db" | "config">, user: User): Promise<User> {
  const isAdmin = isConfiguredAdmin(ctx.config, user);
  if (user.isAdmin === isAdmin) return user;
  const [updated] = await ctx.db.update(users).set({ isAdmin }).where(eq(users.id, user.id)).returning();
  return updated ?? { ...user, isAdmin };
}

/** Создаёт или обновляет пользователя по данным Telegram. Права админа пересчитываются по обоим спискам. */
export async function upsertTelegramUser(ctx: Pick<Ctx, "db" | "cache" | "config">, tg: TelegramProfile): Promise<User> {
  const profile = {
    username: tg.username ?? null,
    firstName: tg.first_name ?? null,
    lastName: tg.last_name ?? null,
    lastSeenAt: new Date(),
  };
  const [row] = await ctx.db
    .insert(users)
    .values({ telegramId: tg.id, locale: pickLocale(tg.language_code), ...profile })
    .onConflictDoUpdate({ target: users.telegramId, set: profile })
    .returning();
  const user = await syncAdmin(ctx, row!);
  await ctx.cache.del(cacheKeys.user(user.id));
  return user;
}

/**
 * Пользователь по id (кэш на минуту). isAdmin берётся из конфигурации, а не из базы: если человека
 * убрали из ADMIN_PHONES или ADMIN_TELEGRAM_IDS, права пропадают сразу, а не после следующего входа.
 */
export async function getUser(ctx: Pick<Ctx, "db" | "cache" | "config">, id: string): Promise<User | undefined> {
  let user = await ctx.cache.get<User>(cacheKeys.user(id));
  if (!user) {
    [user] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (user) await ctx.cache.set(cacheKeys.user(id), user, 60);
  }
  return user && { ...user, isAdmin: isConfiguredAdmin(ctx.config, user) };
}

export async function setUserLocale(ctx: Pick<Ctx, "db" | "cache">, id: string, locale: Locale) {
  await ctx.db.update(users).set({ locale }).where(eq(users.id, id));
  await invalidateUser(ctx, id);
}

export async function invalidateUser(ctx: Pick<Ctx, "cache">, id: string) {
  await ctx.cache.del(cacheKeys.user(id));
}

export async function activeSubscriptionEnd(ctx: Pick<Ctx, "db">, userId: string, now = new Date()): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ endsAt: subscriptions.endsAt })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), gt(subscriptions.endsAt, now)))
    .orderBy(desc(subscriptions.endsAt))
    .limit(1);
  return row?.endsAt ?? null;
}

export async function getAccess(ctx: Pick<Ctx, "db">, user: Pick<User, "id" | "freeAccess" | "isAdmin">): Promise<Access & { subscriptionEndsAt: Date | null }> {
  const end = await activeSubscriptionEnd(ctx, user.id);
  return { ...accessFor(user, end !== null), subscriptionEndsAt: end };
}
