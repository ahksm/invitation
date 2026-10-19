import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, sum } from "drizzle-orm";
import type { Ctx } from "../context.js";
import { media, type Media, type MediaKind, type User } from "../db/schema.js";
import { HttpError } from "../errors.js";

/** Лимиты размера по типу файла и квота на пользователя (админы и бесплатный доступ без квоты). */
export const MEDIA_LIMITS: Record<MediaKind, number> = { image: 10 * 1024 * 1024, audio: 15 * 1024 * 1024, video: 50 * 1024 * 1024 };
export const MEDIA_MAX_SIZE = Math.max(...Object.values(MEDIA_LIMITS));
export const MEDIA_QUOTA = 500 * 1024 * 1024;

export type Sniffed = { kind: MediaKind; mime: string; ext: string };

/** Расширение → MIME для отдачи файлов. Только то, что принимает sniffMedia. */
export const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString("latin1");
const startsWith = (b: Buffer, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);

/**
 * Тип файла по сигнатуре (первые байты), а не по имени или заголовку клиента.
 * SVG, HTML и всё остальное не распознаётся и отклоняется.
 */
export function sniffMedia(head: Buffer): Sniffed | null {
  const img = (mime: string, ext: string): Sniffed => ({ kind: "image", mime, ext });
  if (startsWith(head, [0xff, 0xd8, 0xff])) return img("image/jpeg", "jpg");
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return img("image/png", "png");
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return img("image/gif", "gif");
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return img("image/webp", "webp");
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return { kind: "audio", mime: "audio/wav", ext: "wav" };
  if (ascii(head, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  // MP3: тег ID3 или сразу кадр MPEG (11 единичных бит синхронизации, layer III).
  if (ascii(head, 0, 3) === "ID3") return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  if (head[0] === 0xff && head[1] !== undefined && (head[1] & 0xe6) === 0xe2) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  // ISO BMFF (mp4, m4a, mov): «ftyp» на 4-м байте, дальше марка файла.
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
    if (/^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|f4v )$/.test(brand)) return { kind: "video", mime: "video/mp4", ext: "mp4" };
    return null;
  }
  // WebM: контейнер EBML с типом документа «webm».
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) && head.includes("webm", 0, "latin1")) return { kind: "video", mime: "video/webm", ext: "webm" };
  return null;
}

export const mediaDir = (ctx: Pick<Ctx, "config">) => resolve(ctx.config.MEDIA_DIR);
export const mediaUrl = (m: Pick<Media, "id" | "ext">) => `/media/${m.id}.${m.ext}`;

export type MediaDto = { id: string; url: string; kind: MediaKind; mime: string; size: number };
export const toMediaDto = (m: Media): MediaDto => ({ id: m.id, url: mediaUrl(m), kind: m.kind, mime: m.mime, size: m.size });

async function checkQuota(ctx: Pick<Ctx, "db">, user: Pick<User, "id" | "isAdmin" | "freeAccess">, size: number) {
  if (user.isAdmin || user.freeAccess) return;
  const [row] = await ctx.db.select({ used: sum(media.size) }).from(media).where(eq(media.userId, user.id));
  if (Number(row?.used ?? 0) + size > MEDIA_QUOTA) throw new HttpError(413, "Закончилось место для файлов");
}

/** Сохраняет загружаемый файл: поток пишется во временный файл, затем проверяются тип, размер и квота. */
export async function saveUpload(ctx: Pick<Ctx, "db" | "config">, user: Pick<User, "id" | "isAdmin" | "freeAccess">, file: Readable & { truncated?: boolean }) {
  const dir = mediaDir(ctx);
  await mkdir(dir, { recursive: true });
  const tmp = resolve(dir, `.upload-${randomUUID()}`);
  try {
    try {
      await pipeline(file, createWriteStream(tmp, { flags: "wx" }));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 413) throw new HttpError(413, "Файл слишком большой");
      throw err;
    }
    if (file.truncated) throw new HttpError(413, "Файл слишком большой");

    const head = Buffer.alloc(64);
    const fh = await open(tmp, "r");
    let size: number;
    try {
      size = (await fh.stat()).size;
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
    const type = size > 0 ? sniffMedia(head) : null;
    if (!type) throw new HttpError(415, "Этот тип файла не поддерживается");
    if (size > MEDIA_LIMITS[type.kind]) throw new HttpError(413, "Файл слишком большой");
    await checkQuota(ctx, user, size);

    const id = randomUUID();
    await rename(tmp, resolve(dir, `${id}.${type.ext}`));
    const [row] = await ctx.db.insert(media).values({ id, userId: user.id, kind: type.kind, mime: type.mime, ext: type.ext, size }).returning();
    return row!;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Сохраняет готовый буфер (например, OG-картинку), тип уже проверен по сигнатуре. */
export async function saveBuffer(ctx: Pick<Ctx, "db" | "config">, user: Pick<User, "id" | "isAdmin" | "freeAccess">, buf: Buffer, type: Sniffed) {
  await checkQuota(ctx, user, buf.length);
  const dir = mediaDir(ctx);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  await writeFile(resolve(dir, `${id}.${type.ext}`), buf, { flag: "wx" });
  const [row] = await ctx.db.insert(media).values({ id, userId: user.id, kind: type.kind, mime: type.mime, ext: type.ext, size: buf.length }).returning();
  return row!;
}

/** Удаляет файл пользователя по адресу /media/<id>.<ext>. Чужие и внешние адреса пропускаются. */
export async function deleteOwnMedia(ctx: Pick<Ctx, "db" | "config" | "log">, userId: string, url: string | null) {
  const m = url?.match(/^\/media\/([0-9a-f-]{36})\.([a-z0-9]+)$/);
  if (!m) return;
  const [row] = await ctx.db
    .delete(media)
    .where(and(eq(media.id, m[1]!), eq(media.userId, userId)))
    .returning();
  if (!row) return;
  await unlink(resolve(mediaDir(ctx), `${row.id}.${row.ext}`)).catch((err) => ctx.log.warn({ err, id: row.id }, "не удалось удалить файл"));
}
