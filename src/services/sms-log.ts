import { and, eq, ne } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { smsMessages } from "../db/schema.js";

/**
 * Обезличивает журнал SMS удалённых гостей (приглашения и напоминания; коды входа не трогаются):
 * номер стирается, текст с именем гостя и его личной ссылкой удаляется. Строка остаётся: id, статус,
 * provider_ref и время нужны для сверки с Eskiz, а invitation_id — для лимита SMS на приглашение.
 * Вызывается в транзакции, которая удаляет гостей.
 */
export async function anonymizeGuestSms(tx: Pick<Ctx["db"], "update">, of: { invitationId: string } | { guestId: string }) {
  const owner = "guestId" in of ? eq(smsMessages.guestId, of.guestId) : eq(smsMessages.invitationId, of.invitationId);
  await tx
    .update(smsMessages)
    .set({ phone: "", text: null })
    .where(and(owner, ne(smsMessages.purpose, "otp")));
}
