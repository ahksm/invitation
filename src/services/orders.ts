import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { invitations, orders, subscriptions, templates, users, type Order } from "../db/schema.js";
import { extendSubscription, quoteSeats, quoteSubscription, quoteTemplate } from "../pricing.js";
import type { CheckoutItem, PaymentNotification } from "../payments/types.js";
import { HttpError } from "../errors.js";
import type { ApiTextKey } from "../i18n.js";
import { getPrices } from "./settings.js";
import { getAccess, getUser } from "./users.js";
import { logEvent } from "./events.js";
import { invalidateInvitation } from "./invitations.js";
import { track } from "./usage.js";

export type OrderRequest =
  | { kind: "template"; invitationId: string }
  | { kind: "seats"; invitationId: string; quantity: number }
  | { kind: "subscription"; months: number };

/** Бесплатный заказ выполнен сразу: messageKey и n — для текста на языке пользователя (apiText). */
export type OrderResult =
  | { status: "fulfilled"; order: null; messageKey: ApiTextKey; n?: number }
  | { status: "pending"; order: Order; checkoutUrl: string };

/** Создаёт заказ. Если платить не нужно (бесплатный доступ, подписка), сразу применяет результат. */
export async function createOrder(ctx: Ctx, userId: string, req: OrderRequest): Promise<OrderResult> {
  const user = await getUser(ctx, userId);
  if (!user) throw new HttpError(401, "Пользователь не найден");
  const access = await getAccess(ctx, user);
  const prices = await getPrices(ctx);

  let amount: number;
  let quantity = 1;
  let invitationId: string | null = null;
  let items: CheckoutItem[];

  if (req.kind === "subscription") {
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
    invitationId = row.inv.id;

    if (req.kind === "template") {
      if (row.inv.mode !== "shared") throw new HttpError(400, "Шаблон оплачивается только у общего приглашения");
      if (row.inv.unlocked) throw new HttpError(409, "Шаблон уже оплачен");
      amount = quoteTemplate(access, row.tpl, prices);
      items = [{ title: `Шаблон «${row.tpl.title}»`, quantity: 1, unitPrice: amount }];
      if (amount === 0) {
        await ctx.db.transaction(async (tx) => {
          await tx.update(invitations).set({ unlocked: true }).where(eq(invitations.id, row.inv.id));
          // Начатые оплаты шаблона больше не нужны; если по старому счёту всё же заплатят, applyPayment откажет.
          await tx
            .update(orders)
            .set({ status: "cancelled" })
            .where(and(eq(orders.invitationId, row.inv.id), eq(orders.kind, "template"), eq(orders.status, "pending")));
        });
        await invalidateInvitation(ctx, row.inv);
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
    })
    .returning();

  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  try {
    const checkout = await ctx.payments.createCheckout({
      order: order!,
      items,
      callbackUrl: `${appUrl}/api/payments/${ctx.payments.name}/callback`,
      returnUrl: `${appUrl}/app/#/orders/${order!.id}`,
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
    await ctx.db.update(orders).set({ status: "failed", meta: { error: String(err) } }).where(eq(orders.id, order!.id));
    ctx.log.error({ err, orderId: order!.id }, "не удалось создать платёж");
    throw new HttpError(502, "Платёжная система недоступна, попробуйте позже");
  }
}

export type FulfillOutcome = "paid" | "already_paid" | "not_found" | "amount_mismatch" | "duplicate" | "marked_failed" | "ignored";

/**
 * Применяет проверенное уведомление об оплате. Идемпотентно: повторный колбэк ничего не меняет.
 * Заказ блокируется в транзакции (SELECT ... FOR UPDATE), чтобы параллельные колбэки не начислили дважды.
 * Второй оплаченный счёт за уже открытый шаблон отклоняется (duplicate): провайдер отменит платёж.
 */
export async function applyPayment(ctx: Ctx, n: PaymentNotification): Promise<FulfillOutcome> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.number, n.orderNumber)).for("update");
    if (!order) return { result: "not_found" as const };
    if (order.status === "paid") return { result: "already_paid" as const };

    if (n.status !== "paid") {
      if (order.status !== "pending") return { result: "ignored" as const };
      await tx.update(orders).set({ status: n.status, meta: { ...order.meta, notification: n.raw } }).where(eq(orders.id, order.id));
      return { result: "marked_failed" as const };
    }
    if (n.amount !== order.amount) return { result: "amount_mismatch" as const, order };

    if (order.kind === "template" && order.invitationId) {
      // Строка приглашения блокируется: из двух параллельных оплат шаблона пройдёт только первая.
      const [inv] = await tx
        .select({ unlocked: invitations.unlocked })
        .from(invitations)
        .where(eq(invitations.id, order.invitationId))
        .for("update");
      if (inv?.unlocked) {
        await tx
          .update(orders)
          .set({ status: "cancelled", meta: { ...order.meta, duplicate: true, notification: n.raw } })
          .where(eq(orders.id, order.id));
        return { result: "duplicate" as const, order };
      }
    }
    if (order.kind === "subscription") {
      // Две оплаченные подписки одного пользователя продлеваются по очереди, а не от одной даты.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, order.userId)).for("update");
    }

    const now = new Date();
    await tx
      .update(orders)
      .set({ status: "paid", paidAt: now, providerRef: n.providerRef ?? order.providerRef, meta: { ...order.meta, notification: n.raw } })
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
  return outcome.result;
}
