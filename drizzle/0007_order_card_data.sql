-- Данные: в уведомлениях Multicard, сохранённых в заказах, остаются только поля, которые сервер
-- сохраняет сейчас (NOTIFICATION_FIELDS в src/services/orders.ts). Уходит маскированный номер карты
-- card_pan, а у заказов, оплаченных до появления списка полей, — и остальное (токен карты, подпись,
-- телефон плательщика): оферта и политика конфиденциальности обещают, что данные карты не хранятся.
-- Другие ключи meta (templateId и т. п.) не меняются. Повторный запуск ничего не меняет: лишних полей уже нет.
UPDATE "orders"
SET "meta" = jsonb_set("meta", '{notification}', (
  SELECT coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb)
  FROM jsonb_each("meta" -> 'notification') AS n
  WHERE n.key IN ('uuid', 'invoice_id', 'billing_id', 'payment_time', 'ps', 'receipt_url', 'amount', 'order_number', 'status')
))
WHERE jsonb_typeof("meta" -> 'notification') = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys("meta" -> 'notification') AS k
    WHERE k NOT IN ('uuid', 'invoice_id', 'billing_id', 'payment_time', 'ps', 'receipt_url', 'amount', 'order_number', 'status')
  );
