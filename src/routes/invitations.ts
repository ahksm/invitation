import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { orders } from "../db/schema.js";
import {
  addGuests,
  createInvitation,
  getOwnInvitation,
  listActiveTemplates,
  listGuests,
  listOwnInvitations,
  publishInvitation,
  removeGuest,
  updateGuest,
  updateInvitation,
} from "../services/invitations.js";
import { createOrder } from "../services/orders.js";
import { guestSmsStatuses, sendInvitationSms } from "../services/sms.js";
import { phoneSchema } from "./auth.js";
import { locales } from "../i18n.js";
import { track } from "../services/usage.js";

const id = z.object({ id: z.uuid() });
const dataSchema = z.record(z.string().max(64), z.string().max(2000)).refine((d) => Object.keys(d).length <= 50, "Слишком много полей");

const createSchema = z.object({
  templateId: z.uuid(),
  mode: z.enum(["shared", "personal"]),
  language: z.enum(locales).default("ru"),
  title: z.string().trim().min(1).max(200),
  data: dataSchema.default({}),
});
const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  language: z.enum(locales).optional(),
  data: dataSchema.optional(),
});
const guestSchema = z.object({ name: z.string().trim().min(1).max(120), phone: phoneSchema.nullish() });
const guestsSchema = z.object({ guests: z.array(guestSchema).min(1).max(500) });
const orderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), invitationId: z.uuid() }),
  z.object({ kind: z.literal("seats"), invitationId: z.uuid(), quantity: z.number().int().min(1).max(1000) }),
  z.object({ kind: z.literal("subscription"), months: z.number().int().min(1).max(12) }),
]);

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get("/templates", async () => listActiveTemplates(ctx));

  app.register(async (priv) => {
    priv.addHook("onRequest", app.authenticate);

    priv.get("/invitations", async (req) => listOwnInvitations(ctx, req.user.id));

    priv.post("/invitations", async (req, reply) => {
      const inv = await createInvitation(ctx, req.user.id, createSchema.parse(req.body));
      await track(ctx, req.user.id, "invitation_created", { invitationId: inv.id, mode: inv.mode });
      return reply.code(201).send(inv);
    });

    priv.get("/invitations/:id", async (req) => {
      const inv = await getOwnInvitation(ctx, req.user.id, id.parse(req.params).id);
      if (inv.mode !== "personal") return { ...inv, guests: [] };
      const [list, sms] = await Promise.all([listGuests(ctx, inv.id), guestSmsStatuses(ctx, inv.id)]);
      return { ...inv, guests: list.map((g) => ({ ...g, sms: sms.get(g.id) ?? null })) };
    });

    priv.patch("/invitations/:id", async (req) => {
      const inv = await updateInvitation(ctx, req.user.id, id.parse(req.params).id, updateSchema.parse(req.body));
      await track(ctx, req.user.id, "invitation_updated", { invitationId: inv.id });
      return inv;
    });

    priv.post("/invitations/:id/publish", async (req) => {
      const inv = await publishInvitation(ctx, req.user.id, id.parse(req.params).id);
      await track(ctx, req.user.id, "invitation_published", { invitationId: inv.id });
      return inv;
    });

    priv.post("/invitations/:id/guests", async (req, reply) => {
      const invitationId = id.parse(req.params).id;
      const added = await addGuests(ctx, req.user.id, invitationId, guestsSchema.parse(req.body).guests);
      await track(ctx, req.user.id, "guests_added", { invitationId, count: added.length });
      return reply.code(201).send(added);
    });

    priv.patch("/invitations/:id/guests/:guestId", async (req) => {
      const p = z.object({ id: z.uuid(), guestId: z.uuid() }).parse(req.params);
      return updateGuest(ctx, req.user.id, p.id, p.guestId, guestSchema.partial().parse(req.body));
    });

    // Рассылка приглашений гостям по SMS. Без guestIds отправляется всем, кому можно.
    priv.post("/invitations/:id/sms", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
      const { guestIds } = z.object({ guestIds: z.array(z.uuid()).max(500).optional() }).parse(req.body ?? {});
      return sendInvitationSms(ctx, req.user.id, id.parse(req.params).id, guestIds);
    });

    priv.delete("/invitations/:id/guests/:guestId", async (req) => {
      const p = z.object({ id: z.uuid(), guestId: z.uuid() }).parse(req.params);
      await removeGuest(ctx, req.user.id, p.id, p.guestId);
      return { ok: true };
    });

    priv.post("/orders", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const result = await createOrder(ctx, req.user.id, orderSchema.parse(req.body));
      return reply.code(result.status === "pending" ? 201 : 200).send(result);
    });

    priv.get("/orders", async (req) =>
      ctx.db.select().from(orders).where(eq(orders.userId, req.user.id)).orderBy(desc(orders.createdAt)).limit(100),
    );

    priv.get("/orders/:id", async (req, reply) => {
      const [order] = await ctx.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, id.parse(req.params).id), eq(orders.userId, req.user.id)));
      return order ?? reply.code(404).send({ error: "Заказ не найден" });
    });
  });
};
