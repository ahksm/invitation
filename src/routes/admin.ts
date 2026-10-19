import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gt, ilike, isNotNull, isNull, or, sql, sum, type SQL } from "drizzle-orm";
import { z } from "zod";
import { invitations, orders, smsMessages, subscriptions, templates, usageEvents, users } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { pricesSchema } from "../pricing.js";
import { invalidateTemplates } from "../services/invitations.js";
import { getPrices, setPrices } from "../services/settings.js";
import { track } from "../services/usage.js";
import { parseUserRef } from "../services/user-ref.js";
import { invalidateUser, isConfiguredAdmin } from "../services/users.js";

const id = z.object({ id: z.uuid() });
// Каталог шаблонов задаёт сид из дизайна (событие × стиль), админ меняет только цену и флаги.
// Без значений по умолчанию: PATCH меняет только присланные поля.
const templatePatchSchema = z.strictObject({
  price: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const { db } = ctx;
  app.addHook("onRequest", app.requireAdmin);

  app.get("/stats", async () => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    // Пользователи — те, кто хоть раз входил: бесплатный доступ, выданный заранее, создаёт строку
    // для человека, который ещё не заходил (такие считаются отдельно, в pendingFreeAccess).
    const [[u], [active], [free], [pending], [paid], [subs], [inv]] = await Promise.all([
      db.select({ n: count() }).from(users).where(isNotNull(users.lastSeenAt)),
      db.select({ n: count() }).from(users).where(gt(users.lastSeenAt, monthAgo)),
      db.select({ n: count() }).from(users).where(eq(users.freeAccess, true)),
      db.select({ n: count() }).from(users).where(and(eq(users.freeAccess, true), isNull(users.lastSeenAt))),
      db.select({ n: count(), revenue: sum(orders.amount) }).from(orders).where(eq(orders.status, "paid")),
      db.select({ n: sql<number>`count(distinct ${subscriptions.userId})::int` }).from(subscriptions).where(gt(subscriptions.endsAt, now)),
      db.select({ n: count() }).from(invitations),
    ]);
    return {
      users: u!.n,
      activeLast30Days: active!.n,
      freeAccessUsers: free!.n,
      pendingFreeAccess: pending!.n,
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
      // Поиск в тех видах, в каких админка показывает и просит людей: «@username», «tg:123456789»
      // (как в форме бесплатного доступа), «Имя Фамилия», телефон с пробелами и дефисами.
      const term = q.q.replace(/^@/, "");
      const tg = /^(?:tg|id):?\s*(\d+)$/i.exec(term);
      const likeOf = (v: string) => `%${v.replace(/[%_\\]/g, "\\$&")}%`;
      if (tg) conds.push(sql`${users.telegramId}::text like ${likeOf(tg[1]!)}`);
      else {
        const like = likeOf(term);
        const digits = term.replace(/\D/g, "");
        conds.push(
          or(
            ilike(users.username, like),
            ilike(sql`concat_ws(' ', ${users.firstName}, ${users.lastName})`, like),
            digits ? ilike(users.phone, `%${digits}%`) : undefined,
            sql`${users.telegramId}::text like ${like}`,
          )!,
        );
      }
    }
    // Коррелированные подзапросы пишем с явными алиасами: drizzle не квалифицирует колонки внутри select.
    // bigint: сумма всех оплат пользователя может выйти за int4; в JSON отдаём числом.
    const paidSum = sql<number>`coalesce((select sum(o.amount) from orders o where o.user_id = "users"."id" and o.status = 'paid'), 0)::bigint`.mapWith(Number);
    // mapWith: дата в JSON в ISO, как у остальных полей, а не строкой Postgres.
    const subEnd = sql<Date | null>`(select max(s.ends_at) from subscriptions s where s.user_id = "users"."id")`.mapWith(subscriptions.endsAt);
    if (q.filter === "free") conds.push(eq(users.freeAccess, true));
    if (q.filter === "blocked") conds.push(eq(users.blocked, true));
    if (q.filter === "paying") conds.push(sql`${paidSum} > 0`);
    if (q.filter === "subscribed") conds.push(sql`${subEnd} > now()`);
    const pageSize = 50;
    const where = conds.length ? and(...conds) : undefined;
    const [[total], rows] = await Promise.all([db.select({ n: count() }).from(users).where(where), db
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
      .where(where)
      .orderBy(sql`${users.lastSeenAt} desc nulls last`, desc(users.createdAt), asc(users.id))
      .limit(pageSize)
      .offset((q.page - 1) * pageSize)]);
    // Права админа по ADMIN_PHONES и ADMIN_TELEGRAM_IDS: колонка обновляется только при входе.
    return { items: rows.map((r) => ({ ...r, isAdmin: isConfiguredAdmin(ctx.config, r) })), page: q.page, pageSize, total: total!.n };
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
    return { user: { ...user, isAdmin: isConfiguredAdmin(ctx.config, user) }, invitations: invs, orders: ords, subscriptions: subs, events };
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

  // Выдать (free: false — снять) бесплатный доступ по телефону или Telegram ID. Выдать можно заранее,
  // до первого входа. who разбирает parseUserRef: «+998…» — телефон, «tg:123456789» или цифры — Telegram ID.
  app.post("/users/free-access", async (req, reply) => {
    const body = z
      .object({ who: z.string().trim().min(1).max(32), note: z.string().max(500).optional(), free: z.boolean().default(true) })
      .parse(req.body);
    const ref = parseUserRef(body.who);
    if (!ref) throw new HttpError(400, "Укажите номер телефона или Telegram ID");
    const by = { adminId: req.user.id };
    if (!body.free) {
      const [user] = await db
        .update(users)
        .set({ freeAccess: false })
        .where("phone" in ref ? eq(users.phone, ref.phone) : eq(users.telegramId, ref.telegramId))
        .returning();
      if (!user) return reply.code(404).send({ error: "Пользователь не найден" });
      await invalidateUser(ctx, user.id);
      await track(ctx, user.id, "free_access_revoked", by);
      return user;
    }
    const set = { freeAccess: true, freeAccessNote: body.note ?? null };
    const [user] = await db
      .insert(users)
      .values({ ...ref, ...set })
      .onConflictDoUpdate({ target: "phone" in ref ? users.phone : users.telegramId, set })
      .returning();
    await invalidateUser(ctx, user!.id);
    await track(ctx, user!.id, "free_access_granted", by);
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
      .orderBy(desc(orders.createdAt), desc(orders.number))
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

  // Порядок каталога; старые шаблоны без события в конце.
  app.get("/templates", async () =>
    db.select().from(templates).orderBy(sql`${templates.event} is null`, asc(templates.sortOrder), asc(templates.title)),
  );

  app.patch("/templates/:id", async (req, reply) => {
    const templateId = id.parse(req.params).id;
    const patch = templatePatchSchema.parse(req.body);
    const [tpl] = Object.keys(patch).length
      ? await db.update(templates).set(patch).where(eq(templates.id, templateId)).returning()
      : await db.select().from(templates).where(eq(templates.id, templateId));
    if (!tpl) return reply.code(404).send({ error: "Шаблон не найден" });
    await invalidateTemplates(ctx);
    return tpl;
  });
};
