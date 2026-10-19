import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import { coerceContent, sectionOn, type InvContent } from "../content.js";
import type { Ctx } from "../context.js";
import { guests, invitations, templates, type Guest, type GuestDiet, type Invitation } from "../db/schema.js";
import { eventLabel } from "../design-data.js";
import { HttpError } from "../errors.js";
import { dateLocale, pickLocale, type Locale } from "../i18n.js";
import { logEvent } from "./events.js";
import { takeSeats } from "./guests.js";
import { appUrlOf, invalidateInvitation, randomToken } from "./invitations.js";
import { notifyOwnerLater } from "./notify.js";
import { isGuestPaid } from "./seats.js";

/**
 * Публичные страницы приглашения: общая ссылка /i/<slug> и личная /g/<token>.
 * Представление (PublicView) кэшируется в Redis; кэш сбрасывается после ответов гостей и
 * изменений владельца (invalidateInvitation). Открытие личной ссылки пишется в базу вне кэша.
 */

export type PublicGuest = { name: string; token: string; rsvp: Guest["rsvp"]; count: number; diet: GuestDiet[]; msg: string; checkedIn: boolean };

export type PublicView = {
  kind: "shared" | "personal";
  slug: string;
  language: Locale;
  template: string;
  event: string | null;
  data: InvContent;
  guest?: PublicGuest;
  /** Кто придёт: только при data.showGuests и включённой секции «who». */
  who?: { count: number; list: { name: string; plus: number }[]; more: number };
  /** Гостевая книга: только при включённой секции «guestbook». */
  guestbook?: { name: string; text: string }[];
  botUsername: string | null;
  appUrl: string;
};

/** Внешний вид страницы ввода пароля: шаблон, шрифт и палитра без содержимого. */
export type Look = { template: string; font: string | null; palette: number };

/** Мета-теги страницы: og:title, og:description, og:image (абсолютный адрес или null), og:url. */
export type PageMeta = { title: string; description: string; image: string | null; url: string };

export type PublicPage =
  | { status: 200; view: PublicView; meta: PageMeta }
  | { status: 401; locked: { look: Look }; meta: PageMeta }
  | { status: 404 | 429; meta: PageMeta };

const WHO_LIMIT = 14;
const GUESTBOOK_LIMIT = 30;
const CODE_ATTEMPTS = 10;
/** Гостей, ответивших по общей ссылке, на одно приглашение. */
export const SELF_GUESTS_LIMIT = 1000;

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const TOKEN_RE = /^[\w-]{8,64}$/;

/** «Анна Каримова» → «Анна К.»: имя и первая буква второго слова, как в дизайне. */
export function shortName(name: string): string {
  const [first = "", second] = name.trim().split(/\s+/);
  const initial = second ? Array.from(second)[0] : undefined;
  return initial ? `${first} ${initial}.` : first;
}

