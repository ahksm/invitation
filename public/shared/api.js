import { getLang, intlLocale, t } from "/shared/i18n.js";

// Общие помощники для кабинета и админки.
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-lang": getLang(), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const money = (minor, currency = "UZS") =>
  `${(Number(minor) / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })} ${currency === "UZS" ? t("currency") : currency}`;

export const date = (v) => (v ? new Date(v).toLocaleString(intlLocale(), { dateStyle: "short", timeStyle: "short" }) : "—");

export function toast(text, kind = "ok") {
  const el = h("div", { class: `toast ${kind}` }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}
