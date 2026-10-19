import { and, asc, count, eq, isNull } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import type { Ctx } from "../context.js";
import { defaultInvitationSettings, guests, invitations, type Guest, type GuestDiet, type Invitation } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { logEvent } from "./events.js";
import { appUrlOf, getOwnInvitation, invalidateInvitation, randomToken } from "./invitations.js";
import { notifyOwnerLater } from "./notify.js";
import { isGuestPaid, paidByRank } from "./seats.js";
import { guestSmsStatuses } from "./sms.js";

export type GuestDto = {
  id: string;
  name: string;
  phone: string | null;
  seat: number;
  token: string;
  link: string;
  rsvp: Guest["rsvp"];
  plus: number;
  group: Guest["group"];
  tableNo: number;
  checkedIn: boolean;
  checkedInAt: Date | null;
  message: string;
  diet: GuestDiet[];
  source: Guest["source"];
  openedAt: Date | null;
  respondedAt: Date | null;
  telegramLinked: boolean;
  paid: boolean;
  sms: { status: string; count: number } | null;
};

export const guestLink = (ctx: Pick<Ctx, "config">, token: string) => `${appUrlOf(ctx)}/g/${token}`;

export function toGuestDto(ctx: Pick<Ctx, "config">, g: Guest, extra: { paid: boolean; sms?: { status: string; count: number } | undefined }): GuestDto {
  return {
    id: g.id,
    name: g.name,
    phone: g.phone,
    seat: g.seat,
    token: g.token,
    link: guestLink(ctx, g.token),
    rsvp: g.rsvp,
    plus: g.plus,
    group: g.group,
    tableNo: g.tableNo,
    checkedIn: g.checkedInAt !== null,
    checkedInAt: g.checkedInAt,
    message: g.message ?? "",
    diet: g.diet,
    source: g.source,
    openedAt: g.openedAt,
    respondedAt: g.respondedAt,
    telegramLinked: g.telegramChatId !== null,
    paid: extra.paid,
    sms: extra.sms ? { status: extra.sms.status, count: extra.sms.count } : null,
  };
}

/** Гости приглашения по номеру места, с оплатой и статусом SMS. */
export async function listGuestDtos(ctx: Pick<Ctx, "db" | "config">, inv: Pick<Invitation, "id" | "mode" | "paidSeats">): Promise<GuestDto[]> {
  const [list, sms] = await Promise.all([
    ctx.db.select().from(guests).where(eq(guests.invitationId, inv.id)).orderBy(asc(guests.seat)),
    guestSmsStatuses(ctx, inv.id),
  ]);
  return list.map((g, i) => toGuestDto(ctx, g, { paid: paidByRank(inv, i + 1), sms: sms.get(g.id) }));
}

async function guestDto(ctx: Pick<Ctx, "db" | "config">, inv: Invitation, g: Guest): Promise<GuestDto> {
  const [paid, sms] = await Promise.all([isGuestPaid(ctx, inv, g), guestSmsStatuses(ctx, inv.id)]);
  return toGuestDto(ctx, g, { paid, sms: sms.get(g.id) });
}

/**
 * Номера мест для n новых гостей. Вызывается в транзакции: приглашение блокируется,
 * чтобы параллельные запросы не получили одинаковые номера.
 */
export async function takeSeats(tx: Pick<Ctx["db"], "select" | "update">, invitationId: string, n: number): Promise<number> {
  const [row] = await tx.select({ next: invitations.nextSeat }).from(invitations).where(eq(invitations.id, invitationId)).for("update");
  if (!row) throw new HttpError(404, "Приглашение не найдено");
  await tx
    .update(invitations)
    .set({ nextSeat: row.next + n })
    .where(eq(invitations.id, invitationId));
  return row.next;
}

export type NewGuest = { name: string; phone?: string | null | undefined; group?: Guest["group"] | undefined; plus?: number | undefined };

