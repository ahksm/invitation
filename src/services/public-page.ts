import type { Ctx } from "../context.js";
import type { PageMeta, PublicPage, PublicPageRequest } from "../web/pages.js";
import { publicGuest, publicShared, type PublicView } from "./invitations.js";

/**
 * Публичные страницы /i/:slug и /g/:token для оболочки фронтенда (src/web/pages.ts) на текущей
 * модели данных: представление то же, что отдают /api/public/i/:slug и /api/public/g/:token
 * (те же условия: опубликовано, оплачено, место гостя оплачено), плюс мета-теги для превью ссылки.
 * Пароля и OG-картинки в этой модели нет, поэтому ответов 401 и 429 не бывает.
 * Бэкенд раздела 3.6 спецификации отдаёт PublicPage из своего getPublicPage с той же сигнатурой:
 * с ним этот файл удаляется, а src/app.ts передаёт в webRoutes его функцию.
 */

// Ключ ссылки как в src/routes/public.ts: пустой, короткий или с чужими символами — сразу 404, без запроса в базу.
const KEY_RE = /^[\w-]{8,64}$/;

const DATE_LOCALE: Record<string, string> = { ru: "ru-RU", uz: "uz-Latn-UZ", uzc: "uz-Cyrl-UZ", en: "en-GB" };

/** Длинная дата на языке приглашения: «12 декабря 2026 г.». Дата события — местная дата Ташкента. */
export function longDate(date: string, lang: string): string {
  const d = new Date(`${date}T12:00:00+05:00`);
  // Несуществующая дата (2026-02-31) не превращается в соседнюю.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d.getTime()) || !d.toISOString().startsWith(date)) return "";
  const fmt = new Intl.DateTimeFormat(DATE_LOCALE[lang] ?? "ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tashkent" });
  return fmt.format(d);
}

/** og:image из обложки: свой файл (/media/…) с адресом сайта или внешний https-адрес; остальное не выводится. */
function imageUrl(appUrl: string, src: string | undefined): string | null {
  if (src?.startsWith("/") && !src.startsWith("//")) return appUrl + src;
  return src?.startsWith("https://") ? src : null;
}

function pageMeta(appUrl: string, view: PublicView, url: string): PageMeta {
  const { data } = view;
  const names = data.names?.trim() || view.title;
  const date = data.date ? longDate(data.date, view.language) : "";
  // Текст приглашения одной строкой, до 160 символов (считаются символы, а не половинки суррогатных пар).
  const message = Array.from((data.message ?? "").replace(/\s+/g, " ").trim());
  return {
    title: date ? `${names} — ${date}` : names,
    description: message.length > 160 ? `${message.slice(0, 159).join("").trimEnd()}…` : message.join(""),
    image: imageUrl(appUrl, data.cover),
    url,
  };
}

export async function getPublicPage(ctx: Pick<Ctx, "db" | "cache" | "config">, req: PublicPageRequest): Promise<PublicPage> {
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  const url = `${appUrl}/${req.kind === "shared" ? "i" : "g"}/${encodeURIComponent(req.key)}`;
  const view = !KEY_RE.test(req.key) ? null : req.kind === "shared" ? await publicShared(ctx, req.key) : await publicGuest(ctx, req.key);
  if (!view) return { status: 404, meta: { title: ctx.config.APP_NAME, description: "", image: null, url } };
  return { status: 200, view, meta: pageMeta(appUrl, view, url) };
}
