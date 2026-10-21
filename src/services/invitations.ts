import { randomBytes, randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { cacheKeys } from "../cache.js";
import { coerceContent, contentMediaUrls, contentSchema, normalizeContent, withoutMedia, type InvContent } from "../content.js";
import type { Ctx } from "../context.js";
import {
  defaultInvitationSettings,
  guests,
  invitations,
  orders,
  templates,
  type Invitation,
  type InvitationSettings,
  type Template,
  type User,
} from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { pickLocale, type Locale } from "../i18n.js";
import { quoteTemplate, templatePrice } from "../pricing.js";
import { logEvent } from "./events.js";
import { assertOwnMedia, deleteOwnMedia, mediaUrl, saveBuffer, sniffMedia } from "./media.js";
import { getPrices } from "./settings.js";
import { anonymizeGuestSms } from "./sms-log.js";
import { getAccess } from "./users.js";

export const randomToken = (bytes = 12) => randomBytes(bytes).toString("base64url");

/** Адрес сайта без завершающего слэша. */
export const appUrlOf = (ctx: Pick<Ctx, "config">) => ctx.config.APP_URL.replace(/\/+$/, "");

/** Ссылка нового приглашения: 10 случайных символов a-z0-9, подходит под правила slug. */
export function randomSlug(length = 10) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => abc[randomInt(abc.length)]).join("");
}

/** Слова, которые нельзя занять ссылкой: они совпадают с путями сайта. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["app", "admin", "api", "media", "i", "g", "health", "telegram", "static", "vendor"]);
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "Ссылка: 3–40 символов, латинские буквы, цифры и дефис");

export const settingsPatchSchema = z
  .object({
    r1d: z.boolean(),
    r3h: z.boolean(),
    morning: z.boolean(),
    notify: z.boolean(),
    tables: z.number().int().min(1).max(30),
  })
  .partial();

export type TemplateDto = {
  id: string;
  slug: string;
  event: string | null;
  style: string | null;
  title: string;
  /** null: общая цена sharedTemplate из настроек. */
  price: number | null;
  smsEnabled: boolean;
};

/** Активные шаблоны каталога в порядке дизайна. */
export async function listActiveTemplates(ctx: Pick<Ctx, "db" | "cache">): Promise<TemplateDto[]> {
  return ctx.cache.wrap(cacheKeys.templates, 300, () =>
    ctx.db
      .select({
        id: templates.id,
        slug: templates.slug,
        event: templates.event,
        style: templates.style,
        title: templates.title,
        price: templates.price,
        smsEnabled: templates.smsEnabled,
      })
      .from(templates)
      .where(eq(templates.isActive, true))
      .orderBy(asc(templates.sortOrder), asc(templates.title)),
  );
}

export async function invalidateTemplates(ctx: Pick<Ctx, "cache">) {
  await ctx.cache.invalidate(cacheKeys.templates);
}

/** Сбрасывает кэш публичных страниц приглашения (общей и всех гостевых). extraSlugs: прежние ссылки. */
export async function invalidateInvitation(ctx: Pick<Ctx, "db" | "cache">, inv: { id: string; slug: string }, ...extraSlugs: string[]) {
  const tokens = await ctx.db.select({ token: guests.token }).from(guests).where(eq(guests.invitationId, inv.id));
  await ctx.cache.invalidate(
    cacheKeys.publicShared(inv.slug),
    ...extraSlugs.map(cacheKeys.publicShared),
    ...tokens.map((t) => cacheKeys.publicGuest(t.token)),
  );
}

export async function getOwnInvitation(ctx: Pick<Ctx, "db">, userId: string, id: string): Promise<Invitation> {
  const [inv] = await ctx.db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.userId, userId)));
  if (!inv) throw new HttpError(404, "Приглашение не найдено");
  return inv;
}

/** Архивное приглашение снято с использования: его не меняют, не публикуют, не оплачивают и не рассылают. */
export function assertNotArchived(inv: Pick<Invitation, "status">) {
  if (inv.status === "archived") throw new HttpError(409, "Приглашение в архиве");
}

type DbReader = Pick<Ctx["db"], "select">;

