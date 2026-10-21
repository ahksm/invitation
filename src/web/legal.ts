import type { FastifyInstance } from "fastify";
import { BRAND } from "../brand.js";
import { botUsername } from "../config.js";
import { pickLocale, type Locale } from "../i18n.js";
import { longDate } from "../services/public.js";
import { getLegal, type Legal } from "../services/settings.js";
import { appHelmet } from "./csp.js";
import { LEGAL_PAGES, LEGAL_REVISION, legalTexts, type Block, type LegalField, type LegalPage, type LegalTexts } from "./legal-texts.js";

/**
 * Юридические страницы /oferta, /privacy и /contacts (их требует Multicard): обычный HTML без скриптов,
 * в стиле сайта. Язык из ?lang= (ru по умолчанию, uz, uzc, en), реквизиты — из настроек (раздел «Реквизиты»
 * админки); пустые поля не выводятся.
 */

export type LegalEnv = {
  lang: Locale;
  legal: Legal;
  /** APP_URL без «/» в конце. */
  appUrl: string;
  /** Имя Telegram-бота; null, если бот не запущен. */
  bot: string | null;
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

const HTML_LANG: Record<Locale, string> = { ru: "ru", uz: "uz-Latn", uzc: "uz-Cyrl", en: "en" };
// Порядок и подписи как у переключателя языка в приложении (LANGS в web/invito-data.js).
const LANG_LINKS: [Locale, string][] = [
  ["ru", "RU"],
  ["en", "EN"],
  ["uz", "UZ"],
  ["uzc", "ЎЗ"],
];

const FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Onest:wght@400;500&family=JetBrains+Mono:wght@500&display=swap";

const hostOf = (appUrl: string) => new URL(appUrl).host;

/** Адрес страницы документов: без ?lang= для русского. */
export const legalPath = (page: LegalPage, lang: Locale) => (lang === "ru" ? `/${page}` : `/${page}?lang=${lang}`);

/** Язык страницы из ?lang=: uz, uzc (и uz-Cyrl), en; всё остальное, в том числе отсутствие, — русский. */
export const legalLocale = (lang: unknown): Locale => (typeof lang === "string" ? pickLocale(lang) : "ru");

const executorOf = (env: LegalEnv, t: LegalTexts) => env.legal.companyName || t.ui.executor.replace("{host}", hostOf(env.appUrl));

/** Текст для мета-тегов: подстановки и подписи ссылок без разметки (экранирует вызывающий). */
function plain(text: string, env: LegalEnv, t: LegalTexts): string {
  return text
    .replace(/\[([^\]]+)\]\((?:oferta|privacy|contacts)\)/g, "$1")
    .replace(/\{(executor|site|host|app)\}/g, (_, k: string) => (k === "executor" ? executorOf(env, t) : k === "app" ? BRAND : hostOf(env.appUrl)));
}

/** Текст в HTML: сначала экранирование, затем ссылки «[текст](privacy)» и подстановки (их значения экранируются). */
function inline(text: string, env: LegalEnv, t: LegalTexts): string {
  const host = hostOf(env.appUrl);
  return esc(text)
    .replace(/\[([^\]]+)\]\((oferta|privacy|contacts)\)/g, (_, label: string, page: LegalPage) => `<a href="${esc(legalPath(page, env.lang))}">${label}</a>`)
    .replace(/\{(executor|site|host|app)\}/g, (_, k: string) =>
      k === "site" ? `<a href="${esc(env.appUrl)}/">${esc(host)}</a>` : esc(k === "executor" ? executorOf(env, t) : k === "app" ? BRAND : host),
    );
}

/**
 * Ссылка tel: для первого номера в поле (цифры, пробелы, скобки, дефисы): 9 цифр (узбекский без кода) или
 * 11–15 цифр; иначе null. Добавочный («доб. 105») и другой текст в поле в ссылку не попадают.
 */
function telHref(phone: string): string | null {
  const m = /\+?\d[\d\s()\u2011-]{6,}\d/.exec(phone);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  const full = digits.length === 9 ? `998${digits}` : digits;
  return full.length >= 11 && full.length <= 15 ? `tel:+${full}` : null;
}

const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;

type Row = [field: LegalField, html: string];

const COMPANY_FIELDS = ["companyName", "inn", "address", "director", "bankName", "bankAccount", "mfo"] as const;

