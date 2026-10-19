import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, max } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import type { Ctx } from "../context.js";
import { guests, invitations, templates, type Guest, type Invitation, type Template } from "../db/schema.js";
import { HttpError } from "../errors.js";

export const randomToken = (bytes = 12) => randomBytes(bytes).toString("base64url");

export async function listActiveTemplates(ctx: Pick<Ctx, "db" | "cache">): Promise<Template[]> {
  return ctx.cache.wrap(cacheKeys.templates, 300, () =>
    ctx.db.select().from(templates).where(eq(templates.isActive, true)).orderBy(asc(templates.title)),
  );
}

export async function invalidateTemplates(ctx: Pick<Ctx, "cache">) {
  await ctx.cache.del(cacheKeys.templates);
}

/** Сбрасывает кэш публичных страниц приглашения (общей и всех гостевых). */
export async function invalidateInvitation(ctx: Pick<Ctx, "db" | "cache">, inv: { id: string; slug: string }) {
  const tokens = await ctx.db.select({ token: guests.token }).from(guests).where(eq(guests.invitationId, inv.id));
  await ctx.cache.del(cacheKeys.publicShared(inv.slug), ...tokens.map((t) => cacheKeys.publicGuest(t.token)));
}

export async function getOwnInvitation(ctx: Pick<Ctx, "db">, userId: string, id: string): Promise<Invitation> {
  const [inv] = await ctx.db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.userId, userId)));
  if (!inv) throw new HttpError(404, "Приглашение не найдено");
  return inv;
}

export async function listOwnInvitations(ctx: Pick<Ctx, "db">, userId: string) {
  return ctx.db
    .select({
      invitation: invitations,
      templateTitle: templates.title,
      templateTranslations: templates.translations,
      guestCount: count(guests.id),
    })
    .from(invitations)
    .innerJoin(templates, eq(templates.id, invitations.templateId))
    .leftJoin(guests, eq(guests.invitationId, invitations.id))
    .where(eq(invitations.userId, userId))
    .groupBy(invitations.id, templates.id)
    .orderBy(desc(invitations.createdAt));
}

export async function createInvitation(
  ctx: Pick<Ctx, "db" | "cache">,
  userId: string,
  input: { templateId: string; mode: "shared" | "personal"; language: string; title: string; data: Record<string, string> },
): Promise<Invitation> {
  const [tpl] = await ctx.db
    .select()
    .from(templates)
    .where(and(eq(templates.id, input.templateId), eq(templates.isActive, true)));
  if (!tpl) throw new HttpError(404, "Шаблон не найден");
  const [inv] = await ctx.db
    .insert(invitations)
    .values({ userId, templateId: tpl.id, mode: input.mode, language: input.language, title: input.title, data: input.data, slug: randomToken(9) })
    .returning();
  return inv!;
}

export async function updateInvitation(
  ctx: Pick<Ctx, "db" | "cache">,
  userId: string,
  id: string,
  patch: { title?: string | undefined; language?: string | undefined; data?: Record<string, string> | undefined },
): Promise<Invitation> {
  const inv = await getOwnInvitation(ctx, userId, id);
  const [updated] = await ctx.db
    .update(invitations)
    .set({
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.language !== undefined && { language: patch.language }),
      ...(patch.data !== undefined && { data: patch.data }),
    })
    .where(eq(invitations.id, inv.id))
    .returning();
  await invalidateInvitation(ctx, inv);
  return updated!;
}

/** Публикует приглашение. Общее нужно оплатить, у персонального должно быть хотя бы одно оплаченное место. */
export async function publishInvitation(ctx: Pick<Ctx, "db" | "cache">, userId: string, id: string): Promise<Invitation> {
  const inv = await getOwnInvitation(ctx, userId, id);
  if (inv.mode === "shared" && !inv.unlocked) throw new HttpError(402, "Сначала оплатите шаблон или оформите подписку");
  if (inv.mode === "personal" && inv.paidSeats < 1) throw new HttpError(402, "Сначала оплатите места для гостей");
  const [updated] = await ctx.db.update(invitations).set({ status: "active" }).where(eq(invitations.id, inv.id)).returning();
  await invalidateInvitation(ctx, inv);
  return updated!;
}

export async function listGuests(ctx: Pick<Ctx, "db">, invitationId: string): Promise<Guest[]> {
  return ctx.db.select().from(guests).where(eq(guests.invitationId, invitationId)).orderBy(asc(guests.seat));
}