/** Строка приглашения, заблокированная до конца транзакции (выдача мест, смена режима и шаблона). */
export async function lockInvitation(tx: DbReader, id: string): Promise<Invitation> {
  const [row] = await tx.select().from(invitations).where(eq(invitations.id, id)).for("update");
  if (!row) throw new HttpError(404, "Приглашение не найдено");
  return row;
}

async function guestCount(db: DbReader, invitationId: string) {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(guests).where(eq(guests.invitationId, invitationId));
  return n;
}

/**
 * Отменяет начатые оплаты приглашения, которые больше не подходят (сменился режим или шаблон).
 * cheaperThan: только счета на меньшую сумму. Если по отменённому счёту всё же заплатят, applyPayment
 * откажет, и платёжная система вернёт деньги.
 */
export async function cancelPendingOrders(
  tx: Pick<Ctx["db"], "update">,
  invitationId: string,
  kind: "template" | "seats",
  reason: string,
  cheaperThan?: number,
) {
  await tx
    .update(orders)
    .set({ status: "cancelled", meta: sql`${orders.meta} || ${JSON.stringify({ cancelled: reason })}::jsonb` })
    .where(
      and(
        eq(orders.invitationId, invitationId),
        eq(orders.kind, kind),
        eq(orders.status, "pending"),
        cheaperThan === undefined ? undefined : lt(orders.amount, cheaperThan),
      ),
    );
}

/**
 * Режим меняется только у неоплаченного черновика без гостей. В общем режиме гости не оплачиваются
 * по местам: гости владельца иначе получили бы личные ссылки за цену одного шаблона.
 */
function assertModeChangeable(inv: Pick<Invitation, "status" | "unlocked" | "paidSeats">, guests: number) {
  if (inv.status !== "draft" || inv.unlocked || inv.paidSeats > 0) throw new HttpError(409, "Режим можно сменить только у неоплаченного черновика");
  if (guests > 0) throw new HttpError(409, "Режим можно сменить, только пока в приглашении нет гостей");
}

type TemplateInfo = Pick<Template, "id" | "slug" | "event" | "style" | "title" | "price">;
type Row = { inv: Invitation; tpl: TemplateInfo };
const templateInfo = {
  id: templates.id,
  slug: templates.slug,
  event: templates.event,
  style: templates.style,
  title: templates.title,
  price: templates.price,
};

async function ownRow(ctx: Pick<Ctx, "db">, userId: string, id: string): Promise<Row> {
  const [row] = await ctx.db
    .select({ inv: invitations, tpl: templateInfo })
    .from(invitations)
    .innerJoin(templates, eq(templates.id, invitations.templateId))
    .where(and(eq(invitations.id, id), eq(invitations.userId, userId)));
  if (!row) throw new HttpError(404, "Приглашение не найдено");
  return row;
}

async function activeTemplate(ctx: Pick<Ctx, "db">, slug: string): Promise<TemplateInfo> {
  const [tpl] = await ctx.db
    .select(templateInfo)
    .from(templates)
    .where(and(eq(templates.slug, slug), eq(templates.isActive, true)));
  if (!tpl) throw new HttpError(404, "Шаблон не найден");
  return tpl;
}

export type InvitationStats = { guests: number; yes: number; no: number; maybe: number; pending: number; replies: number; people: number };
const emptyStats: InvitationStats = { guests: 0, yes: 0, no: 0, maybe: 0, pending: 0, replies: 0, people: 0 };

/** Счётчики гостей по приглашениям. people: сколько человек придёт (1 + plus у ответивших «да»). */
async function statsFor(ctx: Pick<Ctx, "db">, ids: string[]): Promise<Map<string, InvitationStats>> {
  if (!ids.length) return new Map();
  const by = (status: string) => sql<number>`(count(*) filter (where ${guests.rsvp} = ${status}))::int`;
  const rows = await ctx.db
    .select({
      id: guests.invitationId,
      guests: count(),
      yes: by("yes"),
      no: by("no"),
      maybe: by("maybe"),
      pending: by("pending"),
      people: sql<number>`(coalesce(sum(1 + ${guests.plus}) filter (where ${guests.rsvp} = 'yes'), 0))::int`,
    })
    .from(guests)
    .where(inArray(guests.invitationId, ids))
    .groupBy(guests.invitationId);
  return new Map(rows.map(({ id, ...s }) => [id, { ...s, replies: s.yes + s.no + s.maybe }]));
}

