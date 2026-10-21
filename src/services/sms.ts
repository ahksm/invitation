import { and, asc, count, eq, inArray, notInArray } from "drizzle-orm";
import { cacheKeys, type Lock } from "../cache.js";
import { coerceContent, type InvContent } from "../content.js";
import type { Ctx } from "../context.js";
import { guests, smsMessages, templates, type Guest, type Invitation } from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { pickLocale, type Locale } from "../i18n.js";
import { formatSmsDate, inviteText } from "../sms/texts.js";
import { logEvent } from "./events.js";
import { appUrlOf, assertNotArchived, getOwnInvitation } from "./invitations.js";
import { paidGuestIds } from "./seats.js";
import { track } from "./usage.js";

/** Сколько SMS (приглашение, повторы и напоминания вместе) можно отправить одному гостю. */
export const MAX_SMS_PER_GUEST = 3;
/** SMS гостям в час на пользователя, по всем его приглашениям. */
export const HOURLY_LIMIT_PER_USER = 300;
// SMS, которые считаются отправленными (неудачные в лимиты не входят).
const COUNTED = ["queued", "sent", "delivered"] as const;
// SMS гостям: на них действуют лимиты на гостя и на приглашение.
const GUEST_SMS = ["invite", "reminder"] as const;
type GuestSmsPurpose = (typeof GUEST_SMS)[number];
// Блокировка рассылки продлевается на каждом госте, поэтому срок короткий.
const SEND_LOCK_TTL = 120;

export type SkipReason = "no_phone" | "seat_unpaid" | "already_sent" | "limit_reached" | "invitation_limit" | "rate_limited" | "send_failed";

const hourKey = (userId: string) => `sms:user:${userId}`;

/** Часовой лимит уже исчерпан: проверяется до рассылки, чтобы не начинать её зря. */
export async function hourlyLimitReached(ctx: Pick<Ctx, "cache">, userId: string) {
  return (await ctx.cache.hits(hourKey(userId))) >= HOURLY_LIMIT_PER_USER;
}

/**
 * Рассылки гостям одного приглашения (SMS и напоминания) идут по одной: двойной клик или повтор
 * запроса не отправит SMS дважды и не обойдёт лимиты, прочитанные до начала рассылки.
 */
export async function withSendLock<T>(ctx: Pick<Ctx, "cache" | "log">, invitationId: string, run: (lock: Lock) => Promise<T>): Promise<T> {
  const lock = await ctx.cache.lock(cacheKeys.sendLock(invitationId), SEND_LOCK_TTL);
  if (!lock) throw new HttpError(409, "Рассылка уже идёт, подождите");
  try {
    return await run(lock);
  } finally {
    await lock.release().catch((err) => ctx.log.warn({ err, invitationId }, "не удалось снять блокировку рассылки"));
  }
}

export type SmsTemplate = { smsEnabled: boolean; event: string | null; style: string | null; title: string };

export async function smsTemplate(ctx: Pick<Ctx, "db">, inv: Pick<Invitation, "templateId">): Promise<SmsTemplate> {
  const [tpl] = await ctx.db
    .select({ smsEnabled: templates.smsEnabled, event: templates.event, style: templates.style, title: templates.title })
    .from(templates)
    .where(eq(templates.id, inv.templateId));
  if (!tpl) throw new HttpError(404, "Шаблон не найден");
  return tpl;
}

/**
 * Как приглашение называется в SMS и напоминаниях: имена (data.names), иначе событие на языке
 * приглашения, иначе название шаблона. Отдельного «внутреннего» названия у приглашения нет.
 */
export function eventTitle(data: InvContent, tpl: Pick<SmsTemplate, "event" | "title">, locale: Locale): string {
  return data.names?.trim() || eventLabel(tpl.event, locale) || tpl.title;
}

/** Данные для текста SMS: язык приглашения, заголовок и дата события. */
export function smsContext(inv: Pick<Invitation, "language" | "data">, tpl: SmsTemplate) {
  const locale = pickLocale(inv.language);
  const data = coerceContent(inv.data, tpl.style);
  return { locale, data, event: eventTitle(data, tpl, locale), date: formatSmsDate(data.date) };
}