function companyRows(legal: Legal): Row[] {
  return COMPANY_FIELDS.filter((f) => legal[f]).map((f) => [f, esc(legal[f])]);
}

function contactRows(env: LegalEnv): Row[] {
  const { legal } = env;
  const rows: Row[] = [];
  if (legal.telegram) rows.push(["telegram", link(`https://t.me/${legal.telegram}`, `@${legal.telegram}`)]);
  if (env.bot) rows.push(["bot", link(`https://t.me/${env.bot}`, `@${env.bot}`)]);
  if (legal.phone) {
    const tel = telHref(legal.phone);
    rows.push(["phone", tel ? link(tel, legal.phone) : esc(legal.phone)]);
  }
  if (legal.email) rows.push(["email", link(`mailto:${legal.email}`, legal.email)]);
  rows.push(["site", link(`${env.appUrl}/`, hostOf(env.appUrl))]);
  return rows;
}

function rowsHtml(rows: Row[], t: LegalTexts): string {
  if (!rows.length) return "";
  const items = rows.map(([f, html]) => `<div data-field="${f}"><dt>${esc(t.ui.fields[f])}</dt><dd>${html}</dd></div>`);
  return `<dl class="rows">${items.join("")}</dl>`;
}

function slotHtml(slot: "details" | "contacts" | "company", env: LegalEnv, t: LegalTexts): string {
  if (slot === "company") return rowsHtml(companyRows(env.legal), t);
  if (slot === "contacts") return rowsHtml(contactRows(env), t);
  return rowsHtml([...companyRows(env.legal), ...contactRows(env)], t);
}

/** Раздел документа; null, если в нём нечего показать (например, реквизиты не заполнены). */
function sectionHtml(blocks: Block[], n: number | null, env: LegalEnv, t: LegalTexts): string | null {
  let p = 0;
  let filled = false;
  const parts = blocks.map((b) => {
    if (typeof b === "string") {
      p++;
      return n === null ? `<p>${inline(b, env, t)}</p>` : `<p class="cl"><span class="pn">${n}.${p}</span><span>${inline(b, env, t)}</span></p>`;
    }
    if ("list" in b) return `<ul>${b.list.map((li) => `<li>${inline(li, env, t)}</li>`).join("")}</ul>`;
    const html = slotHtml(b.slot, env, t);
    filled ||= html !== "";
    return html;
  });
  // Раздел только из данных настроек без самих данных не выводится.
  if (!filled && blocks.every((b) => typeof b === "object" && "slot" in b)) return null;
  return parts.join("");
}

