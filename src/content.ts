import { z } from "zod";
import { SECTIONS, TRACKS, styleFonts } from "./design-data.js";

/**
 * Содержимое приглашения (InvContent, колонка invitations.data): то, что конструктор (web/Invito.dc.html)
 * хранит в `inv`. Все поля необязательны (фронтенд дополняет недостающие значениями по умолчанию),
 * но если поле есть, оно проверяется. Лишние ключи отбрасываются.
 */

const MEDIA_EXT = "jpg|png|webp|gif|mp3|m4a|ogg|wav|mp4|webm|mov";
const OWN_MEDIA = new RegExp(`^/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${MEDIA_EXT})$`);
// Стоковые картинки дизайна. Набор символов узкий: адрес попадает в CSS url() и в атрибуты.
const UNSPLASH = /^https:\/\/images\.unsplash\.com\/[A-Za-z0-9\-._~/?&=%+,:]*$/;

/** MediaUrl: загруженный файл `/media/<id>.<ext>` или картинка с images.unsplash.com. data:, blob: и прочие адреса запрещены. */
export function isMediaUrl(s: string): boolean {
  return s.length <= 500 && (OWN_MEDIA.test(s) || UNSPLASH.test(s));
}

const text = (max: number) => z.string().max(max);
const mediaUrl = z.string().refine(isMediaUrl, "Файл должен быть загружен через /api/media");
const mediaOrEmpty = z.union([z.literal(""), mediaUrl]);
// Время и дата или пустая строка (поле стёрто). Одна строковая схема, а не union с "": так ошибка
// остаётся понятной («Время в формате ЧЧ:ММ»), а не общей «Invalid input» от union.
const hhmmOrEmpty = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "Время в формате ЧЧ:ММ");
const isoDateOrEmpty = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Дата в формате ГГГГ-ММ-ДД")
  .refine((s) => {
    if (!s) return true;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Такой даты нет");

export const INTROS = ["envelope", "curtain", "scratch", "none"] as const;
export const MAP_MODES = ["drawn", "real"] as const;
export const MOTIONS = ["still", "zoom", "video"] as const;

const fields = {
  names: text(200),
  host: text(200),
  message: text(3000),
  venue: text(200),
  address: text(300),
  contact: text(300),
  dress: text(500),
  secret: text(500),
  gifts: text(1000),
  notes: text(1000),
  dressColors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/, "Цвет в формате #rrggbb").transform((c) => c.toLowerCase()))
    .max(6),
  // Пункты программы дня; пункт с местом — остановка маршрута на странице гостя. address — адрес остановки
  // или ссылка на карту: ссылкой страница гостя делает только https-адрес картографического сайта из своего
  // списка (Яндекс, Google, 2ГИС), остальное показывает текстом и ищет на Яндекс Картах.
  program: z
    .array(
      z.object({
        time: hhmmOrEmpty.default(""),
        title: text(120).default(""),
        place: text(200).nullish().transform((p) => p ?? ""),
        address: text(300).nullish().transform((a) => a ?? ""),
      }),
    )
    .max(8),
  // Пустая строка — дата или время стёрты в конструкторе: так и сохраняется, чтобы фронтенд не подставил
  // значение шаблона. null в PATCH удаляет ключ (src/services/invitations.ts). Без даты страница гостя,
  // og:title, напоминания, бот и SMS обходятся без неё.
  date: isoDateOrEmpty,
  time: hhmmOrEmpty,
  // Срок ответа гостей (выбирает владелец, необязательно): «Пожалуйста, ответьте до …» на странице гостя.
  // После этого дня по Ташкенту и после дня события ответы не принимаются (rsvpClosed в src/services/public.ts).
  rsvpBy: isoDateOrEmpty,
  countdown: z.boolean(),
  showGuests: z.boolean(),
  cover: mediaOrEmpty,
  musicSrc: mediaOrEmpty,
  video: mediaOrEmpty,
  gallery: z.array(mediaUrl).max(12),
  font: text(60),
  palette: z.number().int().min(0).max(2),
  music: z.enum([...TRACKS, "custom"]),
  intro: z.enum(INTROS),
  mapMode: z.enum(MAP_MODES),
  motion: z.enum(MOTIONS),
  sections: z.array(z.object({ k: z.enum(SECTIONS), on: z.boolean() })).max(SECTIONS.length * 4),
};

const contentObject = z.object(fields).partial();
export type InvContent = z.output<typeof contentObject>;

/**
 * Приводит содержимое к правилам шаблона:
 * - шрифт, которого нет у стиля, заменяется первым шрифтом стиля;
 * - в секциях убираются повторы, недостающие дописываются в конец выключенными.
 */
export function normalizeContent(d: InvContent, style: string | null | undefined): InvContent {
  const out = { ...d };
  const fonts = styleFonts(style);
  if (out.font !== undefined && fonts.length && !fonts.includes(out.font)) out.font = fonts[0]!;
  if (out.sections) {
    const seen = new Set<string>();
    const list = out.sections.filter((s) => !seen.has(s.k) && seen.add(s.k));
    for (const k of SECTIONS) if (!seen.has(k)) list.push({ k, on: false });
    out.sections = list;
  }
  return out;
}

/** zod-схема содержимого для шаблона заданного стиля (style нужен для проверки шрифта). */
export function contentSchema(style: string | null | undefined) {
  return contentObject.transform((d) => normalizeContent(d, style));
}

/**
 * Содержимое из базы. Старые записи (до дизайна Invito) хранили произвольные строки: оставляем
 * только поля, которые проходят проверку, чтобы чтение никогда не падало.
 */
export function coerceContent(raw: unknown, style: string | null | undefined): InvContent {
  const parsed = contentSchema(style).safeParse(raw);
  if (parsed.success) return parsed.data;
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ok: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(fields)) {
    if (src[k] === undefined) continue;
    const r = schema.safeParse(src[k]);
    if (r.success) ok[k] = r.data;
  }
  return normalizeContent(ok as InvContent, style);
}

/** Загруженные файлы (/media/…) в содержимом: обложка, музыка, видео и галерея. Стоковые картинки не входят. */
export function contentMediaUrls(d: InvContent): string[] {
  return [d.cover, d.musicSrc, d.video, ...(d.gallery ?? [])].filter((u): u is string => typeof u === "string" && u.startsWith("/media/"));
}

/** Содержимое без этих файлов: они убираются из галереи, а обложка, музыка или видео с таким адресом становятся пустыми. */
export function withoutMedia(d: InvContent, urls: ReadonlySet<string>): InvContent {
  if (!urls.size) return d;
  const out = { ...d };
  for (const k of ["cover", "musicSrc", "video"] as const) if (out[k] !== undefined && urls.has(out[k])) out[k] = "";
  if (out.gallery) out.gallery = out.gallery.filter((u) => !urls.has(u));
  return out;
}

/** Включена ли секция. Без списка секций действуют значения дизайна: всё, кроме «reveal». */
export function sectionOn(d: InvContent, k: string): boolean {
  if (!d.sections) return k !== "reveal";
  return d.sections.some((s) => s.k === k && s.on);
}