/**
 * Отправитель SMS гостям одного приглашения с лимитами: 3 SMS на гостя, paidSeats × 3 на приглашение
 * (SMS удалённых гостей тоже считаются: они остаются в sms_messages с invitation_id) и часовой лимит
 * пользователя. Счётчики читаются один раз, поэтому вызывать только под withSendLock.
 */
export async function guestSmsSender(ctx: Ctx, userId: string, inv: Pick<Invitation, "id" | "paidSeats">, guestIds: string[]) {
  const perGuestRows = guestIds.length
    ? await ctx.db
        .select({ guestId: smsMessages.guestId, purpose: smsMessages.purpose, n: count() })
        .from(smsMessages)
        .where(and(inArray(smsMessages.purpose, GUEST_SMS), inArray(smsMessages.guestId, guestIds), inArray(smsMessages.status, COUNTED)))
        .groupBy(smsMessages.guestId, smsMessages.purpose)
    : [];
  const perGuest = new Map<string, number>();
  const invited = new Set<string>();
  for (const r of perGuestRows) {
    if (!r.guestId) continue;
    perGuest.set(r.guestId, (perGuest.get(r.guestId) ?? 0) + r.n);
    if (r.purpose === "invite") invited.add(r.guestId);
  }
  const [{ n: total } = { n: 0 }] = await ctx.db
    .select({ n: count() })
    .from(smsMessages)
    .where(and(eq(smsMessages.invitationId, inv.id), inArray(smsMessages.purpose, GUEST_SMS), inArray(smsMessages.status, COUNTED)));
  let budget = inv.paidSeats * MAX_SMS_PER_GUEST - total;
  let limited = await hourlyLimitReached(ctx, userId);
  const appUrl = appUrlOf(ctx);
  // Секрет кодируется: «+», «/», «=» и «&» из base64 иначе пришли бы обратно другими символами.
  const callbackUrl = ctx.config.SMS_CALLBACK_SECRET
    ? `${appUrl}/api/sms/${ctx.sms.name}/callback?secret=${encodeURIComponent(ctx.config.SMS_CALLBACK_SECRET)}`
    : undefined;

  return {
    /** Часовой лимит кончился: остальным гостям SMS не отправляются. */
    get limited() {
      return limited;
    },
    /** Гостю уже уходило SMS-приглашение. */
    invited: (guestId: string) => invited.has(guestId),
    /** Отправляет SMS, если позволяют лимиты. null: отправлено, иначе причина пропуска. */
    async send(g: Pick<Guest, "id"> & { phone: string }, purpose: GuestSmsPurpose, text: string): Promise<SkipReason | null> {
      if ((perGuest.get(g.id) ?? 0) >= MAX_SMS_PER_GUEST) return "limit_reached";
      if (budget <= 0) return "invitation_limit";
      if (limited) return "rate_limited";
      if (await ctx.cache.hit(hourKey(userId), HOURLY_LIMIT_PER_USER, 3600)) {
        limited = true;
        return "rate_limited";
      }
      const [row] = await ctx.db
        .insert(smsMessages)
        .values({ purpose, phone: g.phone, text, userId, invitationId: inv.id, guestId: g.id, provider: ctx.sms.name })
        .returning({ id: smsMessages.id });
      try {
        const { providerRef } = await ctx.sms.send(g.phone, text, { callbackUrl });
        await ctx.db.update(smsMessages).set({ status: "sent", providerRef }).where(eq(smsMessages.id, row!.id));
      } catch (err) {
        await ctx.db.update(smsMessages).set({ status: "failed", error: String(err).slice(0, 500) }).where(eq(smsMessages.id, row!.id));
        ctx.log.error({ err, guestId: g.id, purpose }, "SMS гостю не отправлено");
        return "send_failed";
      }
      perGuest.set(g.id, (perGuest.get(g.id) ?? 0) + 1);
      budget--;
      if (purpose === "invite") invited.add(g.id);
      return null;
    },
  };
}

