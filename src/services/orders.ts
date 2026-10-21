import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { invitations, orders, subscriptions, templates, users, type Order } from "../db/schema.js";
import { extendSubscription, quoteSeats, quoteSubscription, quoteTemplate, templatePrice, type Prices } from "../pricing.js";
import type { CheckoutItem, PaymentNotification } from "../payments/types.js";
import { HttpError } from "../errors.js";
import type { ApiTextKey } from "../i18n.js";
import { getPrices } from "./settings.js";
import { getAccess, getUser } from "./users.js";
import { logEvent } from "./events.js";
import { assertNotArchived, cancelPendingOrders, invalidateInvitation } from "./invitations.js";
import { track } from "./usage.js";

export type OrderRequest =
  | { kind: "template"; invitationId: string }
  | { kind: "seats"; invitationId: string; quantity: number }
  | { kind: "subscription"; months: number };

/**
 * Куда платёжная страница вернёт плательщика. app — экран заказа в приложении (нужна сессия этого
 * браузера). telegram — оплата начата в мини-аппе: страницу оплаты Telegram открывает во внешнем
 * браузере без сессии, поэтому возврат идёт на экран без входа «Вернитесь в Telegram» (#/paid/<id>).
 */
export type ReturnTo = "app" | "telegram";

/**
 * Заказ для клиента: без meta (там уведомление платёжной системы и служебные отметки). template — slug
 * шаблона, за который выставлен счёт (meta.templateId заказа шаблона): шаблон приглашения после оплаты
 * могут сменить, а история платежей показывает оплаченный. У остальных заказов null.
 */
export type OrderDto = Pick<
  Order,
  "id" | "number" | "kind" | "invitationId" | "quantity" | "amount" | "currency" | "status" | "checkoutUrl" | "paidAt" | "createdAt"
> & { template: string | null };

// Только uuid: испорченное значение в meta не должно ломать запрос к шаблонам.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderTemplateId = (o: Order) => {
  const id = o.kind === "template" ? o.meta.templateId : null;
  return typeof id === "string" && UUID.test(id) ? id : null;
};

const orderDto = (o: Order, slugs: ReadonlyMap<string, string> = new Map()): OrderDto => {
  const tid = orderTemplateId(o);
  return {
    id: o.id,
    number: o.number,
    kind: o.kind,
    invitationId: o.invitationId,
    quantity: o.quantity,
    amount: o.amount,
    currency: o.currency,
    status: o.status,
    checkoutUrl: o.checkoutUrl,
    paidAt: o.paidAt,
    createdAt: o.createdAt,
    template: (tid && slugs.get(tid)) ?? null,
  };
};

/** Заказы для клиента одним запросом к шаблонам: slug оплаченного шаблона по meta.templateId. */
export async function orderDtos(ctx: Pick<Ctx, "db">, list: Order[]): Promise<OrderDto[]> {
  const ids = [...new Set(list.map(orderTemplateId).filter((x): x is string => x !== null))];
  const rows = ids.length ? await ctx.db.select({ id: templates.id, slug: templates.slug }).from(templates).where(inArray(templates.id, ids)) : [];
  const slugs = new Map(rows.map((r) => [r.id, r.slug]));
  return list.map((o) => orderDto(o, slugs));
}

// Поля уведомления об оплате, которые хранятся в заказе. Остальное (маскированный номер и токен карты,
// подпись, телефон плательщика) не сохраняется: для сверки с кабинетом платёжной системы хватает uuid,
// invoice_id и чека, а оферта и политика конфиденциальности обещают, что данные карты не хранятся.
const NOTIFICATION_FIELDS = ["uuid", "invoice_id", "billing_id", "payment_time", "ps", "receipt_url", "amount", "order_number", "status"];

export function notificationMeta(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw).filter(([k]) => NOTIFICATION_FIELDS.includes(k)));
}

/** Бесплатный заказ выполнен сразу: messageKey и n — для текста на языке пользователя (apiText). */
export type OrderResult =
  | { status: "fulfilled"; order: null; messageKey: ApiTextKey; n?: number }
  | { status: "pending"; order: Order; checkoutUrl: string };

