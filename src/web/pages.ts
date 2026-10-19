import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appCsp, appHelmet } from "./csp.js";
import { assetUrl, createDesignStore, type Asset, type Design, type Encoding } from "./design.js";

/** Загрузочные данные страницы: логика Invito читает их из #invito-boot. */
export type Boot =
  | { mode: "app" }
  | { mode: "shared"; slug: string; view?: unknown; locked?: { look: unknown; limited?: boolean } }
  | { mode: "personal"; token: string; view?: unknown }
  | { mode: "notfound" };

/** OG-теги и заголовок. image и url — абсолютные адреса. */
export type ShellMeta = { title: string; description?: string; image?: string; url?: string };

export type ShellOptions = { boot: Boot; meta?: ShellMeta; status?: number; lang?: string };

/** Мета-теги публичной страницы от бэкенда: image — абсолютный адрес или null, пустое description не выводится. */
export type PageMeta = { title: string; description: string; image: string | null; url: string };

/**
 * Ответ бэкенда о публичной странице (getPublicPage, раздел 3.6 спецификации). view попадает
 * в загрузочные данные как есть: это тот же объект, что отдаёт GET /api/public/i|g/…
 * 401 — приглашение под паролем (look для формы ввода), 429 — исчерпаны попытки пароля.
 */
export type PublicPage =
  | { status: 200; view: { language: string }; meta: PageMeta }
  | { status: 401; locked: { look: { language?: string } }; meta: PageMeta }
  | { status: 404 | 429; meta: PageMeta };

export type PublicPageRequest = {
  kind: "shared" | "personal";
  key: string;
  code?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
};

/** Источник публичных страниц: подключается в src/app.ts. */
export type PublicPageResolver = (req: PublicPageRequest) => Promise<PublicPage>;

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
 * Страницы приглашений (/i/…, /g/…, в том числе «не найдено») несут личные данные: имена, адрес,
 * имя гостя. Поисковики их не индексируют, кэши не хранят. Превью ссылок в мессенджерах это не мешает.
 */
const isPrivatePage = (boot: Boot) => boot.mode !== "app";
const NOINDEX = "noindex, nofollow";

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
    isPrivatePage(opts.boot) && `<meta name="robots" content="${NOINDEX}">`,
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
  reply.code(opts.status ?? 200).type("text/html; charset=utf-8");
  if (isPrivatePage(opts.boot)) reply.header("cache-control", "private, no-store").header("x-robots-tag", NOINDEX);
  else reply.header("cache-control", "private, no-cache");
  return reply.send(renderShell(design, opts));
}

const shellMeta = (m: PageMeta): ShellMeta => ({
  title: m.title,
  ...(m.description && { description: m.description }),
  ...(m.image && { image: m.image }),
  url: m.url,
});

/**
 * Оболочка публичной страницы по ответу бэкенда: загрузочные данные, мета-теги, язык приглашения
 * и статус. Под паролем — { locked: { look } } для формы ввода (200), на языке приглашения из look.
 * Попытки пароля из ?code= исчерпаны (429): та же запертая страница со статусом 429 и locked.limited,
 * чтобы форма сказала «слишком много попыток», а не «неверный пароль»; look берётся из ответа без
 * пароля (без code попытка не считается). Не найдено (неизвестное, неопубликованное, архивное) — 404.
 */
export async function publicShell(resolve: PublicPageResolver, req: PublicPageRequest): Promise<ShellOptions> {
  const page = await resolve(req);
  const meta = shellMeta(page.meta);
  if (page.status === 200) {
    const { key, kind } = req;
    const boot: Boot = kind === "shared" ? { mode: "shared", slug: key, view: page.view } : { mode: "personal", token: key, view: page.view };
    return { boot, meta, lang: page.view.language };
  }
  if (page.status === 401 && req.kind === "shared") {
    const lang = page.locked.look.language;
    return { boot: { mode: "shared", slug: req.key, locked: page.locked }, meta, ...(lang && { lang }) };
  }
  if (page.status === 429 && req.code !== undefined) {
    const locked = await publicShell(resolve, { ...req, code: undefined });
    if (locked.boot.mode !== "shared" || !locked.boot.locked) return locked;
    return { ...locked, boot: { ...locked.boot, locked: { ...locked.boot.locked, limited: true } }, status: 429 };
  }
  return { boot: { mode: "notfound" }, meta, status: 404 };
}

/**
 * Сжатие по Accept-Encoding из готовых копий: br, затем gzip; q=0 запрещает, «*» — любое
 * не названное. null — отдать как есть.
 */
