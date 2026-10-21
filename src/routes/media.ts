import multipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { MEDIA_MAX_SIZE, MEDIA_TYPES, mediaDir, saveUpload, toMediaDto } from "../services/media.js";

const UPLOADS_PER_MINUTE = 30;
const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{2,4})$/;

/** Один диапазон из заголовка Range. null: отдать файл целиком; "invalid": 416. Несколько диапазонов не поддерживаются. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(",") ? null : "invalid";
  const [, from = "", to = ""] = m;
  if (!from && !to) return "invalid";
  if (!from) {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to ? Math.min(Number(to), size - 1) : size - 1;
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/**
 * Загруженные файлы: POST /api/media (multipart, поле file) и отдача GET /media/<id>.<ext>
 * из MEDIA_DIR. Файлы неизменяемы (новая загрузка — новый id), поэтому кэшируются навсегда.
 */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const dir = mediaDir(ctx);
  await mkdir(dir, { recursive: true });
  await app.register(multipart, { limits: { fileSize: MEDIA_MAX_SIZE, files: 1, fields: 10, fieldSize: 1024, parts: 20, headerPairs: 100 } });

  app.post("/api/media", { onRequest: app.authenticate }, async (req, reply) => {
    if (await ctx.cache.hit(`media:${req.user.id}`, UPLOADS_PER_MINUTE, 60)) throw new HttpError(429, "Слишком много загрузок, попробуйте через минуту");
    if (!req.isMultipart()) throw new HttpError(400, "Прикрепите файл в поле file");
    const part = await req.file();
    if (!part || part.fieldname !== "file") {
      part?.file.resume();
      throw new HttpError(400, "Прикрепите файл в поле file");
    }
    const file = await saveUpload(ctx, req.user, part.file);
    return reply.code(201).send(toMediaDto(file));
  });

  app.get("/media/:file", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const m = FILE_RE.exec(z.object({ file: z.string() }).parse(req.params).file);
    const type = m ? MEDIA_TYPES[m[2]!] : undefined;
    if (!m || !type) return reply.code(404).send({ error: "Файл не найден" });
    const path = resolve(dir, `${m[1]}.${m[2]}`);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return reply.code(404).send({ error: "Файл не найден" });

    reply
      .header("content-type", type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "bytes");
    const range = parseRange(req.headers.range, st.size);
    if (range === "invalid") return reply.code(416).header("content-range", `bytes */${st.size}`).send();
    if (range) {
      reply
        .code(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${st.size}`)
        .header("content-length", range.end - range.start + 1);
      return reply.send(createReadStream(path, { start: range.start, end: range.end }));
    }
    reply.header("content-length", st.size);
    return reply.send(createReadStream(path));
  });
};
