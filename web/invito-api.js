// Клиент API InviteBloom (docs/invito-integration.md, раздел 3). ES-модуль: логика дизайна подгружает его
// так же, как invito-data.js, через import('/app/invito-api.js').

let lang = 'ru';

let token = null;

/** Язык интерфейса: уходит в заголовке X-Lang, на нём сервер переводит тексты ошибок. */
export function setLang(code) { lang = code; }

/**
 * Токен сессии из POST /api/auth/webapp. В Telegram Web мини-апп открыт во фрейме чужого сайта,
 * cookie туда не доходит, поэтому токен уходит в заголовке Authorization. null — снова только cookie.
 */
export function setToken(value) { token = value || null; }

export function getToken() { return token; }

const headersFor = (extra) => ({
  accept: 'application/json',
  'x-lang': lang,
  ...(token && { authorization: 'Bearer ' + token }),
  ...extra,
});

/** Ошибка ответа не 2xx: status и data (тело ответа), message — переведённый текст ошибки сервера. */
function httpError(status, data) {
  const err = new Error((data && typeof data === 'object' && typeof data.error === 'string' && data.error) || 'HTTP ' + status);
  err.status = status;
  err.data = data;
  return err;
}

const parse = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
};

/**
 * Запрос к API. body отправляется как JSON (метод по умолчанию POST, без тела GET), raw — файл (Blob)
 * телом запроса с его типом (картинка превью: PUT /og). Ответ разбирается как JSON (204 даёт null).
 * При ответе не 2xx бросает Error с полями status и data (тело ответа); message — переведённый текст
 * ошибки сервера. Ошибка сети — Error без status.
 */
export async function api(path, opts = {}) {
  const { body, raw, headers, ...rest } = opts;
  const json = body !== undefined;
  const res = await fetch(path, {
    method: json || raw ? 'POST' : 'GET',
    ...rest,
    credentials: 'include',
    headers: headersFor({ ...(json && { 'content-type': 'application/json' }), ...(raw && { 'content-type': raw.type || 'application/octet-stream' }), ...headers }),
    body: raw || (json ? JSON.stringify(body) : undefined),
  });
  const data = parse(await res.text());
  if (!res.ok) throw httpError(res.status, data);
  return data;
}

/**
 * Загрузка файла multipart-формой (поле file) с прогрессом: fetch не сообщает, сколько отправлено,
 * поэтому XMLHttpRequest. onProgress(доля 0..1). Ошибки — как у api().
 */
export function upload(path, blob, opts = {}) {
  const { filename = 'file', onProgress, field = 'file' } = opts;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    const h = headersFor();
    for (const k of Object.keys(h)) xhr.setRequestHeader(k, h[k]);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const data = parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(httpError(xhr.status, data));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('aborted'));
    const form = new FormData();
    form.append(field, blob, filename);
    xhr.send(form);
  });
}

/**
 * Картинка перед загрузкой: длинная сторона не больше max пикселей, JPEG с качеством quality.
 * GIF остаётся как есть (анимация), картинка, которую браузер не смог разобрать, тоже: тип
 * всё равно проверит сервер. Прозрачный фон PNG становится белым.
 */
export async function downscaleImage(file, max = 2000, quality = 0.85) {
  if (!file || file.type === 'image/gif') return file;
  let img;
  try {
    img = await createImageBitmap(file);
  } catch (e) {
    return file;
  }
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return blob || file;
}

/**
 * Картинка data:-адреса (renderCard) как JPEG-файл для загрузки. fetch(data:) запрещён CSP
 * (connect-src 'self'), поэтому base64 разбирается здесь. null, если картинку не удалось разобрать.
 */
export async function dataUrlToJpeg(dataUrl, quality = 0.88) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const src = new Blob([bytes], { type: m[1] });
  if (m[1] === 'image/jpeg') return src;
  const out = await downscaleImage(src, 4000, quality);
  return out && out.type === 'image/jpeg' ? out : null;
}

/**
 * QR-код ссылки PNG-картинкой (data:), рисуется в браузере библиотекой qrcode-generator
 * (глобальная функция qrcode из /app/vendor/qrcode.js): внешние сервисы QR запрещены CSP.
 * size — сторона в пикселях (с полями margin в модулях), ink и paper — цвета. Без библиотеки — ''.
 */
export function qrDataUrl(text, opts = {}) {
  const make = typeof window !== 'undefined' && window.qrcode;
  if (!make || !text) return '';
  const { size = 300, margin = 2, ink = '#000000', paper = '#ffffff', level = 'M' } = opts;
  const qr = make(0, level);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount(), cells = n + margin * 2, k = Math.max(1, Math.floor(size / cells)), px = cells * k;
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = ink;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * k, (r + margin) * k, k, k);
  return canvas.toDataURL('image/png');
}