export type InvitationDto = {
  id: string;
  slug: string;
  mode: Invitation["mode"];
  status: Invitation["status"];
  language: Locale;
  template: string;
  event: string | null;
  title: string;
  data: InvContent;
  unlocked: boolean;
  paidSeats: number;
  accessCode: string | null;
  settings: InvitationSettings;
  ogImageUrl: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  links: { shared: string | null };
  stats: InvitationStats;
};

export function toInvitationDto(ctx: Pick<Ctx, "config">, { inv, tpl }: Row, stats: InvitationStats = emptyStats): InvitationDto {
  return {
    id: inv.id,
    slug: inv.slug,
    mode: inv.mode,
    status: inv.status,
    language: pickLocale(inv.language),
    template: tpl.slug,
    event: tpl.event,
    title: inv.title,
    data: coerceContent(inv.data, tpl.style),
    unlocked: inv.unlocked,
    paidSeats: inv.paidSeats,
    accessCode: inv.accessCode,
    settings: { ...defaultInvitationSettings, ...inv.settings },
    ogImageUrl: inv.ogImageUrl,
    publishedAt: inv.publishedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    links: { shared: inv.mode === "shared" ? `${appUrlOf(ctx)}/i/${inv.slug}` : null },
    stats,
  };
}

async function dtoOf(ctx: Pick<Ctx, "db" | "config">, row: Row): Promise<InvitationDto> {
  const stats = await statsFor(ctx, [row.inv.id]);
  return toInvitationDto(ctx, row, stats.get(row.inv.id));
}

/** Заголовок для списков и бота: data.names, иначе название события. */
function titleOf(d: InvContent, tpl: TemplateInfo, language: string) {
  return (d.names?.trim() || eventLabel(tpl.event, pickLocale(language)) || tpl.title).slice(0, 200);
}

/** Приглашения пользователя без архивных, последние изменённые первыми. */
export async function listOwnInvitations(ctx: Pick<Ctx, "db" | "config">, userId: string): Promise<InvitationDto[]> {
  const rows = await ctx.db
    .select({ inv: invitations, tpl: templateInfo })
    .from(invitations)
    .innerJoin(templates, eq(templates.id, invitations.templateId))
    .where(and(eq(invitations.userId, userId), ne(invitations.status, "archived")))
    .orderBy(desc(invitations.updatedAt));
  const stats = await statsFor(
    ctx,
    rows.map((r) => r.inv.id),
  );
  return rows.map((r) => toInvitationDto(ctx, r, stats.get(r.inv.id)));
}

export async function getInvitationDto(ctx: Pick<Ctx, "db" | "config">, userId: string, id: string): Promise<InvitationDto> {
  return dtoOf(ctx, await ownRow(ctx, userId, id));
}

export async function createInvitation(
  ctx: Pick<Ctx, "db" | "config" | "log">,
  userId: string,
  input: { template: string; mode: "shared" | "personal"; language: Locale; data?: unknown },
): Promise<InvitationDto> {
  const tpl = await activeTemplate(ctx, input.template);
  // Файлы, которых уже нет (черновик с ними удалили в другой вкладке), в новое приглашение не попадают.
  const parsed = contentSchema(tpl.style).parse(input.data ?? {});
  const data = withoutMedia(parsed, await assertOwnMedia(ctx, userId, contentMediaUrls(parsed)));
  const [inv] = await ctx.db
    .insert(invitations)
    .values({
      userId,
      templateId: tpl.id,
      mode: input.mode,
      language: input.language,
      title: titleOf(data, tpl, input.language),
      data,
      slug: randomSlug(),
    })
    .returning();
  await logEvent(ctx, inv!.id, "created");
  return toInvitationDto(ctx, { inv: inv!, tpl });
}

export type InvitationPatch = {
  template?: string | undefined;
  mode?: "shared" | "personal" | undefined;
  language?: Locale | undefined;
  data?: Record<string, unknown> | undefined;
  slug?: string | undefined;
  accessCode?: string | null | undefined;
  settings?: z.infer<typeof settingsPatchSchema> | undefined;
};

const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
};

