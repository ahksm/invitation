import { z } from "zod";
import type { Ctx } from "../context.js";
import { EVENTS } from "../design-data.js";
import { HttpError } from "../errors.js";
import { locales, type Locale } from "../i18n.js";
import { track } from "./usage.js";

/**
 * Помощник с текстом приглашения (кнопка «Написать с ИИ» в конструкторе): Anthropic Messages API
 * с тем же промптом, что aiWrite в дизайне. Без ANTHROPIC_API_KEY выключен (503), и тогда фронтенд
 * берёт готовые тексты дизайна. Лимиты на пользователя: 10 запросов в минуту и 50 в сутки.
 */
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 400;
const TIMEOUT_MS = 30_000;
const PER_MINUTE = 10;
const PER_DAY = 50;

export const aiTones = ["warm", "formal", "playful", "poetic", "short"] as const;
export type AiTone = (typeof aiTones)[number];

// Управляющие символы и переводы строк из полей формы в промпт не попадают.
const field = (max: number) =>
  z
    .string()
    .max(max)
    .default("")
    .transform((s) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim());

export const aiWriteSchema = z.strictObject({
  lang: z.enum(locales),
  tone: z.enum(aiTones),
  event: z.string().refine((e) => Object.hasOwn(EVENTS, e), "Неизвестное событие"),
  names: field(200),
  host: field(200),
  date: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(""),
  time: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).default(""),
  venue: field(200),
});
export type AiWriteInput = z.output<typeof aiWriteSchema>;

const LANGUAGE: Record<Locale, string> = { ru: "Russian", en: "English", uz: "Uzbek in Latin script", uzc: "Uzbek in Cyrillic script" };
const TONE: Record<AiTone, string> = {
  warm: "warm and personal",
  formal: "formal and elegant",
  playful: "playful and fun",
  poetic: "poetic and lyrical",
  short: "very short, one sentence",
};

/** Промпт из aiWrite в web/Invito.dc.html. */
export function aiPrompt(i: AiWriteInput): string {
  return `Write the main text of an invitation in ${LANGUAGE[i.lang]}. Event: ${EVENTS[i.event]!.label.en}. Title/names: ${i.names}. From: ${i.host}. Date: ${i.date} ${i.time}. Venue: ${i.venue}. Tone: ${TONE[i.tone]}. 2–3 sentences max (unless asked shorter). Address the guest directly. Do not repeat the date or address. No quotes, no emoji, no greeting line, no signature. Return only the text.`;
}

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
});

export async function aiWrite(ctx: Pick<Ctx, "config" | "cache" | "db" | "log">, userId: string, input: AiWriteInput): Promise<{ text: string }> {
  const key = ctx.config.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, "Помощник с текстом сейчас недоступен");
  if (await ctx.cache.hit(`ai:minute:${userId}`, PER_MINUTE, 60)) throw new HttpError(429, "Слишком много запросов к помощнику, попробуйте через минуту");
  if (await ctx.cache.hit(`ai:day:${userId}`, PER_DAY, 24 * 3600)) throw new HttpError(429, "Помощник на сегодня исчерпал лимит, попробуйте завтра");

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
      body: JSON.stringify({
        model: ctx.config.AI_MODEL,
        max_tokens: MAX_TOKENS,
        // Думать над двумя-тремя предложениями долго не нужно: размышления тоже расходуют max_tokens.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: aiPrompt(input) }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    ctx.log.warn({ err }, "помощник с текстом: нет ответа от Anthropic");
    throw new HttpError(502, "Помощник не смог написать текст, попробуйте ещё раз");
  }
  if (!res.ok) {
    // Тело ошибки содержит только тип и описание, ключа в нём нет.
    const detail = await res.text().catch(() => "");
    ctx.log.warn({ status: res.status, detail: detail.slice(0, 500) }, "помощник с текстом: ошибка Anthropic");
    throw new HttpError(502, "Помощник не смог написать текст, попробуйте ещё раз");
  }
  const parsed = responseSchema.safeParse(await res.json().catch(() => null));
  // refusal и max_tokens: ответа нет или он оборван на полуслове.
  const stop = parsed.success ? parsed.data.stop_reason : "invalid";
  const text = parsed.success
    ? parsed.data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim()
        .replace(/^["«“]|["»”]$/g, "")
        .trim()
    : "";
  if (!text || stop === "refusal" || stop === "max_tokens") {
    ctx.log.warn({ stop }, "помощник с текстом: пустой или оборванный ответ");
    throw new HttpError(502, "Помощник не смог написать текст, попробуйте ещё раз");
  }
  await track(ctx, userId, "ai_write", { lang: input.lang, tone: input.tone });
  // Как поле message в InvContent.
  return { text: text.slice(0, 3000) };
}
