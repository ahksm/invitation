import { and, asc, count, eq, lte } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { guests, type Guest, type Invitation } from "../db/schema.js";

/**
 * Модель мест. Каждый гость получает номер места из счётчика invitations.next_seat; номера не
 * переиспользуются, поэтому удалённого и нового гостя не спутать (лимиты SMS, ссылки).
 * Гость персонального приглашения оплачен, если его порядковый номер среди текущих гостей
 * (по seat) не больше paid_seats: удаление гостя сдвигает следующих в оплаченные.
 * В общем приглашении оплачены гости, ответившие сами по общей ссылке (source = self): гости,
 * добавленные владельцем, бывают только у персонального и не открываются оплатой общего шаблона.
 */
type SeatInvitation = Pick<Invitation, "id" | "mode" | "paidSeats">;

/** Оплачен ли гость с порядковым номером rank (с единицы). */
export const paidByRank = (inv: SeatInvitation, guest: Pick<Guest, "source">, rank: number) =>
  inv.mode === "shared" ? guest.source === "self" : rank <= inv.paidSeats;

export async function isGuestPaid(ctx: Pick<Ctx, "db">, inv: SeatInvitation, guest: Pick<Guest, "seat" | "source">): Promise<boolean> {
  if (inv.mode === "shared") return guest.source === "self";
  if (inv.paidSeats <= 0) return false;
  const [row] = await ctx.db
    .select({ rank: count() })
    .from(guests)
    .where(and(eq(guests.invitationId, inv.id), lte(guests.seat, guest.seat)));
  return paidByRank(inv, guest, row?.rank ?? Number.POSITIVE_INFINITY);
}

/** id оплаченных гостей приглашения. */
export async function paidGuestIds(ctx: Pick<Ctx, "db">, inv: SeatInvitation): Promise<Set<string>> {
  if (inv.mode === "shared") {
    const rows = await ctx.db
      .select({ id: guests.id })
      .from(guests)
      .where(and(eq(guests.invitationId, inv.id), eq(guests.source, "self")));
    return new Set(rows.map((r) => r.id));
  }
  if (inv.paidSeats <= 0) return new Set();
  const rows = await ctx.db.select({ id: guests.id }).from(guests).where(eq(guests.invitationId, inv.id)).orderBy(asc(guests.seat)).limit(inv.paidSeats);
  return new Set(rows.map((r) => r.id));
}