/** Создаёт заказ. Если платить не нужно (бесплатный доступ, подписка), сразу применяет результат. */
export async function createOrder(ctx: Ctx, userId: string, req: OrderRequest, returnTo: ReturnTo = "app"): Promise<OrderResult> {
  const user = await getUser(ctx, userId);
  if (!user) throw new HttpError(401, "Пользователь не найден");
  const access = await getAccess(ctx, user);
  const prices = await getPrices(ctx);

  let amount: number;
  let quantity = 1;
  let invitationId: string | null = null;
  let items: CheckoutItem[];
  let meta: Record<string, unknown> = {};

  if (req.kind === "subscription") {
    // Бесплатному доступу (и администратору) все шаблоны уже открыты: подписка ничего бы не дала.
    if (access.free) throw new HttpError(400, "У вас бесплатный доступ: подписка не нужна");
    quantity = req.months;
    amount = quoteSubscription(req.months, prices);
    items = [{ title: "Подписка на шаблоны (1 месяц)", quantity, unitPrice: prices.subscriptionMonth }];
  } else {
    const [row] = await ctx.db
      .select({ inv: invitations, tpl: templates })
      .from(invitations)
      .innerJoin(templates, eq(templates.id, invitations.templateId))
      .where(and(eq(invitations.id, req.invitationId), eq(invitations.userId, userId)));
    if (!row) throw new HttpError(404, "Приглашение не найдено");
    assertNotArchived(row.inv);
    invitationId = row.inv.id;

    if (req.kind === "template") {
      if (row.inv.mode !== "shared") throw new HttpError(400, "Шаблон оплачивается только у общего приглашения");
      if (row.inv.unlocked) throw new HttpError(409, "Шаблон уже оплачен");
      amount = quoteTemplate(access, row.tpl, prices);
      items = [{ title: `Шаблон «${row.tpl.title}»`, quantity: 1, unitPrice: amount }];
      // Счёт за этот шаблон: если до оплаты шаблон сменят на более дорогой, applyPayment его не применит.
      meta = { templateId: row.tpl.id };
      if (amount === 0) {
        await ctx.db.transaction(async (tx) => {
          await tx.update(invitations).set({ unlocked: true }).where(eq(invitations.id, row.inv.id));
          // Начатые оплаты шаблона больше не нужны; если по старому счёту всё же заплатят, applyPayment откажет.
          await cancelPendingOrders(tx, row.inv.id, "template", "unlocked_free");
        });
        await invalidateInvitation(ctx, row.inv);
        await logEvent(ctx, row.inv.id, "paid", { meta: { orderId: null, kind: "template", quantity: 1, amount: 0 } });
        return { status: "fulfilled", order: null, messageKey: "templateUnlocked" };
      }
    } else {
      if (row.inv.mode !== "personal") throw new HttpError(400, "Места покупаются только для персональных приглашений");
      quantity = req.quantity;
      amount = quoteSeats(access, quantity, prices);
      items = [{ title: "Персональное приглашение (1 гость)", quantity, unitPrice: prices.seat }];
      if (amount === 0) {
        await ctx.db
          .update(invitations)
          .set({ paidSeats: sql`${invitations.paidSeats} + ${quantity}` })
          .where(eq(invitations.id, row.inv.id));
        await invalidateInvitation(ctx, row.inv);
        await logEvent(ctx, row.inv.id, "paid", { meta: { orderId: null, kind: "seats", quantity, amount: 0 } });
        return { status: "fulfilled", order: null, messageKey: "seatsAdded", n: quantity };
      }
    }
  }

  const [order] = await ctx.db
    .insert(orders)
    .values({
      userId,
      kind: req.kind,
      invitationId,
      quantity,
      amount,
      currency: ctx.config.CURRENCY,
      provider: ctx.payments.name,
      meta,
    })
    .returning();

  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  try {
    const checkout = await ctx.payments.createCheckout({
      order: order!,
      items,
      callbackUrl: `${appUrl}/api/payments/${ctx.payments.name}/callback`,
      returnUrl: `${appUrl}/app/#/${returnTo === "telegram" ? "paid" : "orders"}/${order!.id}`,
      lang: user.locale === "uz" || user.locale === "uzc" ? "uz" : user.locale === "en" ? "en" : "ru",
    });
    const [updated] = await ctx.db
      .update(orders)
      .set({ providerRef: checkout.providerRef, checkoutUrl: checkout.checkoutUrl })
      .where(eq(orders.id, order!.id))
      .returning();
    await track(ctx, userId, "order_created", { orderId: order!.id, kind: req.kind, amount });
    return { status: "pending", order: updated!, checkoutUrl: checkout.checkoutUrl };
  } catch (err) {
    // Прежняя meta (templateId заказа шаблона) остаётся: история платежей показывает, за что был счёт.
    await ctx.db.update(orders).set({ status: "failed", meta: { ...order!.meta, error: String(err) } }).where(eq(orders.id, order!.id));
    ctx.log.error({ err, orderId: order!.id }, "не удалось создать платёж");
    throw new HttpError(502, "Платёжная система недоступна, попробуйте позже");
  }
}

export type FulfillOutcome = "paid" | "already_paid" | "not_found" | "amount_mismatch" | "duplicate" | "stale" | "marked_failed" | "ignored";

type OrderInvitation = { mode: "shared" | "personal"; templateId: string; templatePrice: number | null };

/**
 * Счёт больше не подходит приглашению: режим сменился (шаблон оплачивается у общего, места у
 * персонального) или шаблон сменили на более дорогой, чем оплачено по счёту. Счёт приглашения,
 * удалённого в архив, применяется: оплата не теряется.
 */
function staleOrder(order: Order, inv: OrderInvitation, prices: Prices): boolean {
  if (order.kind === "seats") return inv.mode !== "personal";
  if (order.kind !== "template") return false;
  if (inv.mode !== "shared") return true;
  return order.meta.templateId !== inv.templateId && order.amount < templatePrice({ price: inv.templatePrice }, prices);
}