/** Добавляет гостей персонального приглашения. Ссылки гостей сверх оплаченных мест не открываются, пока места не оплачены. */
export async function addGuests(ctx: Pick<Ctx, "db" | "config">, userId: string, invitationId: string, list: NewGuest[]): Promise<GuestDto[]> {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  if (inv.mode !== "personal") throw new HttpError(400, "Гости добавляются только в персональное приглашение");
  const { added, before } = await ctx.db.transaction(async (tx) => {
    const start = await takeSeats(tx, inv.id, list.length);
    const [{ n: before } = { n: 0 }] = await tx.select({ n: count() }).from(guests).where(eq(guests.invitationId, inv.id));
    const added = await tx
      .insert(guests)
      .values(
        list.map((g, i) => ({
          invitationId: inv.id,
          name: g.name,
          phone: g.phone ?? null,
          group: g.group ?? "other",
          plus: g.plus ?? 0,
          seat: start + i,
          token: randomToken(),
        })),
      )
      .returning();
    return { added, before };
  });
  return added.map((g, i) => toGuestDto(ctx, g, { paid: paidByRank(inv, before + i + 1) }));
}

export type GuestPatch = {
  name?: string | undefined;
  phone?: string | null | undefined;
  group?: Guest["group"] | undefined;
  plus?: number | undefined;
  tableNo?: number | undefined;
  checkedIn?: boolean | undefined;
  rsvp?: Guest["rsvp"] | undefined;
};

export async function updateGuest(
  ctx: Pick<Ctx, "db" | "cache" | "config" | "notifier" | "log">,
  userId: string,
  invitationId: string,
  guestId: string,
  patch: GuestPatch,
): Promise<GuestDto> {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  const [g] = await ctx.db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.invitationId, inv.id)));
  if (!g) throw new HttpError(404, "Гость не найден");
  const tables = inv.settings.tables ?? defaultInvitationSettings.tables;
  if (patch.tableNo !== undefined && patch.tableNo > tables) throw new HttpError(400, "Такого стола нет");

  const set: Partial<typeof guests.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.group !== undefined) set.group = patch.group;
  if (patch.plus !== undefined) set.plus = patch.plus;
  if (patch.tableNo !== undefined) set.tableNo = patch.tableNo;
  if (patch.rsvp !== undefined && patch.rsvp !== g.rsvp) {
    // Владелец отмечает ответ за гостя (например, тот ответил по телефону).
    set.rsvp = patch.rsvp;
    set.respondedAt = patch.rsvp === "pending" ? null : new Date();
  }
  const checkIn = patch.checkedIn === true && g.checkedInAt === null;
  if (checkIn) set.checkedInAt = new Date();
  if (patch.checkedIn === false) set.checkedInAt = null;
  if (!Object.keys(set).length) return guestDto(ctx, inv, g);

  const [updated] = await ctx.db.update(guests).set(set).where(eq(guests.id, g.id)).returning();
  if (checkIn) {
    await logEvent(ctx, inv.id, "checkin", { guestId: g.id });
    notifyOwnerLater(ctx, inv.id, { kind: "checkin", guestName: updated!.name });
  }
  // Имя, ответ и число гостей видны на страницах других гостей («Кто придёт»).
  await invalidateInvitation(ctx, inv);
  return guestDto(ctx, inv, updated!);
}

export async function removeGuest(ctx: Pick<Ctx, "db" | "cache">, userId: string, invitationId: string, guestId: string) {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  const [g] = await ctx.db
    .delete(guests)
    .where(and(eq(guests.id, guestId), eq(guests.invitationId, inv.id)))
    .returning({ token: guests.token });
  if (!g) throw new HttpError(404, "Гость не найден");
  // Следующие гости могли стать оплаченными, а ответ удалённого пропадает из «Кто придёт».
  await ctx.cache.del(cacheKeys.publicGuest(g.token));
  await invalidateInvitation(ctx, inv);
}

/** Отметка на входе по токену из QR (ссылка /g/<token>). Повторная отметка ничего не меняет. */
export async function checkInByToken(
  ctx: Pick<Ctx, "db" | "cache" | "config" | "notifier" | "log">,
  userId: string,
  invitationId: string,
  token: string,
) {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  const [first] = await ctx.db
    .update(guests)
    .set({ checkedInAt: new Date() })
    .where(and(eq(guests.token, token), eq(guests.invitationId, inv.id), isNull(guests.checkedInAt)))
    .returning();
  const [g] = first
    ? [first]
    : await ctx.db
        .select()
        .from(guests)
        .where(and(eq(guests.token, token), eq(guests.invitationId, inv.id)));
  if (!g) throw new HttpError(404, "Гость не найден");
  if (first) {
    await logEvent(ctx, inv.id, "checkin", { guestId: g.id });
    await invalidateInvitation(ctx, inv);
    notifyOwnerLater(ctx, inv.id, { kind: "checkin", guestName: g.name });
  }
  return { guest: await guestDto(ctx, inv, g) };
}