/** Добавляет гостей. Ссылки гостей сверх оплаченных мест не открываются, пока места не оплачены. */
export async function addGuests(
  ctx: Pick<Ctx, "db">,
  userId: string,
  invitationId: string,
  list: { name: string; phone?: string | null | undefined }[],
): Promise<Guest[]> {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  if (inv.mode !== "personal") throw new HttpError(400, "Гости добавляются только в персональное приглашение");
  return ctx.db.transaction(async (tx) => {
    // Блокируем приглашение, чтобы номера мест не пересеклись при параллельных запросах.
    await tx.select({ id: invitations.id }).from(invitations).where(eq(invitations.id, inv.id)).for("update");
    const [row] = await tx.select({ last: max(guests.seat) }).from(guests).where(eq(guests.invitationId, inv.id));
    const start = (row?.last ?? 0) + 1;
    return tx
      .insert(guests)
      .values(list.map((g, i) => ({ invitationId: inv.id, name: g.name, phone: g.phone ?? null, seat: start + i, token: randomToken() })))
      .returning();
  });
}

export async function updateGuest(
  ctx: Pick<Ctx, "db" | "cache">,
  userId: string,
  invitationId: string,
  guestId: string,
  patch: { name?: string | undefined; phone?: string | null | undefined },
): Promise<Guest> {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  const [g] = await ctx.db
    .update(guests)
    .set(patch)
    .where(and(eq(guests.id, guestId), eq(guests.invitationId, inv.id)))
    .returning();
  if (!g) throw new HttpError(404, "Гость не найден");
  await ctx.cache.del(cacheKeys.publicGuest(g.token));
  return g;
}

export async function removeGuest(ctx: Pick<Ctx, "db" | "cache">, userId: string, invitationId: string, guestId: string) {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  const [g] = await ctx.db
    .delete(guests)
    .where(and(eq(guests.id, guestId), eq(guests.invitationId, inv.id)))
    .returning();
  if (!g) throw new HttpError(404, "Гость не найден");
  await ctx.cache.del(cacheKeys.publicGuest(g.token));
}

export type PublicView = {
  title: string;
  language: string;
  template: { slug: string; title: string };
  data: Record<string, string>;
  guest?: { name: string; rsvp: string };
};

export async function publicShared(ctx: Pick<Ctx, "db" | "cache">, slug: string): Promise<PublicView | null> {
  return ctx.cache.wrap(cacheKeys.publicShared(slug), 300, async () => {
    const [row] = await ctx.db
      .select({ inv: invitations, tpl: templates })
      .from(invitations)
      .innerJoin(templates, eq(templates.id, invitations.templateId))
      .where(eq(invitations.slug, slug));
    if (!row || row.inv.mode !== "shared" || row.inv.status !== "active" || !row.inv.unlocked) return null;
    return { title: row.inv.title, language: row.inv.language, template: { slug: row.tpl.slug, title: row.tpl.title }, data: row.inv.data };
  });
}

export async function publicGuest(ctx: Pick<Ctx, "db" | "cache">, token: string): Promise<PublicView | null> {
  return ctx.cache.wrap(cacheKeys.publicGuest(token), 120, async () => {
    const [row] = await ctx.db
      .select({ g: guests, inv: invitations, tpl: templates })
      .from(guests)
      .innerJoin(invitations, eq(invitations.id, guests.invitationId))
      .innerJoin(templates, eq(templates.id, invitations.templateId))
      .where(eq(guests.token, token));
    if (!row || row.inv.status !== "active" || row.g.seat > row.inv.paidSeats) return null;
    return {
      title: row.inv.title,
      language: row.inv.language,
      template: { slug: row.tpl.slug, title: row.tpl.title },
      data: row.inv.data,
      guest: { name: row.g.name, rsvp: row.g.rsvp },
    };
  });
}

export async function setRsvp(ctx: Pick<Ctx, "db" | "cache">, token: string, rsvp: "yes" | "no" | "maybe"): Promise<boolean> {
  const view = await publicGuest(ctx, token);
  if (!view) return false;
  await ctx.db.update(guests).set({ rsvp, openedAt: new Date() }).where(eq(guests.token, token));
  await ctx.cache.del(cacheKeys.publicGuest(token));
  return true;
}
