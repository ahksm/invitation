// Клиент API Invito (docs/invito-integration.md, раздел 3). ES-модуль: логика дизайна подгружает его
// так же, как invito-data.js, через import('/app/invito-api.js').

let lang = 'ru';

/** Язык интерфейса: уходит в заголовке X-Lang, на нём сервер переводит тексты ошибок. */
export function setLang(code) { lang = code; }

/**
 * Запрос к API. body отправляется как JSON (метод по умолчанию POST, без тела GET), ответ
 * разбирается как JSON (204 даёт null). При ответе не 2xx бросает Error с полями status и data
 * (тело ответа); message — переведённый текст ошибки сервера.
 */
export async function api(path, opts = {}) {
  const { body, headers, ...rest } = opts;
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...rest,
    credentials: 'include',
    headers: { accept: 'application/json', 'x-lang': lang, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) {
    const err = new Error((data && typeof data === 'object' && typeof data.error === 'string' && data.error) || 'HTTP ' + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
