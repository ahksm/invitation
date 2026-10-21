import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import type { InvContent } from "../content.js";
import type { Ctx } from "../context.js";
import { defaultInvitationSettings, guestReminders, guests, invitations, templates, type InvitationSettings } from "../db/schema.js";
import type { NotifyButton } from "../notifier.js";
import { logEvent } from "./events.js";
import { guestLink } from "./guests.js";
import { notifyText } from "./notify.js";
import { longDate } from "./public.js";
import { paidGuestIds } from "./seats.js";
import { smsContext } from "./sms.js";

/**
 * Напоминания гостям в Telegram по настройкам приглашения (вкладка «Бот»): r1d — за сутки до начала,
 * r3h — за 3 часа, morning — в 9:00 по Ташкенту в день события. Задача раз в минуту (startReminderJob)
 * берёт опубликованные приглашения с событием сегодня или завтра и гостей, которые подключили бота
 * и ответили «да», «может быть» или ещё не ответили. Напоминание записывается в guest_reminders до
 * отправки: повторная вставка не проходит, поэтому повторный или параллельный запуск его не продублирует.
 */
export type ReminderKind = "r1d" | "r3h" | "morning";

const HOUR = 3600_000;
const INTERVAL_MS = 60_000;
// Блокировка запуска: дольше любого запуска, чтобы процессы не шли параллельно.
const LOCK_TTL = 300;

/** Момент по местному времени Ташкента (UTC+5, без перехода на летнее время). */
const tashkent = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`).getTime();

/** Местная дата Ташкента (YYYY-MM-DD) в момент t. */
export const tashkentDate = (t: Date) => new Date(t.getTime() + 5 * HOUR).toISOString().slice(0, 10);

/**
 * Какие напоминания пора отправить в момент now, от самого срочного. Окна r1d (от суток до 3 часов
 * до начала) и r3h (последние 3 часа) не пересекаются; утреннее — с 9:00 до начала события, а без
 * времени начала — до полудня. r1d и r3h нужны дата и время. Если открыто несколько окон сразу
 * (гость подключил бота поздно), гость получает одно сообщение, а остальные отмечаются отправленными.
 */
export function dueReminders(data: Pick<InvContent, "date" | "time">, settings: InvitationSettings, now: Date): ReminderKind[] {
  if (!data.date) return [];
  const t = now.getTime();
  const start = data.time ? tashkent(data.date, data.time) : null;
  if (start !== null && t >= start) return [];
  const due: ReminderKind[] = [];
  if (settings.r3h && start !== null && t >= start - 3 * HOUR) due.push("r3h");
  if (settings.morning && t >= tashkent(data.date, "09:00") && t < (start ?? tashkent(data.date, "12:00"))) due.push("morning");
  if (settings.r1d && start !== null && t >= start - 24 * HOUR && t < start - 3 * HOUR) due.push("r1d");
  return due;
}

type ReminderCtx = Pick<Ctx, "db" | "cache" | "config" | "notifier" | "log">;

/** Отправляет напоминания, которым пришло время. Возвращает число отправленных сообщений. */
export async function sendDueReminders(ctx: ReminderCtx, now = new Date()): Promise<number> {
  if (!ctx.notifier.enabled) return 0;
  const days = [tashkentDate(now), tashkentDate(new Date(now.getTime() + 24 * HOUR))];
  const rows = await ctx.db
    .select({ inv: invitations, tpl: { smsEnabled: templates.smsEnabled, event: templates.event, style: templates.style, title: templates.title } })
    .from(invitations)
    .innerJoin(templates, eq(templates.id, invitations.templateId))
    .where(and(eq(invitations.status, "active"), inArray(sql<string>`${invitations.data}->>'date'`, days)));

  let total = 0;
  for (const { inv, tpl } of rows) {
    // Общее приглашение без оплаты шаблона не открывается: напоминать некуда.
    if (inv.mode === "shared" && !inv.unlocked) continue;
    const { locale, data, event } = smsContext(inv, tpl);
    const due = dueReminders(data, { ...defaultInvitationSettings, ...inv.settings }, now);
    if (!due.length) continue;
    const [list, paid] = await Promise.all([
      ctx.db
        .select({ id: guests.id, name: guests.name, token: guests.token, rsvp: guests.rsvp, chatId: guests.telegramChatId })
        .from(guests)
        .where(and(eq(guests.invitationId, inv.id), isNotNull(guests.telegramChatId), inArray(guests.rsvp, ["yes", "maybe", "pending"])))
        .orderBy(asc(guests.seat)),
      paidGuestIds(ctx, inv),
    ]);
    const when = [longDate(data.date!, locale), data.time].filter(Boolean).join(", ");
    const place = [data.venue, data.address].map((s) => s?.trim()).filter(Boolean).join(", ");

    let sent = 0;
    for (const g of list) {
      if (!paid.has(g.id) || g.chatId === null) continue;
      const claimed = await ctx.db
        .insert(guestReminders)
        .values(due.map((kind) => ({ guestId: g.id, kind })))
        .onConflictDoNothing()
        .returning({ kind: guestReminders.kind });
      const kind = due.find((k) => claimed.some((c) => c.kind === k));
      if (!kind) continue;

      const lines = [notifyText(locale, kind, { name: g.name, event, when })];
      if (place) lines.push(`📍 ${place}`);
      if (g.rsvp === "pending") lines.push(notifyText(locale, "pleaseReply"));
      const buttons: NotifyButton[] = [{ text: notifyText(locale, "openInvitation"), url: guestLink(ctx, g.token) }];
      // Утром в день события — маршрут до места.
      if (kind === "morning" && place) {
        buttons.push({ text: notifyText(locale, "route"), url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}` });
      }
      // Ошибка Telegram (гость остановил бота) уже в логе; повторять не будем.
      if (await ctx.notifier.sendToChat(g.chatId, lines.join("\n"), { buttons })) sent++;
    }
    if (sent) await logEvent(ctx, inv.id, "reminder", { meta: { n: sent, scheduled: true } });
    total += sent;
  }
  return total;
}

/** Запускает напоминания раз в минуту. Один запуск за раз (блокировка в Redis); возвращает остановку. */
export function startReminderJob(ctx: ReminderCtx, intervalMs = INTERVAL_MS): () => void {
  const tick = async () => {
    const lock = await ctx.cache.lock(cacheKeys.remindersLock, LOCK_TTL);
    if (!lock) return;
    try {
      const n = await sendDueReminders(ctx);
      if (n) ctx.log.info({ n }, "напоминания гостям отправлены");
    } finally {
      await lock.release();
    }
  };
  const timer = setInterval(() => void tick().catch((err) => ctx.log.error({ err }, "напоминания гостям не отправлены")), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
