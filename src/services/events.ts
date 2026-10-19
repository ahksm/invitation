import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { guests, invitationEvents, type InvitationEventKind } from "../db/schema.js";

/**
 * Лента приглашения (вкладка «Активность»): created, published, paid, opened, yes/no/maybe,
 * reminder, sms, checkin, test. Ошибка записи не ломает основной запрос.
 */
export async function logEvent(
  ctx: Pick<Ctx, "db" | "log">,
  invitationId: string,
  kind: InvitationEventKind,
  opts: { guestId?: string | null; meta?: Record<string, unknown> } = {},
) {
  try {
    await ctx.db.insert(invitationEvents).values({ invitationId, kind, guestId: opts.guestId ?? null, meta: opts.meta ?? {} });
  } catch (err) {
    ctx.log.warn({ err, invitationId, kind }, "не удалось записать событие приглашения");
  }
}

export type ActivityItem = {
  id: string;
  kind: InvitationEventKind;
  guestId: string | null;
  guestName: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
};

/** Последние события приглашения, новые первыми. Имя гостя берётся из текущей записи гостя. */
export async function listActivity(ctx: Pick<Ctx, "db">, invitationId: string, limit: number): Promise<ActivityItem[]> {
  return ctx.db
    .select({
      id: invitationEvents.id,
      kind: invitationEvents.kind,
      guestId: invitationEvents.guestId,
      guestName: guests.name,
      meta: invitationEvents.meta,
      createdAt: invitationEvents.createdAt,
    })
    .from(invitationEvents)
    .leftJoin(guests, eq(guests.id, invitationEvents.guestId))
    .where(eq(invitationEvents.invitationId, invitationId))
    .orderBy(desc(invitationEvents.createdAt), desc(invitationEvents.id))
    .limit(limit);
}