export function pickEncoding(header: string | undefined, available: Asset["encoded"]): Encoding | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of header.toLowerCase().split(",")) {
    const [name = "", ...params] = part.split(";").map((s) => s.trim());
    if (!name) continue;
    const qp = params.find((p) => p.startsWith("q="));
    const v = qp === undefined ? 1 : Number(qp.slice(2));
    q.set(name === "x-gzip" ? "gzip" : name, Number.isNaN(v) ? 0 : v);
  }
  let best: Encoding | null = null;
  let bestQ = 0;
  for (const e of ["br", "gzip"] as const) {
    const v = q.get(e) ?? q.get("*") ?? 0;
    if (available[e] && v > bestQ) [best, bestQ] = [e, v];
  }
  return best;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Слабый ETag: одно значение для сжатой и несжатой копии, сравнение If-None-Match всё равно слабое. */
const etagOf = (a: Asset) => `W/"${a.hash}"`;

function sendAsset(req: FastifyRequest<{ Querystring: { v?: string } }>, reply: FastifyReply, a: Asset) {
  const etag = etagOf(a);
  // Навсегда кэшируется только адрес с хэшем текущей версии. Старый ?v= после выкладки получает
  // новое содержимое без долгого кэша; модули без ?v= (их грузит логика) сверяются по ETag.
  // Vary всегда, и у несжатого ответа: иначе общий кэш, сохранивший его, год отдавал бы его всем.
  reply
    .type(a.type)
    .header("etag", etag)
    .header("vary", "accept-encoding")
    .header("cache-control", req.query.v === a.hash ? IMMUTABLE : "no-cache");
  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.slice(2))) return reply.code(304).send();
  const enc = pickEncoding(req.headers["accept-encoding"], a.encoded);
  return enc ? reply.header("content-encoding", enc).send(a.encoded[enc]) : reply.send(a.body);
}

/** Фронтенд: оболочка и файлы рантайма. Регистрируется без префикса; publicPage — данные /i/ и /g/. */
export async function webRoutes(app: FastifyInstance, opts: { publicPage: PublicPageResolver }) {
  const { ctx } = app;
  const store = createDesignStore({ watch: ctx.config.NODE_ENV === "development" });
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");

  // Файлы под /app/ отдаются из памяти уже сжатыми (compress: false, копию выбирает sendAsset).
  // Лимит отдельный на каждый файл и в 5 раз выше общего (120 в минуту): страница грузит каждый файл
  // не больше одного раза, а сами страницы ограничены общим лимитом, поэтому гости одного приглашения
  // с одного IP оператора в него не упираются, а один клиент не выкачивает файлы без конца.
  const assetRoute = { helmet: appHelmet, compress: false as const, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } };
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

  // Пароль общей ссылки может прийти в ?code= (ссылка вида /i/<slug>?code=…); повтор параметра или
  // слишком длинное значение считаются отсутствием пароля.
  app.get<{ Params: { slug: string }; Querystring: { code?: unknown } }>("/i/:slug", pageRoute, async (req, reply) => {
    const code = typeof req.query.code === "string" && req.query.code.length <= 64 ? req.query.code : undefined;
    const page = { kind: "shared" as const, key: req.params.slug, code, ip: req.ip, userAgent: req.headers["user-agent"] };
    return sendShell(reply, store.get(), await publicShell(opts.publicPage, page));
  });
  // Сборщики превью (по User-Agent) бэкенд не считает открытием приглашения гостем.
  app.get<{ Params: { token: string } }>("/g/:token", pageRoute, async (req, reply) => {
    const page = { kind: "personal" as const, key: req.params.token, ip: req.ip, userAgent: req.headers["user-agent"] };
    return sendShell(reply, store.get(), await publicShell(opts.publicPage, page));
  });

  // Неизвестный адрес (обработчик на весь сайт: плагин без префикса). Ссылка гостя с лишним «/» в конце
  // ведёт на саму ссылку; страница, которую открывают в браузере, получает оболочку «не найдено» в стиле
  // Invito. API, файлы (/media/, /app/*.js) и запросы не за HTML получают JSON, как раньше.
  app.setNotFoundHandler((req, reply) => {
    const [path = "", query] = req.url.split(/\?(.*)/s);
    if (req.method === "GET" || req.method === "HEAD") {
      const guest = /^\/([ig])\/([^/]+)\/+$/.exec(path);
      if (guest) return reply.redirect(`/${guest[1]}/${guest[2]}${query ? `?${query}` : ""}`, 301);
      const file = (path.split("/").pop() ?? "").includes(".");
      const html = (req.headers.accept ?? "").includes("text/html");
      if (html && !file && !/^\/(api|media)\//.test(path)) {
        // У обработчика 404 нет настроек маршрута, и helmet уже поставил заголовки сайта (frame-ancestors 'none',
        // X-Frame-Options: DENY). Оболочка «не найдено» открывается и во фрейме Telegram Web, поэтому получает
        // заголовки страниц приложения (appHelmet), как /app и /i/…: без X-Frame-Options, frame-ancestors с Telegram.
        reply.raw.removeHeader("x-frame-options");
        reply.helmet({ contentSecurityPolicy: appCsp, xFrameOptions: false });
        return sendShell(reply, store.get(), { boot: { mode: "notfound" }, meta: { title: ctx.config.APP_NAME }, status: 404 });
      }
    }
    return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
  });
}