// Название в шапке занимает место, которое остаётся от переключателя языка, и уменьшается до 20px, если
// «InviteBloom» в 32px не помещается (100cqi / 4.4 — ширина слова в Cormorant Garamond italic с запасом), как в приложении.
const CSS = `
:root{--paper:#f3efe6;--paper-rgb:243,239,230;--ink:#1a1714;--body:#4a443c;--muted:#6e665b;--card:#fbf9f4;--line:rgba(26,23,20,.14);--line2:rgba(26,23,20,.22);--accent:#d4452a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#151311;--paper-rgb:21,19,17;--ink:#f1ebe0;--body:#cfc6b8;--muted:#a39a8c;--card:#1e1b18;--line:rgba(241,235,224,.14);--line2:rgba(241,235,224,.24);color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:80px}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.65 'Onest',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--ink);text-decoration-color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{color:var(--accent);text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.wrap{max-width:1120px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
.bar{position:sticky;top:0;z-index:5;background:rgba(var(--paper-rgb),.9);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.bar-in{height:60px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{flex:1 1 0;min-width:0;container-type:inline-size;display:flex;align-items:center}
.logo{font:italic 500 clamp(20px,calc(100cqi / 4.4),32px)/1 'Cormorant Garamond',Georgia,serif;letter-spacing:-.01em;color:var(--ink);text-decoration:none;white-space:nowrap}
.langs{flex:none;display:flex;gap:2px;padding:3px;border:1px solid var(--line2);border-radius:999px}
.langs a{min-width:36px;height:30px;padding:0 8px;display:flex;align-items:center;justify-content:center;border-radius:999px;font:500 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.06em;color:var(--muted);text-decoration:none}
.langs a:hover{color:var(--ink)}
.langs a[aria-current]{background:var(--ink);color:var(--paper)}
main.wrap{padding-top:28px;padding-bottom:72px}
.docs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px}
.docs a{height:34px;padding:0 14px;display:inline-flex;align-items:center;border:1px solid var(--line2);border-radius:999px;font:500 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);text-decoration:none}
.docs a:hover{border-color:var(--accent);color:var(--accent)}
.docs a[aria-current]{background:var(--ink);border-color:var(--ink);color:var(--paper)}
h1{margin:0 0 16px;font:500 clamp(40px,9vw,72px)/1.02 'Cormorant Garamond',Georgia,serif;letter-spacing:-.01em;overflow-wrap:break-word}
.lead{margin:0;max-width:60ch;font-size:18px;line-height:1.55;color:var(--body)}
.meta{margin:16px 0 0;font:500 11px/1.6 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.note{margin:12px 0 0;max-width:60ch;font-size:14px;color:var(--muted)}
.layout{display:grid;gap:32px;margin-top:36px;padding-top:32px;border-top:1px solid var(--line)}
.label{margin:0 0 10px;font:500 11px/1.6 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.toc ol{margin:0;padding:0;list-style:none;counter-reset:toc}
.toc li{counter-increment:toc}
.toc a{display:flex;gap:10px;padding:6px 0;font-size:14px;line-height:1.4;color:var(--body);text-decoration:none}
.toc a::before{content:counter(toc);min-width:18px;font:500 11px/20px 'JetBrains Mono',ui-monospace,monospace;color:var(--accent)}
.toc a:hover{color:var(--accent)}
.toc-side{display:none}
.toc-mob{margin-bottom:28px;border:1px solid var(--line);border-radius:14px;background:var(--card);padding:0 16px}
.toc-mob summary{display:flex;justify-content:space-between;align-items:center;min-height:48px;cursor:pointer;list-style:none;font:500 11px/1.6 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.toc-mob summary::-webkit-details-marker{display:none}
.toc-mob summary::after{content:"+";font-size:16px;color:var(--accent)}
.toc-mob[open] summary::after{content:"−"}
.toc-mob ol{padding-bottom:12px}
@media (min-width:960px){.layout.has-toc{grid-template-columns:240px minmax(0,1fr);gap:64px}.toc-side{display:block;position:sticky;top:92px;align-self:start;max-height:calc(100vh - 110px);overflow:auto}.toc-mob{display:none}}
.doc{min-width:0;max-width:720px}
.doc section+section{margin-top:36px}
h2{margin:0 0 14px;display:flex;gap:12px;align-items:baseline;font:500 clamp(26px,5vw,34px)/1.12 'Cormorant Garamond',Georgia,serif}
h2 .num{font-style:italic;color:var(--accent)}
.doc p{margin:0 0 12px;color:var(--body)}
.doc p.cl{display:grid;grid-template-columns:40px minmax(0,1fr)}
.pn{font:500 11px/26px 'JetBrains Mono',ui-monospace,monospace;color:var(--muted)}
.doc ul{margin:0 0 14px;padding:0 0 0 20px;color:var(--body)}
.doc.numbered ul{padding-left:60px}
.doc li{margin:6px 0}
.doc li::marker{color:var(--accent)}
.rows{margin:4px 0 16px;border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden}
.rows div{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr);gap:2px 20px;padding:14px 18px}
.rows div+div{border-top:1px solid var(--line)}
.rows dt{font:500 11px/26px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.rows dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
@media (max-width:560px){.rows div{grid-template-columns:minmax(0,1fr)}.doc.numbered ul{padding-left:58px}}
.foot{border-top:1px solid var(--line);padding:28px 0 calc(28px + env(safe-area-inset-bottom))}
.foot-in{display:flex;flex-wrap:wrap;gap:14px 28px;align-items:center;justify-content:space-between;font:500 11px/1.6 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.foot nav{display:flex;flex-wrap:wrap;gap:10px 22px}
.foot a{color:var(--ink);text-decoration:none}
.foot a:hover{color:var(--accent)}
@media print{.bar,.docs,.toc-side,.toc-mob,.foot nav{display:none}body{background:#fff;color:#000}.layout{display:block;border:0}.rows{background:none}}
`
  .trim()
  .replace(/\n/g, "");

