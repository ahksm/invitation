import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { media } from "../src/db/schema.js";
import { MEDIA_LIMITS, MEDIA_QUOTA } from "../src/services/media.js";
import { multipart, samples, testContext } from "./helpers.js";

const t = testContext();
const { db, redis, login, req } = t;

let nextUser = 30_000;
const user = (extra: Parameters<typeof login>[1] = {}) => login(nextUser++, extra);

function upload(cookie: string | null, content: Buffer, opts: { field?: string; filename?: string; mime?: string } = {}) {
  const form = multipart(opts.field ?? "file", opts.filename ?? "photo.png", opts.mime ?? "image/png", content);
  return req(cookie, "POST", "/api/media", form.payload, form.headers);
}

/** Файлы в MEDIA_DIR без временных. */
const stored = () => readdirSync(t.mediaDir).filter((f) => !f.startsWith("."));
const leftovers = () => readdirSync(t.mediaDir).filter((f) => f.startsWith(".upload-"));

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

describe("загрузка файлов", () => {
  it("принимает картинку и отдаёт её с неизменяемым кэшем", async () => {
    const { cookie, user: u } = await user();
    const res = await upload(cookie, samples.png);
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json();
    expect(dto).toEqual({ id: expect.any(String), url: `/media/${dto.id}.png`, kind: "image", mime: "image/png", size: samples.png.length });
    expect(readFileSync(join(t.mediaDir, `${dto.id}.png`))).toEqual(samples.png);
    const [row] = await db.select().from(media).where(eq(media.id, dto.id));
    expect(row).toMatchObject({ userId: u.id, kind: "image", ext: "png", size: samples.png.length });

    const file = await t.app.inject({ url: dto.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload).toEqual(samples.png);
    expect(file.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(samples.png.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
    });
  });

  it("определяет тип по содержимому, а не по имени и заголовку", async () => {
    const { cookie } = await user();
    const cases: [keyof typeof samples, string, string, string][] = [
      ["jpeg", "image", "image/jpeg", "jpg"],
      ["gif", "image", "image/gif", "gif"],
      ["webp", "image", "image/webp", "webp"],
      ["mp3", "audio", "audio/mpeg", "mp3"],
      ["m4a", "audio", "audio/mp4", "m4a"],
      ["ogg", "audio", "audio/ogg", "ogg"],
      ["wav", "audio", "audio/wav", "wav"],
      ["mp4", "video", "video/mp4", "mp4"],
      ["mov", "video", "video/quicktime", "mov"],
      ["webm", "video", "video/webm", "webm"],
    ];
    for (const [sample, kind, mime, ext] of cases) {
      // Имя и тип от клиента нарочно неверные.
      const res = await upload(cookie, samples[sample], { filename: "file.txt", mime: "text/plain" });
      expect(res.statusCode, `${sample}: ${res.body}`).toBe(201);
      expect(res.json()).toMatchObject({ kind, mime, url: expect.stringMatching(new RegExp(`\\.${ext}$`)) });
      const served = await t.app.inject({ url: res.json().url });
      expect(served.headers["content-type"]).toBe(mime);
    }
  });

  it("отклоняет SVG, HTML и пустые файлы, не оставляя временных файлов", async () => {
    const { cookie } = await user();
    const before = stored().length;
    for (const [content, name] of [
      [samples.svg, "image.png"],
      [samples.html, "page.jpg"],
      [Buffer.alloc(0), "empty.png"],
      [Buffer.from("just text"), "note.mp3"],
    ] as const) {
      const res = await upload(cookie, content, { filename: name, mime: "image/png" });
      expect(res.statusCode, name).toBe(415);
      expect(res.json()).toEqual({ error: "Этот тип файла не поддерживается" });
    }
    expect((await upload(cookie, samples.svg, { mime: "image/svg+xml" })).json()).toEqual({ error: "Этот тип файла не поддерживается" });
    const form = multipart("file", "a.svg", "image/svg+xml", samples.svg);
    const en = await req(cookie, "POST", "/api/media", form.payload, { ...form.headers, "accept-language": "en" });
    expect(en.statusCode).toBe(415);
    expect(en.json()).toEqual({ error: "This file type is not supported" });
    expect(stored()).toHaveLength(before);
    expect(leftovers()).toEqual([]);
  });

  it("требует вход и файл в поле file", async () => {
    const { cookie } = await user();
    const anon = await upload(null, samples.png);
    expect(anon.statusCode).toBe(401);

    const wrongField = await upload(cookie, samples.png, { field: "image" });
    expect(wrongField.statusCode).toBe(400);
    expect(wrongField.json()).toEqual({ error: "Прикрепите файл в поле file" });

    const json = await req(cookie, "POST", "/api/media", { file: "data:image/png;base64,AAAA" });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toEqual({ error: "Прикрепите файл в поле file" });

    const form = multipart("file", "a.png", "image/png", samples.png);
    const foreign = await req(cookie, "POST", "/api/media", form.payload, { ...form.headers, origin: "https://evil.example" });
    expect(foreign.statusCode).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("лимиты размера по типу файла", async () => {
    const { cookie } = await user();
    const pad = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

    const bigImage = await upload(cookie, pad(samples.png, MEDIA_LIMITS.image + 1));
    expect(bigImage.statusCode).toBe(413);
    expect(bigImage.json()).toEqual({ error: "Файл слишком большой" });

    // Аудио того же размера помещается в свой лимит.
    const audio = await upload(cookie, pad(samples.mp3, MEDIA_LIMITS.image + 1), { filename: "song.mp3", mime: "audio/mpeg" });
    expect(audio.statusCode).toBe(201);
    expect(audio.json()).toMatchObject({ kind: "audio", size: MEDIA_LIMITS.image + 1 });

    // Больше самого большого лимита: загрузка обрывается на лимите.
    const huge = await upload(cookie, pad(samples.mp4, MEDIA_LIMITS.video + 1), { filename: "clip.mp4", mime: "video/mp4" });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toEqual({ error: "Файл слишком большой" });
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it("квота на пользователя, без квоты у админа и бесплатного доступа", async () => {
    const fill = async (userId: string) =>
      db.insert(media).values({ userId, kind: "video", mime: "video/mp4", ext: "mp4", size: MEDIA_QUOTA - 10 });

    const { cookie, user: u } = await user();
    await fill(u.id);
    const res = await upload(cookie, samples.png);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "Закончилось место для файлов" });
    // Ровно до квоты можно, сверх неё — нет.
    const tiny = samples.png.subarray(0, 10);
    expect((await upload(cookie, tiny)).statusCode).toBe(201);
    expect((await upload(cookie, tiny)).statusCode).toBe(413);
    expect(leftovers()).toEqual([]);

    const admin = await login(1);
    await fill(admin.user.id);
    expect((await upload(admin.cookie, samples.png)).statusCode).toBe(201);

    const free = await user({ freeAccess: true });
    await fill(free.user.id);
    expect((await upload(free.cookie, samples.png)).statusCode).toBe(201);
  });

  it("не больше 30 загрузок в минуту", async () => {
    const { cookie } = await user();
    for (let i = 0; i < 30; i++) expect((await upload(cookie, samples.png)).statusCode).toBe(201);
    const res = await upload(cookie, samples.png);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "Слишком много загрузок, попробуйте через минуту" });
    // Лимит у каждого пользователя свой.
    const other = await user();
    expect((await upload(other.cookie, samples.png)).statusCode).toBe(201);
  });
});

describe("отдача файлов", () => {
  it("поддерживает Range", async () => {
    const { cookie } = await user();
    const { url } = (await upload(cookie, samples.mp3, { filename: "a.mp3" })).json();
    const size = samples.mp3.length;
    const range = (h: string) => t.app.inject({ url, headers: { range: h } });

    const head = await range("bytes=0-9");
    expect(head.statusCode).toBe(206);
    expect(head.headers["content-range"]).toBe(`bytes 0-9/${size}`);
    expect(head.headers["content-length"]).toBe("10");
    expect(head.rawPayload).toEqual(samples.mp3.subarray(0, 10));

    const tail = await range("bytes=-5");
    expect(tail.statusCode).toBe(206);
    expect(tail.headers["content-range"]).toBe(`bytes ${size - 5}-${size - 1}/${size}`);
    expect(tail.rawPayload).toEqual(samples.mp3.subarray(size - 5));

    const open = await range("bytes=60-");
    expect(open.statusCode).toBe(206);
    expect(open.rawPayload).toEqual(samples.mp3.subarray(60));

    const past = await range(`bytes=${size}-${size + 10}`);
    expect(past.statusCode).toBe(416);
    expect(past.headers["content-range"]).toBe(`bytes */${size}`);
    expect((await range("items=0-1")).statusCode).toBe(416);

    // Несколько диапазонов не поддерживаются: файл целиком.
    const multi = await range("bytes=0-1,4-5");
    expect(multi.statusCode).toBe(200);
    expect(multi.rawPayload).toEqual(samples.mp3);
  });

  it("неизвестные, чужие по формату и служебные имена дают 404", async () => {
    const { cookie } = await user();
    const { id } = (await upload(cookie, samples.png)).json();
    const paths = [
      `/media/${id}.jpg`,
      `/media/${id}.svg`,
      `/media/${id}`,
      "/media/00000000-0000-0000-0000-000000000000.png",
      "/media/..%2F..%2Fetc%2Fpasswd",
      "/media/%2e%2e%2fpackage.json",
      "/media/.upload-00000000-0000-0000-0000-000000000000",
      `/media/${id.toUpperCase()}.png`,
    ];
    for (const url of paths) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
    }
    expect((await t.app.inject({ url: "/media/../package.json" })).statusCode).toBe(404);
  });
});

