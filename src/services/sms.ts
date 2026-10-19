import { and, count, eq, inArray, notInArray } from "drizzle-orm";
import { coerceContent } from "../content.js";
import type { Ctx } from "../context.js";
import { guests, smsMessages, templates } from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { pickLocale } from "../i18n.js";
import { formatSmsDate, inviteText } from "../sms/texts.js";
import { logEvent } from "./events.js";
import { appUrlOf, getOwnInvitation } from "./invitations.js";
import { paidGuestIds } from "./seats.js";
import { track } from "./usage.js";

/** Сколько SMS с приглашением можно отправить одному гостю (первое и два повтора). */
export const MAX_INVITE_SMS_PER_GUEST = 3;
const HOURLY_LIMIT_PER_USER = 300;
// SMS, которые считаются отправленными (неудачные в лимиты не входят).
const COUNTED = ["queued", "sent", "delivered"] as const;

export type SkipReason = "no_phone" | "seat_unpaid" | "limit_reached" | "invitation_limit" | "send_failed";

/**
 * Рассылает гостям персонального приглашения SMS со ссылкой.
 * Только для опубликованных приглашений, шаблонов с включёнными SMS и оплаченных гостей.
 * Лимиты: 3 SMS на гостя и paidSeats × 3 на приглашение (SMS удалённых гостей тоже считаются).
 */
export async function sendInvitationSms(ctx: Ctx, userId: string, invitationId: string, guestIds?: string[]) {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  if (inv.mode !== "personal") throw new HttpError(400, "SMS отправляются гостям персонального приглашения");
  if (inv.status !== "active") throw new HttpError(400, "Сначала опубликуйте приглашение");
  const [tpl] = await ctx.db
    .select({ smsEnabled: templates.smsEnabled, event: templates.event, style: templates.style, title: templates.title })
    .from(templates)
    .where(eq(templates.id, inv.templateId));
  if (!tpl?.smsEnabled) throw new HttpError(403, "Для этого шаблона рассылка SMS недоступна");

  const list = await ctx.db
    .select()
    .from(guests)
    .where(and(eq(guests.invitationId, inv.id), guestIds?.length ? inArray(guests.id, guestIds) : undefined));
  const ids = list.map((g) => g.id);
  const sentCounts = ids.length
    ? await ctx.db
        .select({ guestId: smsMessages.guestId, n: count() })
        .from(smsMessages)
        .where(and(eq(smsMessages.purpose, "invite"), inArray(smsMessages.guestId, ids), inArray(smsMessages.status, COUNTED)))
        .groupBy(smsMessages.guestId)
    : [];
  const already = new Map(sentCounts.map((r) => [r.guestId, r.n]));
  const [{ n: invitationTotal } = { n: 0 }] = await ctx.db
    .select({ n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.purpose, "invite"), eq(smsMessages.invitationId, inv.id), inArray(smsMessages.status, COUNTED)));
  let budget = inv.paidSeats * MAX_INVITE_SMS_PER_GUEST - invitationTotal;
  const paid = await paidGuestIds(ctx, inv);

  const locale = pickLocale(inv.language);
  const data = coerceContent(inv.data, tpl.style);
  const event = data.names?.trim() || eventLabel(tpl.event, locale) || tpl.title;
  const appUrl = appUrlOf(ctx);
  const callbackUrl = ctx.config.SMS_CALLBACK_SECRET ? `${appUrl}/api/sms/${ctx.sms.name}/callback?secret=${ctx.config.SMS_CALLBACK_SECRET}` : undefined;
  const sent: string[] = [];
  const skipped: { guestId: string; name: string; reason: SkipReason }[] = [];

  for (const g of list) {
    const skip = (reason: SkipReason) => skipped.push({ guestId: g.id, name: g.name, reason });
    if (!g.phone) { skip("no_phone"); continue; }
    if (!paid.has(g.id)) { skip("seat_unpaid"); continue; }
    if ((already.get(g.id) ?? 0) >= MAX_INVITE_SMS_PER_GUEST) { skip("limit_reached"); continue; }
    if (budget <= 0) { skip("invitation_limit"); continue; }
    if (await ctx.cache.hit(`sms:user:${userId}`, HOURLY_LIMIT_PER_USER, 3600)) throw new HttpError(429, "Слишком много SMS за час, попробуйте позже");

    const text = inviteText(locale, {
      guestName: g.name,
      event,
      date: formatSmsDate(data.date),
      link: `${appUrl}/g/${g.token}`,
    });
    const [row] = await ctx.db
      .insert(smsMessages)
      .values({ purpose: "invite", phone: g.phone, text, userId, invitationId: inv.id, guestId: g.id, provider: ctx.sms.name })
      .returning({ id: smsMessages.id });
    try {
      const { providerRef } = await ctx.sms.send(g.phone, text, { callbackUrl });
      await ctx.db.update(smsMessages).set({ status: "sent", providerRef }).where(eq(smsMessages.id, row!.id));
      sent.push(g.id);
      budget--;
    } catch (err) {
      await ctx.db.update(smsMessages).set({ status: "failed", error: String(err).slice(0, 500) }).where(eq(smsMessages.id, row!.id));
      ctx.log.error({ err, guestId: g.id }, "SMS приглашения не отправлено");
      skip("send_failed");
    }
  }
  if (sent.length) {
    await track(ctx, userId, "sms_sent", { invitationId: inv.id, count: sent.length });
    await logEvent(ctx, inv.id, "sms", { guestId: sent.length === 1 ? sent[0] : null, meta: { n: sent.length } });
  }
  return { sent: sent.length, skipped };
}

/** Статусы SMS по гостям приглашения: последняя отправка каждому. */
export async function guestSmsStatuses(ctx: Pick<Ctx, "db">, invitationId: string) {
  const rows = await ctx.db
    .select({ guestId: smsMessages.guestId, status: smsMessages.status, createdAt: smsMessages.createdAt })
    .from(smsMessages)
    .where(and(eq(smsMessages.invitationId, invitationId), eq(smsMessages.purpose, "invite")))
    .orderBy(smsMessages.createdAt);
  const map = new Map<string, { status: string; at: Date; count: number }>();
  for (const r of rows) {
    if (!r.guestId) continue;
    const prev = map.get(r.guestId);
    map.set(r.guestId, { status: r.status, at: r.createdAt, count: (prev?.count ?? 0) + 1 });
  }
  return map;
}

export async function applySmsDelivery(ctx: Pick<Ctx, "db">, providerRef: string, status: "sent" | "delivered" | "failed") {
  // Колбэки могут прийти не по порядку: промежуточный статус не затирает итоговый.
  await ctx.db
    .update(smsMessages)
    .set({ status })
    .where(and(eq(smsMessages.providerRef, providerRef), notInArray(smsMessages.status, ["delivered", "failed"])));
}
