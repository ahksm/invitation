import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_URL, samples, testContext } from "./helpers.js";

/**
 * Проверка этапа 4 после объединения: превью ссылки (og:image) не переживает правку того, что на нём
 * нарисовано, — иначе гости видели бы, например, стёртую дату.
 */
const t = testContext();
const { login, req } = t;
const template = "wedding-classic";

beforeAll(async () => {
  await t.start();
});

beforeEach(async () => {
  await t.redis.flushdb();
});

afterAll(async () => {
  await t.close();
});

async function create(cookie: string, body: Record<string, unknown>) {
  const res = await req(cookie, "POST", "/api/invitations", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; slug: string };
}

const putOg = async (cookie: string, id: string) => {
  const res = await req(cookie, "PUT", `/api/invitations/${id}/og`, samples.png, { "content-type": "image/png" });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().ogImageUrl as string;
};
const fileStatus = async (url: string) => (await t.app.inject({ method: "GET", url })).statusCode;
const ogImageOf = async (slug: string) => {
  const html = (await t.app.inject({ method: "GET", url: `/i/${slug}`, headers: { accept: "text/html" } })).body;
  return /<meta property="og:image" content="([^"]*)">/.exec(html)?.[1] ?? null;
};

describe("превью ссылки после правки приглашения", () => {
  it("правка нарисованного на превью сбрасывает ogImageUrl и удаляет картинку; прочие правки её не трогают", async () => {
    const { cookie } = await login(95_001);
    const inv = await create(cookie, { template, data: { names: "Аня и Боря", date: "2031-06-01", time: "18:00" } });
    const patch = (body: Record<string, unknown>) => req(cookie, "PATCH", `/api/invitations/${inv.id}`, body);

    // Текст, настройки и тот же язык на превью не нарисованы: картинка остаётся.
    let og = await putOg(cookie, inv.id);
    const same = await patch({ data: { message: "Ждём вас" }, language: "ru", settings: { notify: false } });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().ogImageUrl).toBe(og);
    expect(await fileStatus(og)).toBe(200);

    const cases: Record<string, unknown>[] = [
      { data: { date: "" } },
      { data: { time: null } },
      { data: { names: "Аня и Тимур" } },
      { data: { palette: 2 } },
      { data: { font: "Inter" } },
      { language: "en" },
      { slug: "anya-i-timur-2031" },
      { template: "party-neon" },
    ];
    for (const body of cases) {
      og = await putOg(cookie, inv.id);
      const res = await patch(body);
      expect(res.statusCode, `${JSON.stringify(body)}: ${res.body}`).toBe(200);
      expect(res.json().ogImageUrl, JSON.stringify(body)).toBeNull();
      expect(await fileStatus(og), JSON.stringify(body)).toBe(404);
    }
  });

  it("опубликованное: og:image страницы после стирания даты — обложка, а не прежнее превью", async () => {
    const { cookie } = await login(95_002);
    const cover = "https://images.unsplash.com/photo-1?w=1";
    const inv = await create(cookie, { template, data: { names: "Лола", date: "2031-06-01", cover } });
    await t.pay(cookie, { kind: "template", invitationId: inv.id });
    const pub = await req(cookie, "POST", `/api/invitations/${inv.id}/publish`, {});
    expect(pub.statusCode, pub.body).toBe(200);
    const og = await putOg(cookie, inv.id);
    expect(await ogImageOf(inv.slug)).toBe(`${APP_URL}${og}`);
    expect((await req(cookie, "PATCH", `/api/invitations/${inv.id}`, { data: { date: "" } })).statusCode).toBe(200);
    expect(await ogImageOf(inv.slug)).toBe(cover);
    // Новое превью с экрана «Поделиться» снова становится og:image.
    const next = await putOg(cookie, inv.id);
    expect(await ogImageOf(inv.slug)).toBe(`${APP_URL}${next}`);
  });
});