/** HTML страницы документа на языке env.lang. */
export function renderLegalPage(page: LegalPage, env: LegalEnv): string {
  const t = legalTexts[env.lang];
  const doc = t.docs[page];
  const title = `${doc.title} — ${BRAND}`;
  const description = plain(doc.description, env, t);
  const abs = (lang: Locale) => `${env.appUrl}${legalPath(page, lang)}`;

  const sections: { id: string; title: string; html: string }[] = [];
  for (const s of doc.sections) {
    const html = sectionHtml(s.blocks, doc.numbered ? sections.length + 1 : null, env, t);
    if (html !== null) sections.push({ id: s.id, title: s.title, html });
  }
  const tocList = `<ol>${sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("")}</ol>`;
  const toc = doc.numbered
    ? [
        `<nav class="toc toc-side" aria-label="${esc(t.ui.toc)}"><p class="label">${esc(t.ui.toc)}</p>${tocList}</nav>`,
        `<details class="toc toc-mob"><summary>${esc(t.ui.toc)}</summary>${tocList}</details>`,
      ]
    : [];
  const body = sections.map(
    (s, i) =>
      `<section id="${s.id}"><h2>${doc.numbered ? `<span class="num">${i + 1}.</span>` : ""}<span>${esc(s.title)}</span></h2>${s.html}</section>`,
  );
  const current = (on: boolean) => (on ? ' aria-current="page"' : "");
  const docLinks = LEGAL_PAGES.map((p) => `<a href="${esc(legalPath(p, env.lang))}"${current(p === page)}>${esc(t.ui.nav[p])}</a>`).join("");

  return [
    "<!doctype html>",
    `<html lang="${HTML_LANG[env.lang]}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(abs(env.lang))}">`,
    ...LANG_LINKS.map(([l]) => `<link rel="alternate" hreflang="${HTML_LANG[l]}" href="${esc(abs(l))}">`),
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${BRAND}">`,
    `<meta property="og:url" content="${esc(abs(env.lang))}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${esc(FONTS)}">`,
    `<style>${CSS}</style>`,
    "</head>",
    `<body data-page="${page}">`,
    `<header class="bar"><div class="wrap bar-in"><div class="brand"><a class="logo" href="/">${BRAND}</a></div>`,
    `<nav class="langs" aria-label="${esc(t.ui.langLabel)}">${LANG_LINKS.map(
      ([l, label]) => `<a href="${esc(legalPath(page, l))}" hreflang="${HTML_LANG[l]}" lang="${HTML_LANG[l]}"${current(l === env.lang)}>${label}</a>`,
    ).join("")}</nav></div></header>`,
    '<main class="wrap">',
    `<nav class="docs" aria-label="${esc(t.ui.docsLabel)}">${docLinks}</nav>`,
    `<h1>${esc(doc.title)}</h1>`,
    `<p class="lead">${inline(doc.lead, env, t)}</p>`,
    doc.numbered && `<p class="meta">${esc(t.ui.revision.replace("{date}", longDate(LEGAL_REVISION, env.lang)))}</p>`,
    t.ui.note && `<p class="note">${esc(t.ui.note)}</p>`,
    `<div class="layout${doc.numbered ? " has-toc" : ""}">`,
    toc[0],
    `<article class="doc${doc.numbered ? " numbered" : ""}">`,
    toc[1],
    ...body,
    "</article>",
    "</div>",
    "</main>",
    `<footer class="foot"><div class="wrap foot-in"><nav aria-label="${esc(t.ui.docsLabel)}">${docLinks}</nav>`,
    `<a href="/">← ${esc(t.ui.home)}</a>`,
    `<span>© ${new Date().getUTCFullYear()} ${BRAND}</span></div></footer>`,
    "</body>",
    "</html>\n",
  ]
    .filter((line) => line)
    .join("\n");
}

/**
 * Маршруты /oferta, /privacy и /contacts. Заголовки как у страниц приложения (appHelmet): страницу можно
 * открыть и внутри мини-аппа в Telegram Web. Кэш как у главной: реквизиты, сохранённые в админке, видны сразу.
 */
export async function legalRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const appUrl = ctx.config.APP_URL.replace(/\/+$/, "");
  for (const page of LEGAL_PAGES) {
    app.get<{ Querystring: { lang?: unknown } }>(`/${page}`, { helmet: appHelmet }, async (req, reply) => {
      const env: LegalEnv = {
        lang: legalLocale(req.query.lang),
        legal: await getLegal(ctx),
        appUrl,
        bot: botUsername(ctx.config),
      };
      reply.type("text/html; charset=utf-8").header("cache-control", "private, no-cache");
      return renderLegalPage(page, env);
    });
  }
}
