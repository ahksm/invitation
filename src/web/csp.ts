import type { FastifyHelmetOptions } from "@fastify/helmet";

// Политика безопасности контента (docs/invito-integration.md, раздел 2.4). Рантайм дизайна
// работает без 'unsafe-eval': логика приходит готовыми функциями из /app/dc-bundle.js.
const directives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://telegram.org"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "data:", "blob:", "https://images.unsplash.com"],
  // Загруженные видео и музыка до отправки на сервер играют из blob:.
  mediaSrc: ["'self'", "blob:", "data:"],
  // Карта места (Google Maps) и виджет входа через Telegram.
  frameSrc: ["https://maps.google.com", "https://www.google.com", "https://oauth.telegram.org"],
  connectSrc: ["'self'"],
};

/** Весь сайт по умолчанию (админка, API): встраивать в чужие страницы нельзя. */
export const siteHelmet: FastifyHelmetOptions = {
  contentSecurityPolicy: { directives: { ...directives, frameAncestors: ["'none'"] } },
  xFrameOptions: { action: "deny" },
};

/**
 * Страницы и файлы приложения (`/`, `/app*`, `/i/*`, `/g/*`). Telegram Web открывает мини-апп
 * во фрейме web.telegram.org, поэтому frame-ancestors разрешает Telegram, а X-Frame-Options
 * не отправляется: в нём нельзя перечислить чужие сайты, и браузер, который смотрит на него,
 * а не на CSP, запретил бы фрейм.
 */
export const appCsp = {
  directives: { ...directives, frameAncestors: ["'self'", "https://web.telegram.org", "https://*.telegram.org"] },
};

export const appHelmet: Omit<FastifyHelmetOptions, "global"> = { contentSecurityPolicy: appCsp, xFrameOptions: false };