/** Поля содержимого, которые есть на картинке превью ссылки (renderCard в web/invito-engine.js). */
const OG_CARD_FIELDS = ["names", "date", "time", "cover", "font", "palette"] as const satisfies readonly (keyof InvContent)[];

/**
 * Изменяет приглашение. Режим меняется только у неоплаченного черновика без гостей; после оплаты
 * шаблон можно сменить на равный или дешевле; data сливается с сохранённым содержимым по ключам
 * (ключ со значением null удаляется). Начатые оплаты, которые после изменения не подходят, отменяются.
 */
export async function updateInvitation(
  ctx: Pick<Ctx, "db" | "cache" | "config" | "log">,
  user: Pick<User, "id" | "freeAccess" | "isAdmin">,
  id: string,
  patch: InvitationPatch,
): Promise<InvitationDto> {
  const { inv, tpl: oldTpl } = await ownRow(ctx, user.id, id);
  assertNotArchived(inv);
  const set: Partial<typeof invitations.$inferInsert> = {};

  // Проверки режима и шаблона повторяются в транзакции под блокировкой строки: оплата или новые
  // гости, пришедшие параллельно, не проскочат между проверкой и изменением.
  if (patch.mode !== undefined && patch.mode !== inv.mode) {
    assertModeChangeable(inv, await guestCount(ctx.db, inv.id));
    set.mode = patch.mode;
  }

  let tpl = oldTpl;
  let tplPrice = 0;
  let pricier = false;
  if (patch.template !== undefined && patch.template !== oldTpl.slug) {
    tpl = await activeTemplate(ctx, patch.template);
    const [prices, access] = await Promise.all([getPrices(ctx), getAccess(ctx, user)]);
    tplPrice = templatePrice(tpl, prices);
    // Оплаченный шаблон можно поменять на равный или дешевле; с подпиской и бесплатным доступом на любой.
    pricier = quoteTemplate(access, tpl, prices) > 0 && tplPrice > templatePrice(oldTpl, prices);
    if (inv.unlocked && pricier) throw new HttpError(402, "Этот шаблон дороже оплаченного");
    set.templateId = tpl.id;
  }

  if (patch.slug !== undefined && patch.slug !== inv.slug) {
    // Формат проверяется только у новой ссылки: прежнюю, созданную по старым правилам, можно прислать обратно.
    slugSchema.parse(patch.slug);
    if (RESERVED_SLUGS.has(patch.slug)) throw new HttpError(400, "Эту ссылку занять нельзя");
    const [taken] = await ctx.db.select({ id: invitations.id }).from(invitations).where(eq(invitations.slug, patch.slug));
    if (taken) throw new HttpError(409, "Эта ссылка уже занята");
    set.slug = patch.slug;
  }

  if (patch.accessCode !== undefined) set.accessCode = patch.accessCode;
  if (patch.language !== undefined) set.language = patch.language;
  if (patch.settings !== undefined) set.settings = { ...defaultInvitationSettings, ...inv.settings, ...patch.settings };

  let cardChanged = false;
  // Файлы, которых после правки нет в содержимом: заменённая обложка, убранное фото, другая музыка или видео.
  let dropped: string[] = [];
  if (patch.data !== undefined || set.templateId || set.language) {
    const current = coerceContent(inv.data, oldTpl.style);
    let data: InvContent;
    if (patch.data !== undefined) {
      const merged: Record<string, unknown> = { ...current, ...patch.data };
      for (const [k, v] of Object.entries(patch.data)) if (v === null) delete merged[k];
      data = contentSchema(tpl.style).parse(merged);
      // Новые файлы должны быть загружены самим владельцем; уже сохранённые адреса не перепроверяются.
      // Файлы, удалённые прежним сохранением (фото убрали в другой вкладке), выпадают из data, остальное сохраняется.
      const saved = new Set(contentMediaUrls(current));
      data = withoutMedia(
        data,
        await assertOwnMedia(
          ctx,
          user.id,
          contentMediaUrls(data).filter((u) => !saved.has(u)),
        ),
      );
    } else {
      data = normalizeContent(current, tpl.style);
    }
    set.data = data;
    const kept = new Set(contentMediaUrls(data));
    dropped = contentMediaUrls(current).filter((u) => !kept.has(u));
    set.title = titleOf(data, tpl, set.language ?? inv.language);
    cardChanged = OG_CARD_FIELDS.some((k) => data[k] !== current[k]);
  }

  // Превью ссылки (og:image) нарисовано фронтендом по именам, дате, обложке, оформлению, языку и адресу
  // (renderCard). После их правки оно устарело — например, показывало бы стёртую дату: картинка сбрасывается,
  // og:image страницы — обложка, пока экран «Поделиться» не загрузит новое превью (PUT /og).
  if (
    inv.ogImageUrl &&
    (cardChanged || set.templateId || set.slug || (set.mode && set.mode !== inv.mode) || (set.language && set.language !== inv.language))
  ) {
    set.ogImageUrl = null;
  }

  if (!Object.keys(set).length) return dtoOf(ctx, { inv, tpl });
  let updated: Invitation | undefined;
  try {
    updated = await ctx.db.transaction(async (tx) => {
      if (set.mode || set.templateId) {
        const cur = await lockInvitation(tx, inv.id);
        assertNotArchived(cur);
        if (set.mode) {
          assertModeChangeable(cur, await guestCount(tx, inv.id));
          // Счета прежнего режима (места у общего, шаблон у персонального) больше не нужны.
          await cancelPendingOrders(tx, inv.id, set.mode === "shared" ? "seats" : "template", "mode_changed");
        }
        if (set.templateId) {
          if (cur.unlocked && pricier) throw new HttpError(402, "Этот шаблон дороже оплаченного");
          // Счёт за прежний шаблон, которого не хватает на новый, не должен его открыть.
          if (!cur.unlocked) await cancelPendingOrders(tx, inv.id, "template", "template_changed", tplPrice);
        }
      }
      const [row] = await tx.update(invitations).set(set).where(eq(invitations.id, inv.id)).returning();
      // Столов стало меньше: гости с исчезнувших столов остаются без стола.
      if (set.settings && set.settings.tables < (inv.settings.tables ?? defaultInvitationSettings.tables)) {
        await tx
          .update(guests)
          .set({ tableNo: 0 })
          .where(and(eq(guests.invitationId, inv.id), gt(guests.tableNo, set.settings.tables)));
      }
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Эта ссылка уже занята");
    throw err;
  }
  await invalidateInvitation(ctx, updated!, ...(updated!.slug !== inv.slug ? [inv.slug] : []));
  // Сброшенное превью и файлы, ушедшие из содержимого, удаляются; те, что есть в других приглашениях владельца
  // (копии), остаются. Так у удалённого черновика не остаётся прежних обложек и фото.
  for (const url of new Set([...(set.ogImageUrl === null ? [inv.ogImageUrl] : []), ...dropped])) await deleteOwnMedia(ctx, user.id, url);
  return dtoOf(ctx, { inv: updated!, tpl });
}

/**
 * Удаляет приглашение. Черновик без оплат (и без начатых оплат) удаляется насовсем вместе со своими файлами, остальное
 * уходит в архив: публичные страницы отдают 404, оплаченное (заказы, paid_seats) не теряется.
 * Гости архивного приглашения удаляются сразу, а их SMS в журнале обезличиваются: из архива
 * приглашение не возвращается, владелец его больше не видит, а политика конфиденциальности обещает
 * хранить данные гостей, только пока организатор не удалит гостя или приглашение.
 */
export async function deleteInvitation(ctx: Pick<Ctx, "db" | "cache" | "config" | "log">, userId: string, id: string) {
  const inv = await getOwnInvitation(ctx, userId, id);
  const [{ n: orderCount } = { n: 0 }] = await ctx.db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.invitationId, inv.id), inArray(orders.status, ["pending", "paid"])));
  if (inv.status === "draft" && !inv.unlocked && inv.paidSeats === 0 && orderCount === 0) {
    // Черновик никогда не попадал в кэш публичных страниц: сбрасывать нечего.
    await ctx.db.delete(invitations).where(eq(invitations.id, inv.id));
    // Вместе с ним удаляются его файлы; те, что есть в других приглашениях владельца (копии), остаются.
    for (const url of new Set([inv.ogImageUrl, ...contentMediaUrls(coerceContent(inv.data, null))])) await deleteOwnMedia(ctx, userId, url);
    return;
  }
  const removed = await ctx.db.transaction(async (tx) => {
    await tx.update(invitations).set({ status: "archived" }).where(eq(invitations.id, inv.id));
    const gone = await tx.delete(guests).where(eq(guests.invitationId, inv.id)).returning({ token: guests.token });
    // После удаления гостей: SMS, начатая параллельно, либо уже записана и обезличится, либо не пройдёт по guest_id.
    await anonymizeGuestSms(tx, { invitationId: inv.id });
    return gone;
  });
  // Гостей в базе уже нет: их страницы в кэше сбрасываются по ключам удалённых строк.
  await ctx.cache.invalidate(cacheKeys.publicShared(inv.slug), ...removed.map((g) => cacheKeys.publicGuest(g.token)));
}

