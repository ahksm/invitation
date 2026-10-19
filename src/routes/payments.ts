import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orders } from "../db/schema.js";
import { mockSign } from "../payments/mock.js";
import { applyPayment } from "../services/orders.js";

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const provider = ctx.payments;

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Текст отказа Multicard показывает плательщику.
  const refusal: Partial<Record<string, string>> = {
    not_found: "Заказ не найден",
    amount_mismatch: "Сумма оплаты не совпадает с заказом",
    duplicate: "Шаблон уже оплачен",
    stale: "Заказ отменён, оформите оплату заново",
  };
  const allowedIps = provider.name === "multicard" ? ctx.config.MULTICARD_CALLBACK_IPS : [];

  // Уведомление об оплате от платёжной системы. Подпись проверяет провайдер.
  // Ошибка базы или Redis даёт 500: Multicard в этом случае не отменяет оплату, а присылает колбэк повторно.
  app.post("/:provider/callback", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { provider: name } = z.object({ provider: z.string() }).parse(req.params);
    if (name !== provider.name) return reply.code(404).send({ error: "Неизвестный провайдер" });
    if (allowedIps.length && !allowedIps.includes(req.ip)) {
      req.log.warn({ ip: req.ip }, "платёжное уведомление с чужого IP");
      const ack = provider.webhookAck(false, "Доступ запрещён");
      return reply.code(ack.status).send(ack.body);
    }

    const notification = await provider.verifyWebhook(req.body, req.headers);
    if (!notification) {
      req.log.warn({ ip: req.ip }, "платёжное уведомление с неверной подписью");
      const ack = provider.webhookAck(false, "Неверная подпись");
      return reply.code(ack.status).send(ack.body);
    }
    const outcome = await applyPayment(ctx, notification);
    req.log.info({ orderNumber: notification.orderNumber, outcome }, "платёжное уведомление обработано");
    const ok = outcome === "paid" || outcome === "already_paid" || outcome === "marked_failed" || outcome === "ignored";
    const ack = provider.webhookAck(ok, refusal[outcome] ?? outcome);
    return reply.code(ack.status).send(ack.body);
  });

  if (provider.name !== "mock") return;

  // Тестовая страница оплаты: доступна только при PAYMENT_PROVIDER=mock (в production запрещено конфигом).
  app.register(async (mock) => {
    mock.addHook("onRequest", app.authenticate);

    const ownOrder = async (orderId: string, userId: string) => {
      const [order] = await ctx.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
      return order;
    };

    mock.get("/mock/checkout/:id", async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const order = await ownOrder(id, req.user.id);
      if (!order) return reply.code(404).send({ error: "Заказ не найден" });
      return reply.redirect(`/app/#/mock-pay/${order.id}`);
    });

    mock.post("/mock/checkout/:id", async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { status } = z.object({ status: z.enum(["paid", "failed"]) }).parse(req.body);
      const order = await ownOrder(id, req.user.id);
      if (!order) return reply.code(404).send({ error: "Заказ не найден" });
      const body = {
        order_number: order.number,
        amount: order.amount,
        status,
        sign: mockSign(ctx.config.MOCK_PAYMENT_SECRET, order.number, order.amount, status),
      };
      const notification = await provider.verifyWebhook(body, {});
      return { outcome: notification ? await applyPayment(ctx, notification) : "invalid" };
    });
  });
};
