import { and, desc, eq, gt } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
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

/** Создаёт или обновляет пользователя по данным Telegram. Админы задаются через ADMIN_TELEGRAM_IDS. */
export async function upsertTelegramUser(ctx: Pick<Ctx, "db" | "cache" | "config">, tg: TelegramProfile): Promise<User> {
  const isAdmin = ctx.config.ADMIN_TELEGRAM_IDS.includes(String(tg.id));
  const profile = {
    username: tg.username ?? null,
    firstName: tg.first_name ?? null,
    lastName: tg.last_name ?? null,
    lastSeenAt: new Date(),
    isAdmin,
  };
  const [user] = await ctx.db
    .insert(users)
    .values({ telegramId: tg.id, locale: pickLocale(tg.language_code), ...profile })
    .onConflictDoUpdate({ target: users.telegramId, set: profile })
    .returning();
  await ctx.cache.del(cacheKeys.user(user!.id));
  return user!;
}

export async function getUser(ctx: Pick<Ctx, "db" | "cache">, id: string): Promise<User | undefined> {
  const cached = await ctx.cache.get<User>(cacheKeys.user(id));
  if (cached) return cached;
  const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
  if (user) await ctx.cache.set(cacheKeys.user(id), user, 60);
  return user;
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
