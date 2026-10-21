import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { guestDiets } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { getPublicPage, rsvpPersonal, rsvpShared } from "../services/public.js";

const slug = z.string().regex(/^[A-Za-z0-9_-]{3,64}$/);
const token = z.string().regex(/^[\w-]{8,64}$/);
const rsvp = {
  status: z.enum(["yes", "no", "maybe"]),
  count: z.number().int().min(1).max(8).default(1),
  diet: z.array(z.enum(guestDiets)).max(guestDiets.length).default([]),
  msg: z.string().max(500).default(""),
  // Показать сообщение в гостевой книге. Без явного true оно видно только владельцу.
  public: z.boolean().default(false),
};

/** Данные для страниц приглашения, которые открывают гости. Представления кэшируются в Redis. */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  // Общая ссылка. С паролем без верного code отвечает 401 с внешним видом страницы (look) для формы пароля.
  app.get("/i/:slug", async (req, reply) => {
    const p = z.object({ slug }).parse(req.params);
    const { code } = z.object({ code: z.string().max(64).optional() }).parse(req.query);
    const page = await getPublicPage(ctx, { kind: "shared", key: p.slug, code, ip: req.ip });
    reply.header("cache-control", "private, no-store");
    if (page.status === 401) {
      return reply.code(401).send({ locked: true, look: page.locked.look, error: code ? "Неверный пароль" : "Приглашение защищено паролем" });
    }
    if (page.status === 429) throw new HttpError(429, "Слишком много попыток, попробуйте через минуту");
    if (page.status !== 200) return reply.code(404).send({ error: "Приглашение не найдено" });
    return page.view;
  });

  // Личная ссылка гостя. Первое открытие отмечается в базе.
  app.get("/g/:token", async (req, reply) => {
    const p = z.object({ token }).parse(req.params);
    const page = await getPublicPage(ctx, { kind: "personal", key: p.token, userAgent: req.headers["user-agent"] });
    reply.header("cache-control", "private, no-store");
    if (page.status !== 200) return reply.code(404).send({ error: "Приглашение не найдено" });
    return page.view;
  });

  // Ответ по общей ссылке: создаёт гостя или обновляет прежний ответ по guestToken.
  // Гость приходит со своей страницы, поэтому проверка Origin здесь та же, что и для API.
  app.post("/i/:slug/rsvp", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
    const p = z.object({ slug }).parse(req.params);
    const body = z
      .object({
        ...rsvp,
        name: z.string().trim().min(1).max(80),
        code: z.string().max(64).optional(),
        guestToken: token.optional(),
      })
      .parse(req.body);
    return rsvpShared(ctx, p.slug, body, req.ip);
  });

  app.post("/g/:token/rsvp", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const p = z.object({ token }).parse(req.params);
    const body = z.object(rsvp).parse(req.body);
    if (!(await rsvpPersonal(ctx, p.token, body))) return reply.code(404).send({ error: "Приглашение не найдено" });
    return { ok: true };
  });
};
