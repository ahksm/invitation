import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations, media } from "../src/db/schema.js";
import { MEDIA_LIMITS, MEDIA_QUOTA, UNUSED_MEDIA_TTL_MS, deleteUnusedMedia } from "../src/services/media.js";
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

  it("удалённый черновик удаляется вместе со своими файлами; файлы копии остаются", async () => {
    const { cookie } = await user();
    const { url: cover } = (await upload(cookie, samples.jpeg, { filename: "c.jpg" })).json();
    const { url: photo } = (await upload(cookie, samples.png)).json();
    const { url: song } = (await upload(cookie, samples.mp3, { filename: "a.mp3" })).json();
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover, gallery: [photo], musicSrc: song, music: "custom" } })).json();
    // Копия ссылается на ту же обложку.
    const copy = (await req(cookie, "POST", `/api/invitations/${inv.id}/duplicate`)).json();
    expect(copy.data.cover).toBe(cover);
    await req(cookie, "PATCH", `/api/invitations/${copy.id}`, { data: { gallery: [], musicSrc: "" } });
    const file = (url: string) => t.app.inject({ url });
    for (const u of [cover, photo, song]) expect((await file(u)).statusCode, u).toBe(200);

    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    expect((await file(photo)).statusCode).toBe(404);
    expect((await file(song)).statusCode).toBe(404);
    expect((await file(cover)).statusCode).toBe(200);
    const idOf = (u: string) => u.slice("/media/".length).split(".")[0]!;
    expect(await db.select().from(media).where(eq(media.id, idOf(photo)))).toEqual([]);
    expect(stored().some((f) => f.startsWith(idOf(photo)))).toBe(false);
  });

  it("заменённые и убранные файлы удаляются при сохранении, поэтому удалённый черновик не оставляет прежних файлов", async () => {
    const { cookie } = await user();
    const up = async (buf: Buffer, filename: string) => (await upload(cookie, buf, { filename })).json().url as string;
    const [a, b, p1, p2, p3, song, clip] = [
      await up(samples.jpeg, "a.jpg"),
      await up(samples.jpeg, "b.jpg"),
      await up(samples.png, "p1.png"),
      await up(samples.png, "p2.png"),
      await up(samples.png, "p3.png"),
      await up(samples.mp3, "a.mp3"),
      await up(samples.mp4, "a.mp4"),
    ];
    const file = async (url: string) => (await t.app.inject({ url })).statusCode;
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover: a, gallery: [p1, p2, p3], musicSrc: song, music: "custom", video: clip } })).json();
    // Копия ссылается на p3: из исходного приглашения его можно убрать, файл копии остаётся.
    const copy = (await req(cookie, "POST", `/api/invitations/${inv.id}/duplicate`)).json();
    expect((await req(cookie, "PATCH", `/api/invitations/${copy.id}`, { data: { cover: "", gallery: [p3], musicSrc: "", video: "" } })).statusCode).toBe(200);
    for (const u of [a, p1, p2, p3, song, clip]) expect(await file(u), u).toBe(200);

    // Обложку заменили, обложка ушла в галерею, одно фото убрали, видео стёрли (null удаляет ключ).
    const res = await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { cover: b, gallery: [p2, a], video: null } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await file(p1)).toBe(404);
    expect(await file(clip)).toBe(404);
    for (const u of [a, b, p2, p3, song]) expect(await file(u), u).toBe(200);
    const idOf = (u: string) => u.slice("/media/".length).split(".")[0]!;
    expect(await db.select().from(media).where(inArray(media.id, [idOf(p1), idOf(clip)]))).toEqual([]);
    expect(stored().some((f) => f.startsWith(idOf(p1)) || f.startsWith(idOf(clip)))).toBe(false);

    // Шаблон и язык без data файлов не трогают.
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { template: "wedding-luxe", language: "uz" })).statusCode).toBe(200);
    for (const u of [a, b, p2, song]) expect(await file(u), u).toBe(200);

    // Удаление черновика: из его файлов не остаётся ничего, кроме того, что есть в копии.
    expect((await req(cookie, "DELETE", `/api/invitations/${inv.id}`)).statusCode).toBe(204);
    for (const u of [a, b, p1, p2, song, clip]) expect(await file(u), u).toBe(404);
    expect(await file(p3)).toBe(200);
  });

  it("файл, удалённый сохранением из другой вкладки, выпадает из правки, а остальная правка сохраняется; чужой файл — 400", async () => {
    const { cookie } = await user();
    const up = async (buf: Buffer, filename: string) => (await upload(cookie, buf, { filename })).json().url as string;
    const [a, b, p1, p2, p3, clip] = [
      await up(samples.jpeg, "a.jpg"),
      await up(samples.jpeg, "b.jpg"),
      await up(samples.png, "p1.png"),
      await up(samples.png, "p2.png"),
      await up(samples.png, "p3.png"),
      await up(samples.mp4, "a.mp4"),
    ];
    const file = async (url: string) => (await t.app.inject({ url })).statusCode;
    const inv = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { names: "Две вкладки", cover: a, gallery: [p1, p2, p3], video: clip } })).json();
    const patch = (data: Record<string, unknown>) => req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data });

    // Первая вкладка убирает p1 и стирает видео: файлы удаляются.
    expect((await patch({ gallery: [p2, p3], video: "" })).statusCode).toBe(200);
    expect(await file(p1)).toBe(404);
    expect(await file(clip)).toBe(404);
    // Вторая вкладка ещё показывает p1 и убирает p3, а заодно меняет имена: p1 выпадает, остальное сохраняется.
    const stale = await patch({ gallery: [p1, p2], names: "Из второй вкладки" });
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().data).toMatchObject({ names: "Из второй вкладки", gallery: [p2], cover: a });
    expect(await file(p3)).toBe(404);
    expect(await file(p2)).toBe(200);
    // Обложка и видео с адресом удалённого файла становятся пустыми, правка рядом сохраняется.
    const scalar = await patch({ video: clip, host: "Хозяева" });
    expect(scalar.statusCode, scalar.body).toBe(200);
    expect(scalar.json().data).toMatchObject({ video: "", host: "Хозяева", cover: a });
    const [row] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.data).toMatchObject({ names: "Из второй вкладки", host: "Хозяева", gallery: [p2], video: "", cover: a });

    // Новый черновик из содержимого вкладки, где черновик с этими файлами уже удалили: удалённые файлы не попадают.
    const created = await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover: p1, gallery: [p3, b] } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({ cover: "", gallery: [b] });

    // Файл другого пользователя по-прежнему отклоняется вместе со всей правкой.
    const other = await user();
    const { url: foreign } = (await upload(other.cookie, samples.png)).json();
    const bad = await patch({ gallery: [p2, foreign], names: "Чужое" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("Файл должен быть загружен через /api/media");
    expect((await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { gallery: [foreign] } })).statusCode).toBe(400);
    // Свой файл с чужим расширением — тоже не загруженный адрес.
    expect((await patch({ cover: b.replace(/\.jpg$/, ".png") })).statusCode).toBe(400);
    const [after] = await db.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(after!.data).toMatchObject({ names: "Из второй вкладки", gallery: [p2], cover: a });
    expect(await file(foreign)).toBe(200);
  });
});