describe("файлы в содержимом приглашения", () => {
  it("принимаются только свои загрузки и картинки Unsplash", async () => {
    const { cookie } = await user();
    const { url: photo } = (await upload(cookie, samples.jpeg, { filename: "a.jpg" })).json();
    const { url: song } = (await upload(cookie, samples.mp3, { filename: "a.mp3" })).json();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic" })).json();
    const patch = (data: Record<string, unknown>) => req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data });

    const ok = await patch({ cover: photo, gallery: [photo, "https://images.unsplash.com/photo-1?w=800&q=80"], musicSrc: song, music: "custom" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ cover: photo, musicSrc: song, gallery: [photo, "https://images.unsplash.com/photo-1?w=800&q=80"] });
    expect((await patch({ cover: "" })).statusCode).toBe(200);

    for (const bad of [
      "data:image/png;base64,iVBORw0KGgo=",
      "https://evil.example/x.png",
      "javascript:alert(1)",
      "/media/00000000-0000-0000-0000-000000000000.svg",
      `${photo}?x=1`,
      "https://images.unsplash.com/photo-1\");background:url(https://evil.example",
      `https://images.unsplash.com/${"a".repeat(500)}`,
    ]) {
      expect((await patch({ cover: bad })).statusCode, bad).toBe(400);
    }
    expect((await patch({ gallery: Array(13).fill(photo) })).statusCode).toBe(400);
  });
});
