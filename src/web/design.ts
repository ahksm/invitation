import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { applyPatches, supportPatches } from "./support-patches.js";

/**
 * Сборка фронтенда из исходников дизайна (web/) в памяти: всё, что отдаётся под /app/.
 * Раздел 2 docs/invito-integration.md.
 */

export const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const require = createRequire(import.meta.url);

/** Корневой DC: приложение целиком. Остальные *.dc.html подключаются из него через <dc-import>. */
const ROOT_DC = "Invito";

export type Encoding = "br" | "gzip";

export type Asset = {
  body: Buffer;
  type: string;
  hash: string;
  /** Сжатые копии, сделанные один раз при сборке (только если они меньше исходника). */
  encoded: Partial<Record<Encoding, Buffer>>;
};

export type Design = {
  /** Файлы по путям, например "/app/support.js". */
  assets: ReadonlyMap<string, Asset>;
  /** Google Fonts из <helmet> корневого DC: оболочка подключает их, не дожидаясь рантайма. */
  fontsHref: string | null;
  /** Модули, которые логика корневого DC загружает через import(): оболочка просит их заранее. */
  preload: readonly string[];
};

type DcSource = {
  template: string;
  props: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  logic: string | null;
  /** Строка файла, с которой начинается текст логики (для сообщений об ошибках). */
  logicLine: number;
};

const JS = "text/javascript; charset=utf-8";
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/**
 * Файл сборки со сжатыми копиями. Сжатие при сборке, а не на каждый ответ: иначе каждый запрос
 * большого dc-bundle.js стоил бы миллисекунды процессора. Brotli 9 вместо 11: сборка (и пересборка
 * в development) в 6–7 раз быстрее, а файлы больше всего примерно на 9%.
 */
const asset = (body: string | Buffer): Asset => {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const br = brotliCompressSync(buf, {
    params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length },
  });
  const gzip = gzipSync(buf, { level: 9 });
  return {
    body: buf,
    type: JS,
    hash: createHash("sha256").update(buf).digest("hex").slice(0, 16),
    encoded: { ...(br.length < buf.length && { br }), ...(gzip.length < buf.length && { gzip }) },
  };
};

/** Текст исходника дизайна с переводами строк LF: в checkout с CRLF (Windows) фрагменты патчей иначе не находятся. */
const readText = (file: string) => readFileSync(file, "utf8").replace(/\r\n?/g, "\n");

/** Адрес файла с хэшем содержимого: такие ответы кэшируются навсегда. */
export function assetUrl(design: Design, path: string): string {
  const a = design.assets.get(path);
  if (!a) throw new Error(`нет файла ${path} в сборке дизайна`);
  return `${path}?v=${a.hash}`;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** Значение HTML-атрибута как его видит браузер (data-props хранит JSON с &quot;). */
function decodeAttr(s: string, where: string): string {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (!Object.hasOwn(NAMED_ENTITIES, e)) throw new Error(`${where}: неизвестная HTML-сущность ${m}`);
    return NAMED_ENTITIES[e]!;
  });
}

/** Первый <script data-dc-script>: атрибуты и текст. Комментарии и содержимое других скриптов пропускаются. */
function findDcScript(src: string): { attrs: string; text: string; start: number } | null {
  const re = new RegExp(`<!--[\\s\\S]*?-->|<script(\\s${ATTRS})?>`, "gi");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith("<!--")) continue;
    const start = re.lastIndex;
    const close = /<\/script[\s/>]/i.exec(src.slice(start));
    const end = close ? start + close.index : src.length;
    const attrs = m[1] ?? "";
    if (/\sdata-dc-script(?=[\s=/]|$)/i.test(attrs)) return { attrs, text: src.slice(start, end), start };
    re.lastIndex = end;
  }
  return null;
}

/**
 * Разбор .dc.html так же, как parseDcText в support.js: шаблон — сырой текст между первым <x-dc>
 * и последним </x-dc>, логика и data-props — из первого <script data-dc-script>.
 */
export function parseDcFile(file: string, src: string): DcSource {
  const open = /<x-dc(?:\s[^>]*)?>/.exec(src);
  const close = src.lastIndexOf("</x-dc>");
  if (!open || close < open.index) throw new Error(`${file}: нет блока <x-dc>`);
  const template = src.slice(open.index + open[0].length, close);

  const script = findDcScript(src);
  let props: Record<string, unknown> | null = null;
  let preview: Record<string, unknown> | null = null;
  const raw = script && /\sdata-props\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(script.attrs);
  if (raw) {
    const json = decodeAttr(raw[1] ?? raw[2] ?? raw[3] ?? "", file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`${file}: data-props не JSON (${(e as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: data-props должен быть объектом`);
    // Как parseDataProps: ключи с $ служебные, $preview — размер превью.
    const obj = parsed as Record<string, unknown>;
    const $preview = obj.$preview;
    if ($preview && typeof $preview === "object") preview = $preview as Record<string, unknown>;
    const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k[0] !== "$"));
    props = Object.keys(rest).length ? rest : null;
  }
  const logicLine = script ? src.slice(0, script.start).split("\n").length : 1;
  return { template, props, preview, logic: script?.text || null, logicLine };
}

/**
 * Логика DC обычной функцией с тем же окружением, что давал new Function в оригинале
 * (параметры DCLogic, StreamableLogic, React; остальное из window; нестрогий режим).
 * Текст логики начинается со второй строки функции.
 */
const logicFunction = (logic: string) =>
  `function (DCLogic, StreamableLogic, React) {\n${logic}\n;return (typeof Component!=="undefined"&&Component)||undefined;\n}`;