describe("файлы, которых нет ни в одном приглашении", () => {
  it("удаляются через сутки после загрузки; файлы приглашений, архивных и превью ссылки остаются", async () => {
    const { cookie, user: u } = await user();
    const up = async () => (await upload(cookie, samples.png)).json().url as string;
    const [unused, cover, archived, og, fresh] = [await up(), await up(), await up(), await up(), await up()];
    await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { cover } });
    const old = (await req(cookie, "POST", "/api/invitations", { template: "wedding-classic", data: { gallery: [archived] } })).json();
    await db.update(invitations).set({ status: "archived", ogImageUrl: og }).where(eq(invitations.id, old.id));
    // Чужое приглашение с тем же адресом не держит файл: проверяются только приглашения владельца.
    const other = await user();
    const [foreign] = await db.select().from(invitations).where(eq(invitations.userId, u.id)).limit(1);
    await db.insert(invitations).values({ userId: other.user.id, templateId: foreign!.templateId, slug: `foreign-${other.user.id.slice(0, 8)}`, mode: "shared", title: "x", data: { cover: unused } });

    const idOf = (url: string) => url.slice("/media/".length).split(".")[0]!;
    const aged = new Date(Date.now() - UNUSED_MEDIA_TTL_MS - 60_000);
    await db.update(media).set({ createdAt: aged }).where(inArray(media.id, [unused, cover, archived, og].map(idOf)));

    expect(await deleteUnusedMedia(t.app.ctx)).toBeGreaterThanOrEqual(1);
    const file = async (url: string) => (await t.app.inject({ url })).statusCode;
    expect(await file(unused)).toBe(404);
    expect(await db.select().from(media).where(eq(media.id, idOf(unused)))).toEqual([]);
    expect(stored().some((f) => f.startsWith(idOf(unused)))).toBe(false);
    for (const url of [cover, archived, og, fresh]) expect(await file(url), url).toBe(200);
    // Повторный запуск ничего не меняет.
    expect(await deleteUnusedMedia(t.app.ctx)).toBe(0);
    for (const url of [cover, archived, og, fresh]) expect(await file(url), url).toBe(200);
  });
});