/**
 * Рассылает гостям персонального приглашения SMS со ссылкой.
 * Только для опубликованных приглашений, шаблонов с включёнными SMS и оплаченных гостей.
 * Без guestIds («всем») пропускает гостей, которым приглашение уже уходило: повтор рассылки после
 * часового лимита дошлёт остальным, а не продублирует. Повторное SMS конкретному гостю — через guestIds.
 * Часовой лимит не обрывает рассылку ошибкой: отправленные засчитываются, остальные помечаются rate_limited.
 */
export async function sendInvitationSms(ctx: Ctx, userId: string, invitationId: string, guestIds?: string[]) {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  assertNotArchived(inv);
  if (inv.mode !== "personal") throw new HttpError(400, "SMS отправляются гостям персонального приглашения");
  if (inv.status !== "active") throw new HttpError(400, "Сначала опубликуйте приглашение");
  const tpl = await smsTemplate(ctx, inv);
  if (!tpl.smsEnabled) throw new HttpError(403, "Для этого шаблона рассылка SMS недоступна");
  if (await hourlyLimitReached(ctx, userId)) throw new HttpError(429, "Слишком много SMS за час, попробуйте позже");

  return withSendLock(ctx, inv.id, async (lock) => {
    const list = await ctx.db
      .select()
      .from(guests)
      .where(and(eq(guests.invitationId, inv.id), guestIds?.length ? inArray(guests.id, guestIds) : undefined))
      .orderBy(asc(guests.seat));
    const paid = await paidGuestIds(ctx, inv);
    const sender = await guestSmsSender(
      ctx,
      userId,
      inv,
      list.map((g) => g.id),
    );
    const { locale, event, date } = smsContext(inv, tpl);
    const appUrl = appUrlOf(ctx);
    const sent: string[] = [];
    const skipped: { guestId: string; name: string; reason: SkipReason }[] = [];

    for (const g of list) {
      const skip = (reason: SkipReason) => skipped.push({ guestId: g.id, name: g.name, reason });
      if (!g.phone) { skip("no_phone"); continue; }
      if (!paid.has(g.id)) { skip("seat_unpaid"); continue; }
      if (!guestIds?.length && sender.invited(g.id)) { skip("already_sent"); continue; }
      await lock.extend();
      const text = inviteText(locale, { guestName: g.name, event, date, link: `${appUrl}/g/${g.token}` });
      const reason = await sender.send({ id: g.id, phone: g.phone }, "invite", text);
      if (reason) skip(reason);
      else sent.push(g.id);
    }
    if (sent.length) {
      await track(ctx, userId, "sms_sent", { invitationId: inv.id, count: sent.length });
      await logEvent(ctx, inv.id, "sms", { guestId: sent.length === 1 ? sent[0] : null, meta: { n: sent.length } });
    }
    return { sent: sent.length, skipped, limited: sender.limited };
  });
}

/**
 * Статусы SMS по гостям приглашения: статус последней отправки каждому (в том числе неудачной) и
 * count — сколько SMS засчитано в лимит MAX_SMS_PER_GUEST (приглашения и напоминания, без неудачных).
 */
export async function guestSmsStatuses(ctx: Pick<Ctx, "db">, invitationId: string) {
  const rows = await ctx.db
    .select({ guestId: smsMessages.guestId, status: smsMessages.status, createdAt: smsMessages.createdAt })
    .from(smsMessages)
    .where(and(eq(smsMessages.invitationId, invitationId), inArray(smsMessages.purpose, GUEST_SMS)))
    .orderBy(smsMessages.createdAt, smsMessages.id);
  const counted = new Set<string>(COUNTED);
  const map = new Map<string, { status: string; at: Date; count: number }>();
  for (const r of rows) {
    if (!r.guestId) continue;
    const prev = map.get(r.guestId);
    map.set(r.guestId, { status: r.status, at: r.createdAt, count: (prev?.count ?? 0) + (counted.has(r.status) ? 1 : 0) });
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
