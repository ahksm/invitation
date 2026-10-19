import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE } from "../app.js";
import { redeemLoginCode } from "../auth/codes.js";
import { claimTelegramLogin, describeDevice, isNonce, startTelegramLogin, verifyWebAppInitData } from "../auth/telegram.js";
import { botUsername } from "../config.js";
import { HttpError } from "../errors.js";
import { locales, pickLocale, requestLocale } from "../i18n.js";
import { normalizePhone, requestOtp, upsertPhoneUser, verifyOtp } from "../services/phone.js";
import { getPrices } from "../services/settings.js";
import { track } from "../services/usage.js";
import { getAccess, getUser, setUserLocale, upsertTelegramUser } from "../services/users.js";

const TG_COOKIE = "tglogin";
export const phoneSchema = z.string().max(32).transform((s, c) => {
  const p = normalizePhone(s);
  if (!p) c.addIssue({ code: "custom", message: "Введите узбекский номер: +998 XX XXX-XX-XX" });
  return p ?? "";
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const secure = ctx.config.APP_URL.startsWith("https://");
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  async function startSession(reply: FastifyReply, userId: string) {
    const token = await reply.jwtSign({ sub: userId });
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return token;
  }

  // Общая конфигурация для фронтенда: вход через Telegram, адрес сайта, цены, помощник с текстом.
  // Вход через Telegram показывается, только пока бот запущен: подтверждение входа приходит от него.
  app.get("/config", async () => ({
    telegram: botUsername(ctx.config) !== null,
    botUsername: botUsername(ctx.config),
    appUrl: ctx.config.APP_URL.replace(/\/+$/, ""),
    prices: await getPrices(ctx),
    currency: ctx.config.CURRENCY,
    ai: Boolean(ctx.config.ANTHROPIC_API_KEY),
  }));

  // Шаг 1 входа через Telegram: ссылка на бота и секрет этого браузера в cookie.
  app.post("/telegram/start", strict, async (req, reply) => {
    const bot = botUsername(ctx.config);
    if (!bot) throw new HttpError(503, "Вход через Telegram не настроен");
    const { nonce, secret, ttl } = await startTelegramLogin(ctx.cache, describeDevice(req.headers["user-agent"]));
    reply.setCookie(TG_COOKIE, secret, { httpOnly: true, secure, sameSite: "lax", path: "/api/auth/telegram", maxAge: ttl });
    return { nonce, url: `https://t.me/${bot}?start=auth_${nonce}`, ttl };
  });

  // Шаг 2: браузер ждёт, пока человек подтвердит вход в боте.
  app.post("/telegram/poll", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { nonce } = z.object({ nonce: z.string().refine(isNonce) }).parse(req.body);
    const secret = req.cookies[TG_COOKIE];
    if (!secret) return { status: "expired" };
    const result = await claimTelegramLogin(ctx.cache, nonce, secret);
    if (typeof result === "string") return { status: result };
    const user = await getUser(ctx, result.userId);
    if (!user || user.blocked || !user.phone) return { status: "expired" };
    reply.clearCookie(TG_COOKIE, { path: "/api/auth/telegram" });
    await startSession(reply, user.id);
    await track(ctx, user.id, "login", { via: "telegram" });
    return { status: "ok", redirect: user.isAdmin ? "/admin/" : "/app/" };
  });

  // Вход из мини-аппа Telegram. Если номера ещё нет, мини-апп запрашивает контакт
  // (Telegram.WebApp.requestContact), бот получает его и привязывает, а мини-апп ждёт phone в ответе.
  // Пока человек отвечает на запрос контакта, мини-апп повторяет этот запрос, поэтому лимит выше strict:
  // 40 в минуту хватает на опрос раз в 3 секунды (20 в минуту) с запасом на соседей за тем же IP.
  app.post("/webapp", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { initData } = z.object({ initData: z.string().max(4096) }).parse(req.body);
    const profile = verifyWebAppInitData(initData, ctx.config.TELEGRAM_BOT_TOKEN);
    if (!profile) throw new HttpError(401, "Данные Telegram не прошли проверку");
    const user = await upsertTelegramUser(ctx, profile);
    if (user.blocked) throw new HttpError(403, "Доступ заблокирован");
    if (!user.phone) return { status: "phone_required" };
    const token = await startSession(reply, user.id);
    await track(ctx, user.id, "login", { via: "webapp" });
    // В Telegram Web мини-апп открыт во фрейме чужого сайта, и cookie с SameSite=Lax туда не доходит.
    // Поэтому токен отдаётся и в ответе: мини-апп шлёт его в заголовке Authorization: Bearer.
    return { status: "ok", redirect: user.isAdmin ? "/admin/" : "/app/", token };
  });

  app.post("/phone/request", strict, async (req) => {
    const { phone } = z.object({ phone: phoneSchema }).parse(req.body);
    return requestOtp(ctx, phone, req.ip, requestLocale(req.headers));
  });

  app.post("/phone/verify", strict, async (req, reply) => {
    const { phone, code } = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, "Код состоит из 6 цифр") }).parse(req.body);
    if (!(await verifyOtp(ctx, phone, code))) throw new HttpError(400, "Неверный или устаревший код");
    const user = await upsertPhoneUser(ctx, phone, requestLocale(req.headers));
    if (user.blocked) throw new HttpError(403, "Доступ заблокирован");
    await startSession(reply, user.id);
    await track(ctx, user.id, "login", { via: "sms" });
    return { status: "ok", redirect: user.isAdmin ? "/admin/" : "/app/" };
  });

  // Вход по одноразовой ссылке из бота (команда /login).
  app.get("/link", strict, async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.query);
    const userId = await redeemLoginCode(ctx.cache, code);
    const user = userId ? await getUser(ctx, userId) : undefined;
    if (!user || user.blocked || !user.phone) return reply.redirect("/app/#/login-expired");
    await startSession(reply, user.id);
    await track(ctx, user.id, "login", { via: "bot" });
    return reply.redirect(user.isAdmin ? "/admin/" : "/app/");
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { onRequest: app.authenticate }, async (req) => {
    const u = req.user;
    const access = await getAccess(ctx, u);
    return {
      user: {
        id: u.id,
        phone: u.phone,
        firstName: u.firstName,
        lastName: u.lastName,
        username: u.username,
        // Строкой: Telegram ID может не поместиться в число JavaScript на клиенте.
        telegramId: u.telegramId === null ? null : String(u.telegramId),
        locale: pickLocale(u.locale),
        isAdmin: u.isAdmin,
        freeAccess: u.freeAccess,
      },
      access: { free: access.free, subscribed: access.subscribed, subscriptionEndsAt: access.subscriptionEndsAt?.toISOString() ?? null },
      prices: await getPrices(ctx),
      currency: ctx.config.CURRENCY,
    };
  });

  app.patch("/me", { onRequest: app.authenticate }, async (req) => {
    const { locale } = z.object({ locale: z.enum(locales) }).parse(req.body);
    await setUserLocale(ctx, req.user.id, locale);
    return { ok: true, locale };
  });
};
