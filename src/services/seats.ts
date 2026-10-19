import { and, asc, count, eq, lte } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { guests, type Guest, type Invitation } from "../db/schema.js";

/**
 * Модель мест. Каждый гость получает номер места из счётчика invitations.next_seat; номера не
 * переиспользуются, поэтому удалённого и нового гостя не спутать (лимиты SMS, ссылки).
 * Гость персонального приглашения оплачен, если его порядковый номер среди текущих гостей
 * (по seat) не больше paid_seats: удаление гостя сдвигает следующих в оплаченные.
 * В общем приглашении оплачены все.
 */
type SeatInvitation = Pick<Invitation, "id" | "mode" | "paidSeats">;

/** Оплачен ли гость с порядковым номером rank (с единицы). */
export const paidByRank = (inv: SeatInvitation, rank: number) => inv.mode === "shared" || rank <= inv.paidSeats;

export async function isGuestPaid(ctx: Pick<Ctx, "db">, inv: SeatInvitation, guest: Pick<Guest, "seat">): Promise<boolean> {
  if (inv.mode === "shared") return true;
  if (inv.paidSeats <= 0) return false;
  const [row] = await ctx.db
    .select({ rank: count() })
    .from(guests)
    .where(and(eq(guests.invitationId, inv.id), lte(guests.seat, guest.seat)));
  return paidByRank(inv, row?.rank ?? Number.POSITIVE_INFINITY);
}

/** id оплаченных гостей приглашения. */
export async function paidGuestIds(ctx: Pick<Ctx, "db">, inv: SeatInvitation): Promise<Set<string>> {
  const q = ctx.db.select({ id: guests.id }).from(guests).where(eq(guests.invitationId, inv.id)).orderBy(asc(guests.seat));
  const rows = inv.mode === "shared" ? await q : inv.paidSeats > 0 ? await q.limit(inv.paidSeats) : [];
  return new Set(rows.map((r) => r.id));
}
