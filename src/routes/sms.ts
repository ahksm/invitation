import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { applySmsDelivery } from "../services/sms.js";

/** Колбэки о доставке SMS. Eskiz не подписывает их, поэтому проверяем секрет в адресе. */
export const smsRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.post("/:provider/callback", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { provider } = z.object({ provider: z.string() }).parse(req.params);
    const { secret = "" } = z.object({ secret: z.string().optional() }).parse(req.query);
    const expected = Buffer.from(ctx.config.SMS_CALLBACK_SECRET);
    const got = Buffer.from(secret);
    if (provider !== ctx.sms.name || !expected.length || expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return reply.code(404).send({ error: "not found" });
    }
    const report = ctx.sms.parseDelivery(req.body);
    if (report) await applySmsDelivery(ctx, report.providerRef, report.status);
    return { ok: true };
  });
};
