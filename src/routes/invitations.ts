import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { orders } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { apiText, locales, pickLocale, requestLocale } from "../i18n.js";
import { listActivity } from "../services/events.js";
import { addGuests, checkInByToken, listGuestDtos, removeGuest, updateGuest } from "../services/guests.js";
import {
  createInvitation,
  deleteInvitation,
  duplicateInvitation,
  getInvitationDto,
  getOwnInvitation,
  listActiveTemplates,
  listOwnInvitations,
  publishInvitation,
  setOgImage,
  settingsPatchSchema,
  updateInvitation,
} from "../services/invitations.js";
import { sendBotTest } from "../services/notify.js";
import { createOrder, orderDto } from "../services/orders.js";
import { remindGuests } from "../services/remind.js";
import { sendInvitationSms } from "../services/sms.js";
import { phoneSchema } from "./auth.js";
import { track } from "../services/usage.js";

/** OG-картинка приходит телом запроса (image/png или image/jpeg). */
const OG_MAX_BYTES = 3 * 1024 * 1024;

const id = z.object({ id: z.uuid() });
const guestParams = z.object({ id: z.uuid(), guestId: z.uuid() });
const mode = z.enum(["shared", "personal"]);
const templateSlug = z.string().min(1).max(64);
// Содержимое проверяется схемой InvContent в сервисе: правила шрифтов зависят от шаблона.
const data = z.record(z.string(), z.unknown());

