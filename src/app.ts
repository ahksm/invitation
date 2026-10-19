import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import type { Ctx } from "./context.js";
import type { User } from "./db/schema.js";
import { HttpError } from "./errors.js";
import { requestLocale, translateError } from "./i18n.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { invitationRoutes } from "./routes/invitations.js";
import { paymentRoutes } from "./routes/payments.js";
import { publicRoutes } from "./routes/public.js";
import { smsRoutes } from "./routes/sms.js";
import { getPublicPage } from "./services/public-page.js";
import { getUser } from "./services/users.js";
import { siteHelmet } from "./web/csp.js";
import { webRoutes } from "./web/pages.js";

declare module "fastify" {
  interface FastifyInstance {
    ctx: Ctx;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    // После authenticate в request.user лежит пользователь из базы, а не payload токена.
    user: User;
  }
}

export const SESSION_COOKIE = "session";
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

// Пути, куда приходят запросы от внешних систем: проверка Origin к ним не применяется.
const EXTERNAL_PATHS = [/^\/api\/payments\/[\w-]+\/callback$/, /^\/api\/sms\/[\w-]+\/callback$/, /^\/telegram\/webhook$/];

export async function buildApp(deps: Omit<Ctx, "log">, opts: { logger?: boolean } = {}) {
  const { config } = deps;
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  const ctx: Ctx = { ...deps, log: app.log };
  app.decorate("ctx", ctx);

  // CSP и запрет фреймов для всего сайта; страницы приложения переопределяют их в src/web.
  await app.register(helmet, siteHelmet);
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    redis: deps.cache.redis,
    nameSpace: "inv:rl-http:",
    skipOnError: true,
    errorResponseBuilder: () => new HttpError(429, "Слишком много запросов, попробуйте позже"),
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { expiresIn: "30d" },
  });

  // Защита от CSRF: изменяющие запросы к API принимаются только со своего сайта.
  const appOrigin = new URL(config.APP_URL).origin;
  app.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const path = req.url.split("?")[0]!;
    if (EXTERNAL_PATHS.some((re) => re.test(path))) return;
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    if (origin !== appOrigin) throw new HttpError(403, "Запрос с чужого сайта отклонён");
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    let sub: string;
    try {
      ({ sub } = await req.jwtVerify<{ sub: string }>());
    } catch {
      throw new HttpError(401, "Нужно войти");
    }
    const user = await getUser(ctx, sub);
    if (!user) throw new HttpError(401, "Нужно войти");
    if (user.blocked) throw new HttpError(403, "Доступ заблокирован");
    // Номер телефона обязателен для всех аккаунтов: каждый способ входа его привязывает.
    if (!user.phone) throw new HttpError(428, "Привяжите номер телефона");
    req.user = user;
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    if (!req.user.isAdmin) throw new HttpError(403, "Только для администратора");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Неверные данные", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, "необработанная ошибка");
    return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
  });

  // Сообщения об ошибках переводятся на язык запроса.
  app.addHook("preSerialization", async (req, _reply, payload) => {
    const p = payload as { error?: unknown } | null;
    if (p && typeof p === "object" && typeof p.error === "string") return { ...p, error: translateError(p.error, requestLocale(req.headers)) };
    return payload;
  });

  app.get("/health", { config: { rateLimit: false } }, async () => {
    await deps.cache.redis.ping();
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(invitationRoutes, { prefix: "/api" });
  await app.register(paymentRoutes, { prefix: "/api/payments" });
  await app.register(publicRoutes, { prefix: "/api/public" });
  await app.register(smsRoutes, { prefix: "/api/sms" });
  await app.register(adminRoutes, { prefix: "/api/admin" });

  // Фронтенд из дизайна (web/): /, /app, /i/:slug, /g/:token и файлы под /app/.
  await app.register(webRoutes, { publicPage: (req) => getPublicPage(ctx, req) });
  // Админка и её общие файлы.
  await app.register(fastifyStatic, { root: publicDir, prefix: "/", index: ["index.html"] });

  return app;
}
