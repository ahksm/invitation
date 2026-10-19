/**
 * Данные дизайна Invito (web/invito-data.js): каталог шаблонов, события, стили со шрифтами,
 * секции, треки и транслитерация. Модуль общий с фронтендом, поэтому бэкенд не копирует его,
 * а импортирует во время выполнения. Путь считается от этого файла: работает и из src/ (tsx),
 * и из dist/ после tsc, если рядом лежит каталог web/.
 *
 * Типы описаны вручную и только для того, что использует бэкенд.
 */

/** Языки дизайна: ru, en, uz (латиница), uzc (узбекский, кириллица). */
export type DesignLocale = "ru" | "en" | "uz" | "uzc";

export type DesignTemplate = {
  /** `<event>-<style>`, совпадает со slug шаблона в базе. */
  id: string;
  event: string;
  style: string;
  /** Название шаблона (только по-английски). */
  name: string;
};

export type DesignEvent = {
  label: Record<DesignLocale, string>;
  /** Стили шаблонов события; styles[i] соответствует names[i]. */
  styles: string[];
  names: string[];
};

export type DesignStyle = {
  label: string;
  /** Шрифты заголовков, которые можно выбрать в этом стиле; первый используется по умолчанию. */
  fonts: string[];
  body: string;
};

type DesignModule = {
  TEMPLATES: DesignTemplate[];
  EVENTS: Record<string, DesignEvent>;
  EVENT_ORDER: string[];
  STYLES: Record<string, DesignStyle>;
  SECTIONS: string[];
  TRACKS: string[];
  toCyr: (s: string) => string;
  slugify: (s: string) => string;
};

const mod = (await import(new URL("../web/invito-data.js", import.meta.url).href)) as DesignModule;

export const TEMPLATES: readonly DesignTemplate[] = mod.TEMPLATES;
export const EVENTS: Readonly<Record<string, DesignEvent>> = mod.EVENTS;
export const EVENT_ORDER: readonly string[] = mod.EVENT_ORDER;
export const STYLES: Readonly<Record<string, DesignStyle>> = mod.STYLES;
export const SECTIONS: readonly string[] = mod.SECTIONS;
export const TRACKS: readonly string[] = mod.TRACKS;

/** Узбекская латиница → кириллица (тексты uzc получаются из uz). Бренды и @имена не меняются. */
export const toCyr: (s: string) => string = mod.toCyr;
/** Текст → часть ссылки: латиница, цифры и дефисы, до 40 символов. */
export const slugify: (s: string) => string = mod.slugify;

/** Шрифты стиля; пустой список, если стиль неизвестен. */
export function styleFonts(style: string | null | undefined): readonly string[] {
  return (style && Object.hasOwn(STYLES, style) ? STYLES[style]?.fonts : undefined) ?? [];
}

/** Название события на нужном языке; null, если событие неизвестно. */
export function eventLabel(event: string | null | undefined, lang: DesignLocale): string | null {
  return (event && Object.hasOwn(EVENTS, event) ? EVENTS[event]?.label[lang] : undefined) ?? null;
}
