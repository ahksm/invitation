import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gt, ilike, or, sql, sum, type SQL } from "drizzle-orm";
import { z } from "zod";
import { invitations, orders, smsMessages, subscriptions, templates, usageEvents, users } from "../db/schema.js";
import { normalizePhone } from "../services/phone.js";
import { HttpError } from "../errors.js";
import { pricesSchema } from "../pricing.js";
import { invalidateTemplates } from "../services/invitations.js";
import { getPrices, setPrices } from "../services/settings.js";
import { track } from "../services/usage.js";
import { invalidateUser } from "../services/users.js";

const id = z.object({ id: z.uuid() });
const templateFields = z
  .array(
    z.object({
      key: z.string().regex(/^[a-zA-Z][\w]{0,40}$/),
      label: z.union([z.string().min(1).max(100), z.partialRecord(z.enum(["ru", "uz", "en"]), z.string().min(1).max(100))]),
      type: z.enum(["text", "textarea", "date", "time", "url"]),
      required: z.boolean().optional(),
    }),
  )
  .max(50);
const templateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  previewUrl: z.url().nullish(),
  price: z.number().int().min(0).nullish(),
  isActive: z.boolean().default(true),
  smsEnabled: z.boolean().default(false),
  fields: templateFields.default([]),
  translations: z.partialRecord(z.enum(["ru", "uz", "en"]), z.object({ title: z.string().max(200).optional(), description: z.string().max(2000).optional() })).default({}),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const { db } = ctx;
  app.addHook("onRequest", app.requireAdmin);

  app.get("/stats", async () => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const [[u], [active], [free], [paid], [subs], [inv]] = await Promise.all([
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(users).where(gt(users.lastSeenAt, monthAgo)),
      db.select({ n: count() }).from(users).where(eq(users.freeAccess, true)),
      db.select({ n: count(), revenue: sum(orders.amount) }).from(orders).where(eq(orders.status, "paid")),
      db.select({ n: sql<number>`count(distinct ${subscriptions.userId})::int` }).from(subscriptions).where(gt(subscriptions.endsAt, now)),
      db.select({ n: count() }).from(invitations),
    ]);
    return {
      users: u!.n,
      activeLast30Days: active!.n,
      freeAccessUsers: free!.n,
      paidOrders: paid!.n,
      revenue: Number(paid!.revenue ?? 0),
      activeSubscriptions: subs!.n,
      invitations: inv!.n,
      currency: ctx.config.CURRENCY,
    };
  });

  app.get("/users", async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(100).optional(),
        filter: z.enum(["all", "free", "paying", "blocked", "subscribed"]).default("all"),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    const conds: SQL[] = [];
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
      const digits = q.q.replace(/\D/g, "");
      conds.push(
        or(
          ilike(users.username, like),
          ilike(users.firstName, like),
          ilike(users.lastName, like),
          digits ? ilike(users.phone, `%${digits}%`) : undefined,
          sql`${users.telegramId}::text like ${like}`,
        )!,
      );
    }
    // Коррелированные подзапросы пишем с явными алиасами: drizzle не квалифицирует колонки внутри select.
    const paidSum = sql<number>`coalesce((select sum(o.amount) from orders o where o.user_id = "users"."id" and o.status = 'paid'), 0)::int`;
    const subEnd = sql<Date | null>`(select max(s.ends_at) from subscriptions s where s.user_id = "users"."id")`;
    if (q.filter === "free") conds.push(eq(users.freeAccess, true));
    if (q.filter === "blocked") conds.push(eq(users.blocked, true));
    if (q.filter === "paying") conds.push(sql`${paidSum} > 0`);
    if (q.filter === "subscribed") conds.push(sql`${subEnd} > now()`);
    const pageSize = 50;
    const rows = await db
      .select({
        id: users.id,
        telegramId: users.telegramId,
        phone: users.phone,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        locale: users.locale,
        isAdmin: users.isAdmin,
        freeAccess: users.freeAccess,
        freeAccessNote: users.freeAccessNote,
        blocked: users.blocked,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        invitations: sql<number>`(select count(*) from invitations i where i.user_id = "users"."id")::int`,
        paidTotal: paidSum,
        subscriptionEndsAt: subEnd,
      })
      .from(users)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${users.lastSeenAt} desc nulls last`)
      .limit(pageSize)
      .offset((q.page - 1) * pageSize);
    return { items: rows, page: q.page, pageSize };
  });

  app.get("/users/:id", async (req, reply) => {
    const userId = id.parse(req.params).id;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return reply.code(404).send({ error: "Пользователь не найден" });
    const [invs, ords, subs, events] = await Promise.all([
      db
        .select({ invitation: invitations, templateTitle: templates.title })
        .from(invitations)
        .innerJoin(templates, eq(templates.id, invitations.templateId))
        .where(eq(invitations.userId, userId))
        .orderBy(desc(invitations.createdAt)),
      db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt)).limit(100),
      db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.endsAt)),
      db.select().from(usageEvents).where(eq(usageEvents.userId, userId)).orderBy(desc(usageEvents.createdAt)).limit(100),
    ]);
    return { user, invitations: invs, orders: ords, subscriptions: subs, events };
  });

  app.patch("/users/:id", async (req, reply) => {
    const userId = id.parse(req.params).id;
    const patch = z
      .object({
        freeAccess: z.boolean().optional(),
        freeAccessNote: z.string().max(500).nullish(),
        blocked: z.boolean().optional(),
      })
      .parse(req.body);
    if (userId === req.user.id && patch.blocked) return reply.code(400).send({ error: "Нельзя заблокировать себя" });
    const [user] = await db.update(users).set(patch).where(eq(users.id, userId)).returning();
    if (!user) return reply.code(404).send({ error: "Пользователь не найден" });
    await invalidateUser(ctx, userId);
    const by = { adminId: req.user.id };
    if (patch.freeAccess !== undefined) await track(ctx, userId, patch.freeAccess ? "free_access_granted" : "free_access_revoked", by);
    if (patch.blocked !== undefined) await track(ctx, userId, patch.blocked ? "user_blocked" : "user_unblocked", by);
    return user;
  });

  // Выдать бесплатный доступ по номеру телефона или Telegram ID, даже если человек ещё не заходил.
  app.post("/users/free-access", async (req) => {
    const body = z.object({ who: z.string().trim().min(1).max(32), note: z.string().max(500).optional() }).parse(req.body);
    const phone = normalizePhone(body.who);
    const telegramId = /^\d{1,15}$/.test(body.who) ? Number(body.who) : NaN;
    if (!phone && !Number.isSafeInteger(telegramId)) throw new HttpError(400, "Укажите номер телефона или Telegram ID");
    const set = { freeAccess: true, freeAccessNote: body.note ?? null };
    const [user] = await db
      .insert(users)
      .values({ ...(phone ? { phone } : { telegramId }), ...set })
      .onConflictDoUpdate({ target: phone ? users.phone : users.telegramId, set })
      .returning();
    await invalidateUser(ctx, user!.id);
    await track(ctx, user!.id, "free_access_granted", { adminId: req.user.id });
    return user;
  });

  app.get("/orders", async (req) => {
    const q = z
      .object({
        status: z.enum(["pending", "paid", "failed", "cancelled"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    return db
      .select({ order: orders, username: users.username, firstName: users.firstName, telegramId: users.telegramId, phone: users.phone })
      .from(orders)
      .innerJoin(users, eq(users.id, orders.userId))
      .where(q.status ? eq(orders.status, q.status) : undefined)
      .orderBy(desc(orders.createdAt))
      .limit(50)
      .offset((q.page - 1) * 50);
  });

  app.get("/activity", async () =>
    db
      .select({ event: usageEvents, username: users.username, firstName: users.firstName, telegramId: users.telegramId, phone: users.phone })
      .from(usageEvents)
      .leftJoin(users, eq(users.id, usageEvents.userId))
      .orderBy(desc(usageEvents.createdAt))
      .limit(200),
  );

  app.get("/sms", async () =>
    db
      .select({
        sms: { id: smsMessages.id, purpose: smsMessages.purpose, phone: smsMessages.phone, text: smsMessages.text, status: smsMessages.status, error: smsMessages.error, createdAt: smsMessages.createdAt },
        userId: users.id,
        username: users.username,
        firstName: users.firstName,
        telegramId: users.telegramId,
        phone: users.phone,
      })
      .from(smsMessages)
      .leftJoin(users, eq(users.id, smsMessages.userId))
      .orderBy(desc(smsMessages.createdAt))
      .limit(200),
  );

  app.get("/prices", async () => getPrices(ctx));
  app.put("/prices", async (req) => setPrices(ctx, pricesSchema.parse(req.body)));

  app.get("/templates", async () => db.select().from(templates).orderBy(desc(templates.createdAt)));

  app.post("/templates", async (req, reply) => {
    const [tpl] = await db.insert(templates).values(templateSchema.parse(req.body)).returning();
    await invalidateTemplates(ctx);
    return reply.code(201).send(tpl);
  });

  app.patch("/templates/:id", async (req, reply) => {
    const [tpl] = await db
      .update(templates)
      .set(templateSchema.partial().parse(req.body))
      .where(eq(templates.id, id.parse(req.params).id))
      .returning();
    if (!tpl) return reply.code(404).send({ error: "Шаблон не найден" });
    await invalidateTemplates(ctx);
    return tpl;
  });
};
