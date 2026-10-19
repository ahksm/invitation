import compress from "@fastify/compress";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.js";
import { appHelmet } from "./csp.js";
import { assetUrl, createDesignStore, type Asset, type Design } from "./design.js";

/** Загрузочные данные страницы: логика Invito читает их из #invito-boot. */
export type Boot =
  | { mode: "app" }
  | { mode: "shared"; slug: string; view?: unknown; locked?: unknown }
  | { mode: "personal"; token: string; view?: unknown }
  | { mode: "notfound" };

/** OG-теги и заголовок. image и url — абсолютные адреса. */
export type ShellMeta = { title: string; description?: string; image?: string; url?: string };

export type ShellOptions = { boot: Boot; meta?: ShellMeta; status?: number; lang?: string };

const DEFAULT_META: ShellMeta = {
  title: "Invito",
  description: "Выберите событие и шаблон, добавьте текст, маршрут и фото. Получите ссылку с красивым превью для любого чата.",
};

const HTML_LANG: Record<string, string> = { ru: "ru", uz: "uz-Latn", uzc: "uz-Cyrl", en: "en" };

// Ошибки рантайма (красная плашка, текст в заглушке) пользователю не показываются, они пишутся в консоль.
// Фон как у дизайна, чтобы до первого кадра не мелькал белый экран.
const SHELL_CSS =
  "body{margin:0;background:#f3efe6}" +
  ".sc-logic-error,.sc-placeholder-error{display:none!important}" +
  ".sc-placeholder{background:none!important;border-color:transparent!important}";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/**
 * Оболочка приложения: одна страница для /, /app, /i/:slug и /g/:token, отличаются только
 * загрузочные данные и OG-теги. status используется маршрутом (sendShell), в разметку не попадает.
 */
export function renderShell(design: Design, opts: ShellOptions): string {
  const meta = opts.meta ?? DEFAULT_META;
  const script = (path: string) => `<script src="${esc(assetUrl(design, path))}"></script>`;
  // В JSON внутри <script> нельзя оставлять «<»: «</script>» в данных закрыл бы тег.
  const boot = JSON.stringify(opts.boot).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    `<html lang="${esc(HTML_LANG[opts.lang ?? "ru"] ?? "ru")}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${esc(meta.title)}</title>`,
    meta.description && `<meta name="description" content="${esc(meta.description)}">`,
    '<meta property="og:type" content="website">',
    meta.url && `<meta property="og:url" content="${esc(meta.url)}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    meta.description && `<meta property="og:description" content="${esc(meta.description)}">`,
    meta.image && `<meta property="og:image" content="${esc(meta.image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<style>${SHELL_CSS}</style>`,
    design.fontsHref && '<link rel="preconnect" href="https://fonts.googleapis.com">',
    design.fontsHref && '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    design.fontsHref && `<link rel="stylesheet" href="${esc(design.fontsHref)}">`,
    // Модули, которые логика загрузит после старта, запрашиваются сразу.
    ...design.preload.map((p) => `<link rel="modulepreload" href="${esc(p)}">`),
    `<script type="application/json" id="invito-boot">${boot}</script>`,
    // Telegram до рантайма: логика проверяет window.Telegram при запуске.
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>',
    script("/app/vendor/react.production.min.js"),
    script("/app/vendor/react-dom.production.min.js"),
    script("/app/vendor/qrcode.js"),
    script("/app/dc-bundle.js"),
    script("/app/support.js"),
    "</head>",
    "<body>",
    // Точка монтирования: support.js заменяет её на #dc-root.
    "<x-dc></x-dc>",
    "</body>",
    "</html>\n",
  ]
    .filter((line) => line)
    .join("\n");
}

export function sendShell(reply: FastifyReply, design: Design, opts: ShellOptions) {
  return reply
    .code(opts.status ?? 200)
    .type("text/html; charset=utf-8")
    .header("cache-control", "private, no-cache")
    .send(renderShell(design, opts));
}

/**
 * ТОЧКА ПОДКЛЮЧЕНИЯ публичных страниц. Пока в загрузочные данные попадают только slug и token.
 * Следующий шаг: вызвать здесь getPublicPage(ctx, { kind, key, code }) и вернуть его результат:
 * boot с view (или locked для пароля), meta для OG-тегов, lang приглашения и status
 * (404 с { mode: "notfound" } для неизвестного приглашения). Маршруты ниже менять не нужно.
 */
async function publicPage(_ctx: Ctx, kind: "shared" | "personal", key: string, _code: string | undefined): Promise<ShellOptions> {
  return { boot: kind === "shared" ? { mode: "shared", slug: key } : { mode: "personal", token: key } };
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Слабый ETag: тело может уйти сжатым, а сравнение If-None-Match всё равно слабое. */
const etagOf = (a: Asset) => `W/"${a.hash}"`;

function sendAsset(req: FastifyRequest<{ Querystring: { v?: string } }>, reply: FastifyReply, a: Asset) {
  const etag = etagOf(a);
  // Навсегда кэшируется только адрес с хэшем текущей версии. Старый ?v= после выкладки получает
  // новое содержимое без долгого кэша; модули без ?v= (их грузит логика) сверяются по ETag.
  reply
    .type(a.type)
    .header("etag", etag)
    .header("cache-control", req.query.v === a.hash ? IMMUTABLE : "no-cache");
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.slice(2))) return reply.code(304).send();
  return reply.send(a.body);
}

/** Фронтенд: оболочка и файлы рантайма. Регистрируется без префикса. */
export async function webRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const store = createDesignStore({ watch: ctx.config.NODE_ENV === "development" });
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");

  // Сжатие только для маршрутов этого плагина (оболочка и JS), тела запросов не распаковываются.
  await app.register(compress, { global: true, globalDecompression: false, encodings: ["br", "gzip"] });

  // Файлы под /app/ не ограничиваются по частоте: они из памяти и кэшируются, а гости одного
  // приглашения часто приходят с одного IP оператора.
  const assetRoute = { helmet: appHelmet, config: { rateLimit: false as const } };
  for (const path of store.get().assets.keys()) {
    app.get<{ Querystring: { v?: string } }>(path, assetRoute, (req, reply) => {
      const a = store.get().assets.get(path);
      return a ? sendAsset(req, reply, a) : reply.callNotFound();
    });
  }

  const pageRoute = { helmet: appHelmet };
  const appPage = (_req: FastifyRequest, reply: FastifyReply) =>
    sendShell(reply, store.get(), { boot: { mode: "app" }, meta: { ...DEFAULT_META, url: `${appUrl}/app/` } });
  app.get("/", pageRoute, appPage);
  app.get("/app", pageRoute, appPage);
  app.get("/app/*", pageRoute, (req, reply) => {
    // Похожее на файл (расширение в последнем сегменте) — 404, а не страница: иначе браузер
    // получил бы HTML вместо скрипта или карты исходников.
    const last = (req.params as { "*": string })["*"].split("/").pop() ?? "";
    if (last.includes(".")) return reply.callNotFound();
    return appPage(req, reply);
  });

  app.get<{ Params: { slug: string }; Querystring: { code?: string } }>("/i/:slug", pageRoute, async (req, reply) =>
    sendShell(reply, store.get(), await publicPage(ctx, "shared", req.params.slug, req.query.code)),
  );
  app.get<{ Params: { token: string } }>("/g/:token", pageRoute, async (req, reply) =>
    sendShell(reply, store.get(), await publicPage(ctx, "personal", req.params.token, undefined)),
  );
}
