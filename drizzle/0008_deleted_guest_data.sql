-- Данные: то, что политика конфиденциальности обещает удалять вместе с гостем или приглашением, удаляется
-- и в записях, сделанных до того, как это стал делать код.
-- 1. Гости приглашений, перенесённых в архив до f363516 (с тех пор гости архивного приглашения удаляются
--    сразу, deleteInvitation в src/services/invitations.ts). Из архива приглашение не возвращается.
-- 2. SMS гостям (приглашения и напоминания) удалённых гостей теряют номер и текст с именем гостя и его
--    личной ссылкой, как делает anonymizeGuestSms (src/services/sms-log.ts) с bf2ab02. SMS гостю всегда
--    пишется с guest_id, а при удалении гостя он становится NULL (ON DELETE SET NULL): строка без guest_id —
--    SMS удалённого гостя, в том числе гостя из п. 1. id, статус, provider_ref, время и invitation_id
--    остаются для сверки с Eskiz и лимита SMS на приглашение. Коды входа не трогаются.
-- Повторный запуск ничего не меняет: гостей в архиве уже нет, у таких SMS уже нет номера и текста.
DELETE FROM "guests"
WHERE "invitation_id" IN (SELECT "id" FROM "invitations" WHERE "status" = 'archived');--> statement-breakpoint
UPDATE "sms_messages"
SET "phone" = '', "text" = NULL
WHERE "purpose" <> 'otp'
  AND "guest_id" IS NULL
  AND ("phone" <> '' OR "text" IS NOT NULL);