/**
 * Синтаксис логики проверяется при сборке: логика всех DC идёт одним скриптом, и ошибка в любой
 * из них в браузере ломает весь dc-bundle.js (пустая страница), а не один DC, как в оригинале.
 * line — строка файла, с которой начинается логика: номер строки ошибки указывает в .dc.html.
 */
function checkLogic(file: string, logic: string, line: number) {
  try {
    // Только разбор: функция не вызывается.
    new Script(`(${logicFunction(logic)})`, { filename: file, lineOffset: line - 2 });
  } catch (e) {
    const at = /^[^\n]*:(\d+)\n/.exec(String((e as Error).stack))?.[1];
    throw new Error(`${file}${at ? `:${at}` : ""}: ошибка в логике DC (${(e as Error).message})`);
  }
}

/** /app/dc-bundle.js: исходники всех DC для пропатченного support.js. Шаблоны сырым текстом, логика функциями. */
function dcBundle(sources: Map<string, DcSource>): string {
  const data = Object.fromEntries(
    [...sources].map(([name, s]) => [name, { template: s.template, props: s.props, ...(s.preview && { preview: s.preview }) }]),
  );
  const out = [
    "// Собрано сервером из web/*.dc.html (src/web/design.ts), руками не править.",
    `window.__dcRoot = ${JSON.stringify(ROOT_DC)};`,
    `window.__dcSources = ${JSON.stringify(data)};`,
    "window.__dcLogic = {};",
  ];
  for (const [name, s] of sources) {
    if (s.logic !== null) out.push(`window.__dcLogic[${JSON.stringify(name)}] = ${logicFunction(s.logic)};`);
  }
  return out.join("\n") + "\n";
}

/** Файл пакета из node_modules (у react в exports нет umd/, поэтому от package.json). */
function packageFile(pkg: string, file: string): Buffer {
  return readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), file));
}

export function buildDesign(dir = webDir): Design {
  const files = readdirSync(dir).sort();
  const sources = new Map<string, DcSource>();
  for (const f of files.filter((f) => f.endsWith(".dc.html"))) {
    sources.set(f.slice(0, -".dc.html".length), parseDcFile(`web/${f}`, readText(join(dir, f))));
  }
  const root = sources.get(ROOT_DC);
  if (!root) throw new Error(`нет web/${ROOT_DC}.dc.html`);
  // Правки, которые повторяются после каждой выгрузки дизайна из Claude Design (README, «Фронтенд»).
  for (const [name, s] of sources) {
    if (s.template.includes("telegram-web-app.js")) {
      throw new Error(`web/${name}.dc.html: уберите telegram-web-app.js из <helmet>, его подключает оболочка`);
    }
    if (/\bimport\(\s*new URL\(/.test(s.logic ?? "")) {
      throw new Error(`web/${name}.dc.html: модули импортируются по абсолютному пути, import('/app/invito-data.js'), иначе /i/… и /g/… ищут их не там`);
    }
    if (s.logic !== null) checkLogic(`web/${name}.dc.html`, s.logic, s.logicLine);
  }

  const assets = new Map<string, Asset>();
  assets.set("/app/dc-bundle.js", asset(dcBundle(sources)));
  const support = applyPatches(readText(join(dir, "support.js")), supportPatches);
  assets.set("/app/support.js", asset(`// web/support.js с патчами сервера (src/web/support-patches.ts).\n${support}`));
  // ES-модули дизайна (invito-data.js, invito-engine.js, invito-api.js и новые) отдаются как есть.
  for (const f of files.filter((f) => f.endsWith(".js") && f !== "support.js")) {
    if (assets.has(`/app/${f}`)) throw new Error(`web/${f}: имя занято файлом, который собирает сервер`);
    assets.set(`/app/${f}`, asset(readFileSync(join(dir, f))));
  }
  assets.set("/app/vendor/react.production.min.js", asset(packageFile("react", "umd/react.production.min.js")));
  assets.set("/app/vendor/react-dom.production.min.js", asset(packageFile("react-dom", "umd/react-dom.production.min.js")));
  // Глобальная функция qrcode (классический скрипт, без модулей).
  assets.set("/app/vendor/qrcode.js", asset(readFileSync(require.resolve("qrcode-generator"))));

  const fonts = new RegExp(`<link${ATTRS}\\shref="(https://fonts\\.googleapis\\.com/css2\\?[^"]*)"`).exec(root.template);
  const preload = [...(root.logic ?? "").matchAll(/\bimport\(\s*(['"])(\/app\/[\w.-]+\.js)\1\s*\)/g)]
    .map((m) => m[2]!)
    .filter((p) => assets.has(p));
  return { assets, fontsHref: fonts ? decodeAttr(fonts[1]!, `web/${ROOT_DC}.dc.html`) : null, preload };
}

/**
 * Текущая сборка. В development пересобирается, когда меняется время файлов в web/
 * (новый модуль в web/ требует перезапуска: маршруты регистрируются при старте).
 */
export function createDesignStore(opts: { watch: boolean; dir?: string }) {
  const dir = opts.dir ?? webDir;
  const stamp = () =>
    opts.watch
      ? readdirSync(dir)
          .map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`)
          .join("|")
      : "";
  // Отметка снимается до сборки: файл, изменённый во время сборки, пересоберётся на следующем запросе.
  let built = { stamp: stamp(), design: buildDesign(dir) };
  return {
    get(): Design {
      if (opts.watch) {
        const now = stamp();
        if (now !== built.stamp) built = { stamp: now, design: buildDesign(dir) };
      }
      return built.design;
    },
  };
}
