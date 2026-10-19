import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { publicGuest, publicShared, setRsvp } from "../services/invitations.js";

const token = z.string().regex(/^[\w-]{8,64}$/);

/** Данные для страниц приглашения, которые открывают гости. Ответы кэшируются в Redis. */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get("/i/:slug", async (req, reply) => {
    const { slug } = z.object({ slug: token }).parse(req.params);
    const view = await publicShared(ctx, slug);
    if (!view) return reply.code(404).send({ error: "Приглашение не найдено" });
    reply.header("cache-control", "public, max-age=60");
    return view;
  });

  app.get("/g/:token", async (req, reply) => {
    const p = z.object({ token }).parse(req.params);
    const view = await publicGuest(ctx, p.token);
    if (!view) return reply.code(404).send({ error: "Приглашение не найдено" });
    reply.header("cache-control", "private, no-store");
    return view;
  });

  // Ответ гостя. Гость приходит по своей ссылке, поэтому проверка Origin здесь та же, что и для API.
  app.post("/g/:token/rsvp", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const p = z.object({ token }).parse(req.params);
    const { rsvp } = z.object({ rsvp: z.enum(["yes", "no", "maybe"]) }).parse(req.body);
    if (!(await setRsvp(ctx, p.token, rsvp))) return reply.code(404).send({ error: "Приглашение не найдено" });
    return { ok: true };
  });
};
