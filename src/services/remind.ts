import { and, asc, eq, inArray } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { guests } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { reminderText } from "../sms/texts.js";
import { logEvent } from "./events.js";
import { guestLink } from "./guests.js";
import { assertNotArchived, getOwnInvitation } from "./invitations.js";
import { notifyText } from "./notify.js";
import { longDate } from "./public.js";
import { paidGuestIds } from "./seats.js";
import { guestSmsSender, smsContext, smsTemplate, withSendLock, type SkipReason } from "./sms.js";
import { track } from "./usage.js";

/** Одно напоминание гостю за 12 часов: повторное нажатие «Напомнить» не шлёт второе сообщение. */
const REMIND_COOLDOWN = 12 * 3600;

/** no_channel: у гостя нет Telegram, а SMS для приглашения недоступны; recently_reminded: напоминание уже было. */
export type RemindSkipReason = SkipReason | "no_channel" | "recently_reminded";

export type RemindResult = {
  telegram: number;
  sms: number;
  skipped: { guestId: string; name: string; reason: RemindSkipReason }[];
  limited: boolean;
};

/**
 * Напоминает гостям ответить на приглашение. По умолчанию всем гостям без ответа, с guestIds
 * указанным. Сначала Telegram (гость подключил бота), иначе SMS по правилам рассылки: персональное
 * приглашение, шаблон с SMS и общие лимиты с SMS-приглашениями. Только оплаченным гостям
 * опубликованного приглашения: иначе ссылка не откроется.
 */
export async function remindGuests(ctx: Ctx, userId: string, invitationId: string, guestIds?: string[]): Promise<RemindResult> {
  const inv = await getOwnInvitation(ctx, userId, invitationId);
  assertNotArchived(inv);
  if (inv.status !== "active") throw new HttpError(400, "Сначала опубликуйте приглашение");
  const tpl = await smsTemplate(ctx, inv);

  return withSendLock(ctx, inv.id, async (lock) => {
    const list = await ctx.db
      .select()
      .from(guests)
      .where(and(eq(guests.invitationId, inv.id), guestIds?.length ? inArray(guests.id, guestIds) : eq(guests.rsvp, "pending")))
      .orderBy(asc(guests.seat));
    const paid = await paidGuestIds(ctx, inv);
    const sender =
      inv.mode === "personal" && tpl.smsEnabled
        ? await guestSmsSender(
            ctx,
            userId,
            inv,
            list.map((g) => g.id),
          )
        : null;
    const { locale, data, event, date } = smsContext(inv, tpl);
    const longWhen = data.date ? `, ${longDate(data.date, locale)}${data.time ? `, ${data.time}` : ""}` : "";
    const result: RemindResult = { telegram: 0, sms: 0, skipped: [], limited: false };

    for (const g of list) {
      const skip = (reason: RemindSkipReason) => result.skipped.push({ guestId: g.id, name: g.name, reason });
      if (!paid.has(g.id)) { skip("seat_unpaid"); continue; }
      const chatId = ctx.notifier.enabled ? g.telegramChatId : null;
      if (chatId === null && !sender) { skip("no_channel"); continue; }
      if (chatId === null && !g.phone) { skip("no_phone"); continue; }
      const cooldown = `remind:${g.id}`;
      if (!(await ctx.cache.claim(cooldown, REMIND_COOLDOWN))) { skip("recently_reminded"); continue; }
      await lock.extend();

      const link = guestLink(ctx, g.token);
      if (chatId !== null) {
        const text = notifyText(locale, "remind", { name: g.name, event, date: longWhen });
        if (await ctx.notifier.sendToChat(chatId, text, { buttons: [{ text: notifyText(locale, "openInvitation"), url: link }] })) {
          result.telegram++;
          continue;
        }
      }
      // Telegram не принял (гость остановил бота) или его нет: SMS, если можно.
      const reason: SkipReason | null =
        sender && g.phone ? await sender.send({ id: g.id, phone: g.phone }, "reminder", reminderText(locale, { guestName: g.name, event, date, link })) : "send_failed";
      if (reason) {
        await ctx.cache.del(cooldown);
        skip(reason);
        continue;
      }
      result.sms++;
    }

    result.limited = sender?.limited ?? false;
    const n = result.telegram + result.sms;
    if (result.sms) await track(ctx, userId, "sms_sent", { invitationId: inv.id, count: result.sms, purpose: "reminder" });
    if (n) await logEvent(ctx, inv.id, "reminder", { meta: { n } });
    return result;
  });
}
