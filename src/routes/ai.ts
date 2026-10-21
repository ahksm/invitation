import type { FastifyPluginAsync } from "fastify";
import { aiWrite, aiWriteSchema } from "../services/ai.js";

/** Помощник с текстом приглашения (раздел 3.8 спецификации). Лимиты на пользователя считает сервис. */
export const aiRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  app.addHook("onRequest", app.authenticate);

  app.post("/write", async (req) => aiWrite(ctx, req.user.id, aiWriteSchema.parse(req.body)));
};