/**
 * Применяет проверенное уведомление об оплате. Идемпотентно: повторный колбэк ничего не меняет.
 * Заказ блокируется в транзакции (SELECT ... FOR UPDATE), чтобы параллельные колбэки не начислили дважды.
 * Второй оплаченный счёт за уже открытый шаблон отклоняется (duplicate), как и отменённый счёт или
 * счёт, который больше не подходит приглашению (stale): провайдер отменит платёж.
 */
export async function applyPayment(ctx: Ctx, n: PaymentNotification): Promise<FulfillOutcome> {
  const prices = await getPrices(ctx);
  const outcome = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.number, n.orderNumber)).for("update");
    if (!order) return { result: "not_found" as const };
    if (order.status === "paid") return { result: "already_paid" as const };

    if (n.status !== "paid") {
      if (order.status !== "pending") return { result: "ignored" as const };
      await tx.update(orders).set({ status: n.status, meta: { ...order.meta, notification: notificationMeta(n.raw) } }).where(eq(orders.id, order.id));
      return { result: "marked_failed" as const };
    }
    if (n.amount !== order.amount) return { result: "amount_mismatch" as const, order };

    // Строка приглашения блокируется: из двух параллельных оплат шаблона пройдёт только первая,
    // а смена режима или шаблона не проскочит между проверкой и начислением.
    const [inv] =
      order.invitationId && order.kind !== "subscription"
        ? await tx
            .select({ unlocked: invitations.unlocked, mode: invitations.mode, templateId: invitations.templateId, templatePrice: templates.price })
            .from(invitations)
            .innerJoin(templates, eq(templates.id, invitations.templateId))
            .where(eq(invitations.id, order.invitationId))
            .for("update", { of: invitations })
        : [];
    if (order.kind === "template" && inv?.unlocked) {
      await tx
        .update(orders)
        .set({ status: "cancelled", meta: { ...order.meta, duplicate: true, notification: notificationMeta(n.raw) } })
        .where(eq(orders.id, order.id));
      return { result: "duplicate" as const, order };
    }
    // Отменённый счёт (сменили режим или шаблон, открыли шаблон бесплатно) не применяется, даже если по нему заплатили.
    if (order.status === "cancelled" || (inv && staleOrder(order, inv, prices))) {
      await tx
        .update(orders)
        .set({ status: "cancelled", meta: { ...order.meta, stale: true, notification: notificationMeta(n.raw) } })
        .where(eq(orders.id, order.id));
      return { result: "stale" as const, order };
    }
    if (order.kind === "subscription") {
      // Две оплаченные подписки одного пользователя продлеваются по очереди, а не от одной даты.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, order.userId)).for("update");
    }

    const now = new Date();
    await tx
      .update(orders)
      .set({ status: "paid", paidAt: now, providerRef: n.providerRef ?? order.providerRef, meta: { ...order.meta, notification: notificationMeta(n.raw) } })
      .where(eq(orders.id, order.id));

    let invitation: { id: string; slug: string } | undefined;
    if (order.kind === "template" && order.invitationId) {
      [invitation] = await tx
        .update(invitations)
        .set({ unlocked: true })
        .where(eq(invitations.id, order.invitationId))
        .returning({ id: invitations.id, slug: invitations.slug });
    } else if (order.kind === "seats" && order.invitationId) {
      [invitation] = await tx
        .update(invitations)
        .set({ paidSeats: sql`${invitations.paidSeats} + ${order.quantity}` })
        .where(eq(invitations.id, order.invitationId))
        .returning({ id: invitations.id, slug: invitations.slug });
    } else if (order.kind === "subscription") {
      const [current] = await tx
        .select({ endsAt: subscriptions.endsAt })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, order.userId), gt(subscriptions.endsAt, now)))
        .orderBy(desc(subscriptions.endsAt))
        .limit(1);
      const period = extendSubscription(now, current?.endsAt ?? null, order.quantity);
      await tx.insert(subscriptions).values({ userId: order.userId, orderId: order.id, ...period });
    }
    return { result: "paid" as const, order, invitation };
  });

  if (outcome.result === "paid") {
    if (outcome.invitation) {
      await invalidateInvitation(ctx, outcome.invitation);
      const { id, kind, quantity, amount } = outcome.order;
      await logEvent(ctx, outcome.invitation.id, "paid", { meta: { orderId: id, kind, quantity, amount } });
    }
    await track(ctx, outcome.order.userId, "order_paid", { orderId: outcome.order.id, kind: outcome.order.kind, amount: outcome.order.amount });
  }
  if (outcome.result === "amount_mismatch") {
    ctx.log.error({ orderNumber: n.orderNumber, expected: outcome.order.amount, got: n.amount }, "сумма оплаты не совпадает с заказом");
  }
  if (outcome.result === "duplicate") {
    ctx.log.error({ orderNumber: n.orderNumber, invitationId: outcome.order.invitationId }, "повторная оплата уже открытого шаблона отклонена");
  }
  if (outcome.result === "stale") {
    ctx.log.error({ orderNumber: n.orderNumber, invitationId: outcome.order.invitationId }, "оплата отменённого или устаревшего счёта отклонена");
  }
  return outcome.result;
}