/** Копия как новый черновик: содержимое, шаблон, язык и режим, без ссылки, оплат, гостей и пароля. */
export async function duplicateInvitation(ctx: Pick<Ctx, "db" | "config" | "log">, userId: string, id: string): Promise<InvitationDto> {
  const { inv: src, tpl } = await ownRow(ctx, userId, id);
  // Как и при создании: на выключенном шаблоне (например, старом invite-cover) новые приглашения не начинают.
  const [active] = await ctx.db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.id, tpl.id), eq(templates.isActive, true)));
  if (!active) throw new HttpError(409, "Шаблон больше недоступен, выберите другой");
  const [inv] = await ctx.db
    .insert(invitations)
    .values({
      userId,
      templateId: src.templateId,
      mode: src.mode,
      language: src.language,
      title: src.title,
      data: coerceContent(src.data, tpl.style),
      slug: randomSlug(),
    })
    .returning();
  await logEvent(ctx, inv!.id, "created", { meta: { from: src.id } });
  return toInvitationDto(ctx, { inv: inv!, tpl });
}

/** Публикует приглашение. Общее нужно оплатить, у персонального должно быть хотя бы одно оплаченное место. */
export async function publishInvitation(ctx: Pick<Ctx, "db" | "cache" | "config" | "log">, userId: string, id: string): Promise<InvitationDto> {
  const { inv, tpl } = await ownRow(ctx, userId, id);
  assertNotArchived(inv);
  if (inv.mode === "shared" && !inv.unlocked) throw new HttpError(402, "Сначала оплатите шаблон или оформите подписку");
  if (inv.mode === "personal" && inv.paidSeats < 1) throw new HttpError(402, "Сначала оплатите места для гостей");
  // Первая публикация ставит publishedAt и пишет событие; повторная только возвращает статус active.
  // Приглашение, ушедшее в архив во время запроса, не возвращается из архива.
  const notArchived = and(eq(invitations.id, inv.id), ne(invitations.status, "archived"));
  let [updated] = await ctx.db
    .update(invitations)
    .set({ status: "active", publishedAt: new Date() })
    .where(and(notArchived, isNull(invitations.publishedAt)))
    .returning();
  if (updated) await logEvent(ctx, inv.id, "published");
  else [updated] = await ctx.db.update(invitations).set({ status: "active" }).where(notArchived).returning();
  if (!updated) throw new HttpError(409, "Приглашение в архиве");
  await invalidateInvitation(ctx, inv);
  return dtoOf(ctx, { inv: updated!, tpl });
}

/** Картинка превью ссылки (og:image): PNG или JPEG, хранится как загруженный файл. Прежняя удаляется. */
export async function setOgImage(
  ctx: Pick<Ctx, "db" | "cache" | "config" | "log">,
  user: Pick<User, "id" | "isAdmin" | "freeAccess">,
  id: string,
  body: Buffer,
): Promise<{ ogImageUrl: string }> {
  const inv = await getOwnInvitation(ctx, user.id, id);
  assertNotArchived(inv);
  const type = sniffMedia(body);
  if (!type || (type.ext !== "png" && type.ext !== "jpg")) throw new HttpError(415, "Нужна картинка PNG или JPEG");
  const file = await saveBuffer(ctx, user, body, type);
  const ogImageUrl = mediaUrl(file);
  await ctx.db.update(invitations).set({ ogImageUrl }).where(eq(invitations.id, inv.id));
  await deleteOwnMedia(ctx, user.id, inv.ogImageUrl);
  await invalidateInvitation(ctx, inv);
  return { ogImageUrl };
}