/** Длинная дата на языке приглашения: «12 декабря 2026 г.». Дата события — местная дата Ташкента. */
export function longDate(date: string, lang: Locale): string {
  const d = new Date(`${date}T12:00:00+05:00`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(dateLocale[lang], { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tashkent" }).format(d);
}

/** Сборщики ссылок для превью (Telegram, WhatsApp и т.п.) не считаются открытием приглашения. */
export function isPreviewBot(userAgent: string | undefined): boolean {
  return /bot\b|crawl|spider|facebookexternalhit|whatsapp|slack|discord|vkshare|viber|skypeuripreview|embedly|preview/i.test(userAgent ?? "");
}

type Row = { inv: Invitation; tpl: { slug: string; event: string | null; style: string | null } };
const tplCols = { slug: templates.slug, event: templates.event, style: templates.style };

function pageMeta(ctx: Pick<Ctx, "config">, { inv, tpl }: Row, data: InvContent, url: string): PageMeta {
  const lang = pickLocale(inv.language);
  const names = data.names?.trim() || eventLabel(tpl.event, lang) || ctx.config.APP_NAME;
  const date = data.date ? longDate(data.date, lang) : "";
  const message = Array.from((data.message ?? "").replace(/\s+/g, " ").trim());
  const image = inv.ogImageUrl || data.cover || "";
  return {
    title: date ? `${names} — ${date}` : names,
    description: message.length > 160 ? `${message.slice(0, 159).join("").trimEnd()}…` : message.join(""),
    image: image ? (image.startsWith("/") ? `${appUrlOf(ctx)}${image}` : image) : null,
    url,
  };
}

/** Для запертой паролем страницы: без имён, текста и картинок. */
const lockedMeta = (ctx: Pick<Ctx, "config">, { inv, tpl }: Row, url: string): PageMeta => ({
  title: eventLabel(tpl.event, pickLocale(inv.language)) ?? ctx.config.APP_NAME,
  description: "",
  image: null,
  url,
});

const notFoundMeta = (ctx: Pick<Ctx, "config">, url: string): PageMeta => ({ title: ctx.config.APP_NAME, description: "", image: null, url });

/** «Кто придёт» и гостевая книга. me: гость личной ссылки, он идёт первым в списке. */
async function social(ctx: Pick<Ctx, "db">, invitationId: string, data: InvContent, meId?: string): Promise<Pick<PublicView, "who" | "guestbook">> {
  const showWho = data.showGuests !== false && sectionOn(data, "who");
  const showBook = sectionOn(data, "guestbook");
  if (!showWho && !showBook) return {};
  const rows = await ctx.db
    .select({ id: guests.id, name: guests.name, plus: guests.plus, rsvp: guests.rsvp, message: guests.message, respondedAt: guests.respondedAt })
    .from(guests)
    .where(and(eq(guests.invitationId, invitationId), inArray(guests.rsvp, ["yes", "maybe"])))
    .orderBy(asc(guests.respondedAt), asc(guests.seat));
  const out: Pick<PublicView, "who" | "guestbook"> = {};
  if (showWho) {
    const yes = rows.filter((r) => r.rsvp === "yes").sort((a, b) => Number(b.id === meId) - Number(a.id === meId));
    const list = yes.slice(0, WHO_LIMIT).map((r) => ({ name: shortName(r.name), plus: r.plus }));
    out.who = { count: yes.reduce((n, r) => n + 1 + r.plus, 0), list, more: yes.length - list.length };
  }
  if (showBook) {
    out.guestbook = rows
      .filter((r) => r.message?.trim())
      .reverse()
      .slice(0, GUESTBOOK_LIMIT)
      .map((r) => ({ name: shortName(r.name), text: r.message!.trim() }));
  }
  return out;
}

function baseView(ctx: Pick<Ctx, "config">, kind: PublicView["kind"], { inv, tpl }: Row, data: InvContent): PublicView {
  return {
    kind,
    slug: inv.slug,
    language: pickLocale(inv.language),
    template: tpl.slug,
    event: tpl.event,
    data,
    botUsername: ctx.config.TELEGRAM_BOT_USERNAME || null,
    appUrl: appUrlOf(ctx),
  };
}

type SharedEntry = { invitationId: string; slug: string; accessCode: string | null; look: Look; view: PublicView; meta: PageMeta; lockedMeta: PageMeta };
type GuestEntry = { invitationId: string; slug: string; guestId: string; view: PublicView; meta: PageMeta };

/** Общая ссылка: только общее, опубликованное и оплаченное приглашение. */
async function sharedEntry(ctx: Pick<Ctx, "db" | "cache" | "config">, slug: string): Promise<SharedEntry | null> {
  if (!SLUG_RE.test(slug)) return null;
  return ctx.cache.wrap(cacheKeys.publicShared(slug), 300, async () => {
    const [row] = await ctx.db
      .select({ inv: invitations, tpl: tplCols })
      .from(invitations)
      .innerJoin(templates, eq(templates.id, invitations.templateId))
      .where(eq(invitations.slug, slug));
    if (!row || row.inv.mode !== "shared" || row.inv.status !== "active" || !row.inv.unlocked) return null;
    const data = coerceContent(row.inv.data, row.tpl.style);
    const url = `${appUrlOf(ctx)}/i/${row.inv.slug}`;
    return {
      invitationId: row.inv.id,
      slug: row.inv.slug,
      accessCode: row.inv.accessCode,
      look: { template: row.tpl.slug, font: data.font ?? null, palette: data.palette ?? 0 },
      view: { ...baseView(ctx, "shared", row, data), ...(await social(ctx, row.inv.id, data)) },
      meta: pageMeta(ctx, row, data, url),
      lockedMeta: lockedMeta(ctx, row, url),
    };
  });
}

/** Личная ссылка гостя: приглашение опубликовано, место гостя оплачено (у общего: шаблон оплачен). */
async function guestEntry(ctx: Pick<Ctx, "db" | "cache" | "config">, token: string): Promise<GuestEntry | null> {
  if (!TOKEN_RE.test(token)) return null;
  return ctx.cache.wrap(cacheKeys.publicGuest(token), 120, async () => {
    const [row] = await ctx.db
      .select({ g: guests, inv: invitations, tpl: tplCols })
      .from(guests)
      .innerJoin(invitations, eq(invitations.id, guests.invitationId))
      .innerJoin(templates, eq(templates.id, invitations.templateId))
      .where(eq(guests.token, token));
    if (!row || row.inv.status !== "active") return null;
    if (row.inv.mode === "shared" ? !row.inv.unlocked : !(await isGuestPaid(ctx, row.inv, row.g))) return null;
    const { g } = row;
    const data = coerceContent(row.inv.data, row.tpl.style);
    const guest: PublicGuest = {
      name: g.name,
      token: g.token,
      rsvp: g.rsvp,
      count: 1 + g.plus,
      diet: g.diet,
      msg: g.message ?? "",
      checkedIn: g.checkedInAt !== null,
    };
    return {
      invitationId: row.inv.id,
      slug: row.inv.slug,
      guestId: g.id,
      view: { ...baseView(ctx, "personal", row, data), guest, ...(await social(ctx, row.inv.id, data, g.id)) },
      meta: pageMeta(ctx, row, data, `${appUrlOf(ctx)}/g/${g.token}`),
    };
  });
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Проверка пароля общей ссылки. Не больше 10 неверных попыток в минуту с одного IP:
 * после этого отклоняются все попытки, в том числе верные, до конца минуты.
 */
async function checkCode(ctx: Pick<Ctx, "cache">, expected: string, code: string, ip: string): Promise<"ok" | "wrong" | "limited"> {
  const key = `code:${ip}`;
  if ((await ctx.cache.hits(key)) >= CODE_ATTEMPTS) return "limited";
  if (timingSafeEqual(digest(code), digest(expected))) return "ok";
  await ctx.cache.hit(key, CODE_ATTEMPTS, 60);
  return "wrong";
}

/** Первое открытие личной ссылки: openedAt и событие opened (запись не зависит от кэша). */
async function markOpened(ctx: Pick<Ctx, "db" | "log">, e: GuestEntry) {
  const [first] = await ctx.db
    .update(guests)
    .set({ openedAt: new Date() })
    .where(and(eq(guests.id, e.guestId), isNull(guests.openedAt)))
    .returning({ id: guests.id });
  if (first) await logEvent(ctx, e.invitationId, "opened", { guestId: e.guestId });
}

/**
 * Данные публичной страницы для API и для HTML-страниц /i/:slug и /g/:token (загрузочные данные и мета-теги).
 * code: пароль общей ссылки; ip: для лимита попыток; userAgent: сборщики превью не отмечают открытие.
 */
export async function getPublicPage(
  ctx: Pick<Ctx, "db" | "cache" | "config" | "log">,
  req: { kind: "shared" | "personal"; key: string; code?: string | undefined; ip?: string | undefined; userAgent?: string | undefined },
): Promise<PublicPage> {
  const appUrl = appUrlOf(ctx);
  if (req.kind === "personal") {
    const entry = await guestEntry(ctx, req.key);
    if (!entry) return { status: 404, meta: notFoundMeta(ctx, `${appUrl}/g/${encodeURIComponent(req.key)}`) };
    if (!isPreviewBot(req.userAgent)) await markOpened(ctx, entry);
    return { status: 200, view: entry.view, meta: entry.meta };
  }
  const entry = await sharedEntry(ctx, req.key);
  if (!entry) return { status: 404, meta: notFoundMeta(ctx, `${appUrl}/i/${encodeURIComponent(req.key)}`) };
  if (entry.accessCode !== null) {
    const locked = { status: 401 as const, locked: { look: entry.look }, meta: entry.lockedMeta };
    if (!req.code) return locked;
    const check = await checkCode(ctx, entry.accessCode, req.code, req.ip ?? "unknown");
    if (check === "limited") return { status: 429, meta: entry.lockedMeta };
    if (check === "wrong") return locked;
  }
  return { status: 200, view: entry.view, meta: entry.meta };
}

export type RsvpInput = { status: "yes" | "no" | "maybe"; count: number; diet: GuestDiet[]; msg: string };

function rsvpValues(input: RsvpInput) {
  return {
    rsvp: input.status,
    plus: input.status === "no" ? 0 : input.count - 1,
    diet: [...new Set(input.diet)],
    message: input.msg.trim() || null,
    respondedAt: new Date(),
  };
}

type RsvpCtx = Pick<Ctx, "db" | "cache" | "config" | "notifier" | "log">;

/**
 * После ответа гостя: событие в ленте, сброс кэша (ответ виден в «Кто придёт» у других гостей)
 * и уведомление владельцу в Telegram (в фоне, если включено settings.notify).
 */
async function afterRsvp(ctx: RsvpCtx, inv: { id: string; slug: string }, guest: { id: string; name: string }, input: RsvpInput) {
  await logEvent(ctx, inv.id, input.status, { guestId: guest.id });
  await invalidateInvitation(ctx, inv);
  notifyOwnerLater(ctx, inv.id, { kind: input.status, guestName: guest.name, count: input.count, msg: input.msg });
}

/** Ответ по личной ссылке. false, если ссылка не открывается (не опубликовано или место не оплачено). */
export async function rsvpPersonal(ctx: RsvpCtx, token: string, input: RsvpInput): Promise<boolean> {
  const entry = await guestEntry(ctx, token);
  if (!entry) return false;
  const [g] = await ctx.db.update(guests).set(rsvpValues(input)).where(eq(guests.id, entry.guestId)).returning({ id: guests.id, name: guests.name });
  // Гостя могли удалить, пока его страница лежала в кэше.
  if (!g) return false;
  await afterRsvp(ctx, { id: entry.invitationId, slug: entry.slug }, g, input);
  return true;
}

/**
 * Ответ по общей ссылке: создаёт гостя с source = self или, если передан его guestToken,
 * обновляет прежний ответ. Не больше SELF_GUESTS_LIMIT таких гостей на приглашение.
 */
export async function rsvpShared(
  ctx: RsvpCtx,
  slug: string,
  input: RsvpInput & { name: string; code?: string | undefined; guestToken?: string | undefined },
  ip: string,
): Promise<{ guestToken: string }> {
  const entry = await sharedEntry(ctx, slug);
  if (!entry) throw new HttpError(404, "Приглашение не найдено");
  if (entry.accessCode !== null) {
    if (!input.code) throw new HttpError(401, "Приглашение защищено паролем");
    const check = await checkCode(ctx, entry.accessCode, input.code, ip);
    if (check === "limited") throw new HttpError(429, "Слишком много попыток, попробуйте через минуту");
    if (check === "wrong") throw new HttpError(401, "Неверный пароль");
  }
  const values = { ...rsvpValues(input), name: input.name };
  const guest = await ctx.db.transaction(async (tx) => {
    if (input.guestToken) {
      const [g] = await tx
        .update(guests)
        .set(values)
        .where(and(eq(guests.token, input.guestToken), eq(guests.invitationId, entry.invitationId), eq(guests.source, "self")))
        .returning();
      if (g) return g;
    }
    const seat = await takeSeats(tx, entry.invitationId, 1);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(guests)
      .where(and(eq(guests.invitationId, entry.invitationId), eq(guests.source, "self")));
    if (n >= SELF_GUESTS_LIMIT) throw new HttpError(409, "Для этого приглашения собрано слишком много ответов");
    const [g] = await tx
      .insert(guests)
      .values({ ...values, invitationId: entry.invitationId, seat, token: randomToken(), source: "self" })
      .returning();
    return g!;
  });
  await afterRsvp(ctx, { id: entry.invitationId, slug: entry.slug }, guest, input);
  return { guestToken: guest.token };
}
