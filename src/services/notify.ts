import { eq } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { defaultInvitationSettings, invitations, users, type User } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { cyrText, pickLocale, type Locale } from "../i18n.js";
import { logEvent } from "./events.js";
import { appUrlOf, getOwnInvitation } from "./invitations.js";

/**
 * Сообщения в Telegram от имени бота: уведомления владельцу (ответы гостей, отметки на входе),
 * проверка уведомлений и напоминания гостям. Владельцу пишем на языке его профиля, гостю на языке
 * приглашения. uzc получается из uz через toCyr; подстановки {…} не транслитерируются.
 */
const texts = {
  yes: { ru: "✅ {name} придёт{plus}", uz: "✅ {name} keladi{plus}", en: "✅ {name} is coming{plus}" },
  maybe: { ru: "🤔 {name}, возможно, придёт{plus}", uz: "🤔 {name} balki keladi{plus}", en: "🤔 {name} might come{plus}" },
  no: { ru: "❌ {name} не сможет прийти", uz: "❌ {name} kela olmaydi", en: "❌ {name} can't come" },
  checkin: { ru: "🎟 {name}: отметка на входе", uz: "🎟 {name}: kirishda belgilandi", en: "🎟 {name} has checked in" },
  invitation: { ru: "Приглашение: {title}", uz: "Taklifnoma: {title}", en: "Invitation: {title}" },
  message: { ru: "Пожелание: {msg}", uz: "Tilak: {msg}", en: "Message: {msg}" },
  myInvitations: { ru: "Мои приглашения", uz: "Taklifnomalarim", en: "My invitations" },
  test: {
    ru: "🔔 Проверка уведомлений: «{title}». Сюда будут приходить ответы гостей и отметки на входе.",
    uz: "🔔 Bildirishnomalar tekshiruvi: «{title}». Mehmonlarning javoblari va kirishdagi belgilar shu yerga keladi.",
    en: "🔔 Notification test: “{title}”. Guest replies and check-ins will arrive here.",
  },
  testOff: {
    ru: "Сейчас уведомления для этого приглашения выключены: включите их во вкладке «Бот».",
    uz: "Hozir bu taklifnoma uchun bildirishnomalar o'chirilgan: ularni «Bot» bo'limida yoqing.",
    en: "Notifications for this invitation are off right now: turn them on in the Bot tab.",
  },
  remind: {
    ru: "{name}, напоминаем о приглашении: {event}{date}.\nОтветьте, пожалуйста, получится ли у вас прийти.",
    uz: "{name}, taklifnoma haqida eslatma: {event}{date}.\nIltimos, kela olasizmi, javob bering.",
    en: "{name}, a reminder about your invitation: {event}{date}.\nPlease let us know whether you can come.",
  },
  openInvitation: { ru: "Открыть приглашение", uz: "Taklifnomani ochish", en: "Open the invitation" },
} satisfies Record<string, Record<Exclude<Locale, "uzc">, string>>;

type TextKey = keyof typeof texts;
const textsUzc = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, cyrText(v.uz)])) as Record<TextKey, string>;

export function notifyText(locale: Locale, key: TextKey, vars: Record<string, string | number> = {}) {
  const text = locale === "uzc" ? textsUzc[key] : texts[key][locale];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

export type OwnerEvent =
  | { kind: "yes" | "no" | "maybe"; guestName: string; count: number; msg?: string | undefined }
  | { kind: "checkin"; guestName: string };

/**
 * Уведомляет владельца о событии гостя, если у приглашения включены уведомления (settings.notify)
 * и у владельца есть Telegram. true, если сообщение ушло.
 */
export async function notifyOwner(ctx: Pick<Ctx, "db" | "config" | "notifier">, invitationId: string, e: OwnerEvent): Promise<boolean> {
  if (!ctx.notifier.enabled) return false;
  const [row] = await ctx.db
    .select({ userId: invitations.userId, title: invitations.title, settings: invitations.settings, locale: users.locale, telegramId: users.telegramId })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.userId))
    .where(eq(invitations.id, invitationId));
  if (!row || row.telegramId === null || !{ ...defaultInvitationSettings, ...row.settings }.notify) return false;
  const l = pickLocale(row.locale);
  const lines =
    e.kind === "checkin"
      ? [notifyText(l, "checkin", { name: e.guestName })]
      : [notifyText(l, e.kind, { name: e.guestName, plus: e.kind !== "no" && e.count > 1 ? ` (+${e.count - 1})` : "" })];
  lines.push(notifyText(l, "invitation", { title: row.title }));
  if (e.kind !== "checkin" && e.msg?.trim()) lines.push(notifyText(l, "message", { msg: e.msg.trim() }));
  return ctx.notifier.sendToUser(row.userId, lines.join("\n"), { buttons: [{ text: notifyText(l, "myInvitations"), url: `${appUrlOf(ctx)}/app/` }] });
}

/** Уведомление в фоне: ответ гостя не ждёт Telegram. Ошибки только пишутся в лог. */
export function notifyOwnerLater(ctx: Pick<Ctx, "db" | "config" | "notifier" | "log">, invitationId: string, e: OwnerEvent) {
  void notifyOwner(ctx, invitationId, e).catch((err) => ctx.log.warn({ err, invitationId }, "уведомление владельцу не отправлено"));
}

/** Кнопка «Тест» во вкладке «Бот»: пробное уведомление владельцу и событие test в ленте. */
export async function sendBotTest(ctx: Pick<Ctx, "db" | "config" | "notifier" | "log">, user: User, invitationId: string): Promise<{ ok: true }> {
  const inv = await getOwnInvitation(ctx, user.id, invitationId);
  if (user.telegramId === null) throw new HttpError(409, "Подключите Telegram, чтобы получать уведомления");
  if (!ctx.notifier.enabled) throw new HttpError(503, "Бот сейчас недоступен");
  const l = pickLocale(user.locale);
  const lines = [notifyText(l, "test", { title: inv.title })];
  if (!{ ...defaultInvitationSettings, ...inv.settings }.notify) lines.push(notifyText(l, "testOff"));
  const ok = await ctx.notifier.sendToUser(user.id, lines.join("\n"), { buttons: [{ text: notifyText(l, "myInvitations"), url: `${appUrlOf(ctx)}/app/` }] });
  // Например, человек остановил бота: Telegram не даёт писать ему первым.
  if (!ok) throw new HttpError(502, "Не удалось отправить сообщение в Telegram");
  await logEvent(ctx, inv.id, "test");
  return { ok: true };
}