const createSchema = z.object({
  template: templateSlug,
  mode: mode.default("shared"),
  language: z.enum(locales).optional(),
  data: data.default({}),
});
const updateSchema = z.object({
  template: templateSlug.optional(),
  mode: mode.optional(),
  language: z.enum(locales).optional(),
  data: data.optional(),
  // Формат проверяет сервис, и только у новой ссылки: прежнюю ссылку можно прислать обратно без изменений.
  slug: z.string().max(64).optional(),
  accessCode: z.string().min(1).max(64).nullable().optional(),
  settings: settingsPatchSchema.optional(),
});
const group = z.enum(["family", "friends", "work", "other"]);
const plus = z.number().int().min(0).max(10);
const guestName = z.string().trim().min(1).max(120);
const guestSchema = z.object({ name: guestName, phone: phoneSchema.nullish(), group: group.optional(), plus: plus.optional() });
const guestsSchema = z.object({ guests: z.array(guestSchema).min(1).max(500) });
const guestPatchSchema = z.object({
  name: guestName.optional(),
  phone: phoneSchema.nullable().optional(),
  group: group.optional(),
  plus: plus.optional(),
  // Верхняя граница — число столов приглашения, проверяется в сервисе.
  tableNo: z.number().int().min(0).max(30).optional(),
  checkedIn: z.boolean().optional(),
  rsvp: z.enum(["pending", "yes", "no", "maybe"]).optional(),
});
const guestIdsSchema = z.object({ guestIds: z.array(z.uuid()).max(500).optional() });
const orderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), invitationId: z.uuid() }),
  z.object({ kind: z.literal("seats"), invitationId: z.uuid(), quantity: z.number().int().min(1).max(1000) }),
  z.object({ kind: z.literal("subscription"), months: z.number().int().min(1).max(12) }),
]);
const returnToSchema = z.object({ returnTo: z.enum(["app", "telegram"]).optional() });

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.addContentTypeParser(["image/png", "image/jpeg"], { parseAs: "buffer", bodyLimit: OG_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get("/templates", async () => listActiveTemplates(ctx));

  app.register(async (priv) => {
    priv.addHook("onRequest", app.authenticate);

    priv.get("/invitations", async (req) => listOwnInvitations(ctx, req.user.id));

    priv.post("/invitations", async (req, reply) => {
      const body = createSchema.parse(req.body);
      const inv = await createInvitation(ctx, req.user.id, { ...body, language: body.language ?? pickLocale(req.user.locale) });
      await track(ctx, req.user.id, "invitation_created", { invitationId: inv.id, mode: inv.mode });
      return reply.code(201).send(inv);
    });

    priv.get("/invitations/:id", async (req) => {
      const inv = await getInvitationDto(ctx, req.user.id, id.parse(req.params).id);
      return { ...inv, guests: await listGuestDtos(ctx, inv) };
    });

    priv.patch("/invitations/:id", async (req) => {
      const inv = await updateInvitation(ctx, req.user, id.parse(req.params).id, updateSchema.parse(req.body));
      // Автосохранение шлёт PATCH после каждой паузы в наборе: в журнал идёт одно событие на приглашение
      // за 30 минут, иначе в карточке пользователя и ленте активности не остаётся ничего, кроме правок.
      if (await ctx.cache.claim(`usage:inv-upd:${inv.id}`, 1800)) await track(ctx, req.user.id, "invitation_updated", { invitationId: inv.id });
      return inv;
    });

    priv.delete("/invitations/:id", async (req, reply) => {
      await deleteInvitation(ctx, req.user.id, id.parse(req.params).id);
      return reply.code(204).send();
    });

    priv.post("/invitations/:id/duplicate", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const inv = await duplicateInvitation(ctx, req.user.id, id.parse(req.params).id);
      await track(ctx, req.user.id, "invitation_created", { invitationId: inv.id, mode: inv.mode });
      return reply.code(201).send(inv);
    });

    priv.post("/invitations/:id/publish", async (req) => {
      const inv = await publishInvitation(ctx, req.user.id, id.parse(req.params).id);
      await track(ctx, req.user.id, "invitation_published", { invitationId: inv.id });
      return inv;
    });

    priv.put(
      "/invitations/:id/og",
      {
        bodyLimit: OG_MAX_BYTES,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        // Ошибки разбора тела (размер, тип) отдаём понятным текстом, остальное — общему обработчику.
        errorHandler: (err, _req, _reply) => {
          const code = (err as { code?: string }).code;
          if (code === "FST_ERR_CTP_BODY_TOO_LARGE") throw new HttpError(413, "Файл слишком большой");
          if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_EMPTY_TYPE") throw new HttpError(415, "Нужна картинка PNG или JPEG");
          throw err;
        },
      },
      async (req) => {
        if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "Нужна картинка PNG или JPEG");
        return setOgImage(ctx, req.user, id.parse(req.params).id, req.body);
      },
    );

    priv.get("/invitations/:id/activity", async (req) => {
      const inv = await getOwnInvitation(ctx, req.user.id, id.parse(req.params).id);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      return listActivity(ctx, inv.id, limit);
    });

    // Отметка на входе: токен из QR личной ссылки гостя.
    priv.post("/invitations/:id/checkin", async (req) => {
      const { token } = z.object({ token: z.string().regex(/^[\w-]{8,64}$/) }).parse(req.body);
      return checkInByToken(ctx, req.user.id, id.parse(req.params).id, token);
    });

    priv.post("/invitations/:id/guests", async (req, reply) => {
      const invitationId = id.parse(req.params).id;
      const added = await addGuests(ctx, req.user.id, invitationId, guestsSchema.parse(req.body).guests);
      await track(ctx, req.user.id, "guests_added", { invitationId, count: added.length });
      return reply.code(201).send(added);
    });

    priv.patch("/invitations/:id/guests/:guestId", async (req) => {
      const p = guestParams.parse(req.params);
      return updateGuest(ctx, req.user.id, p.id, p.guestId, guestPatchSchema.parse(req.body));
    });

    // Рассылка приглашений гостям по SMS. Без guestIds отправляется всем, кому можно.
    priv.post("/invitations/:id/sms", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const { guestIds } = guestIdsSchema.parse(req.body ?? {});
      return sendInvitationSms(ctx, req.user.id, id.parse(req.params).id, guestIds);
    });

    // Напоминание ответить: Telegram гостя, иначе SMS. Без guestIds — всем гостям без ответа.
    priv.post("/invitations/:id/remind", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const { guestIds } = guestIdsSchema.parse(req.body ?? {});
      return remindGuests(ctx, req.user.id, id.parse(req.params).id, guestIds);
    });

    // Пробное уведомление владельцу в Telegram (вкладка «Бот»).
    priv.post("/invitations/:id/bot/test", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) =>
      sendBotTest(ctx, req.user, id.parse(req.params).id),
    );

    priv.delete("/invitations/:id/guests/:guestId", async (req, reply) => {
      const p = guestParams.parse(req.params);
      await removeGuest(ctx, req.user.id, p.id, p.guestId);
      return reply.code(204).send();
    });

    priv.post("/orders", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const order = orderSchema.parse(req.body);
      // Мини-апп входит по токену в Authorization (cookie во фрейме Telegram нет), и браузер, куда
      // Telegram откроет оплату, сессии не имеет: без явного returnTo такой заказ возвращает в Telegram.
      const { returnTo = req.headers.authorization?.startsWith("Bearer ") ? "telegram" : "app" } = returnToSchema.parse(req.body);
      const result = await createOrder(ctx, req.user.id, order, returnTo);
      if (result.status === "pending") return reply.code(201).send({ ...result, order: orderDto(result.order) });
      return { status: result.status, order: null, message: apiText(requestLocale(req.headers), result.messageKey, { n: result.n ?? 0 }) };
    });

    priv.get("/orders", async (req) =>
      (await ctx.db.select().from(orders).where(eq(orders.userId, req.user.id)).orderBy(desc(orders.createdAt)).limit(100)).map(orderDto),
    );

    priv.get("/orders/:id", async (req, reply) => {
      const [order] = await ctx.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, id.parse(req.params).id), eq(orders.userId, req.user.id)));
      return order ? orderDto(order) : reply.code(404).send({ error: "Заказ не найден" });
    });
  });
};
