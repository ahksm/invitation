import type { Ctx } from "../context.js";
import { usageEvents } from "../db/schema.js";

export type UsageType =
  | "login"
  | "telegram_linked"
  | "bot_start"
  | "invitation_created"
  | "invitation_updated"
  | "invitation_published"
  | "guests_added"
  | "sms_sent"
  | "order_created"
  | "order_paid"
  | "free_access_granted"
  | "free_access_revoked"
  | "user_blocked"
  | "user_unblocked"
  | "ai_write";

/** Пишет событие в журнал. Ошибка журнала не должна ломать основной запрос. */
export async function track(ctx: Pick<Ctx, "db" | "log">, userId: string | null, type: UsageType, meta: Record<string, unknown> = {}) {
  try {
    await ctx.db.insert(usageEvents).values({ userId, type, meta });
  } catch (err) {
    ctx.log.warn({ err, type }, "не удалось записать событие использования");
  }
}
