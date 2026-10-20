import { eq } from "drizzle-orm";
import { z } from "zod";
import { cacheKeys } from "../cache.js";
import type { Ctx } from "../context.js";
import { settings } from "../db/schema.js";
import { defaultPrices, pricesSchema, type Prices } from "../pricing.js";

const PRICES_KEY = "prices";
const LEGAL_KEY = "legal";

export async function getPrices(ctx: Pick<Ctx, "db" | "cache">): Promise<Prices> {
  return ctx.cache.wrap(`${cacheKeys.settings}:${PRICES_KEY}`, 300, async () => {
    const [row] = await ctx.db.select().from(settings).where(eq(settings.key, PRICES_KEY));
    const parsed = pricesSchema.safeParse(row?.value);
    return parsed.success ? parsed.data : defaultPrices;
  });
}

export async function setPrices(ctx: Pick<Ctx, "db" | "cache">, prices: Prices): Promise<Prices> {
  const value = pricesSchema.parse(prices);
  await ctx.db
    .insert(settings)
    .values({ key: PRICES_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  await ctx.cache.invalidate(`${cacheKeys.settings}:${PRICES_KEY}`);
  return value;
}

// Значение в одну строку: пробелы и переводы строк схлопываются, края обрезаются; пусто — не задано.
const line = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(max))
    .default("");

/** Имя пользователя Telegram из «@name», «name» или ссылки t.me/name. */
const telegramName = (s: string) =>
  s
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");

/**
 * Реквизиты и контакты владельца для страниц /oferta, /privacy и /contacts (их требует Multicard).
 * Все поля необязательны: страницы выводят только заполненные. Telegram хранится без @ и ссылки.
 */
const legalShape = {
  companyName: line(200),
  inn: line(20),
  address: line(300),
  phone: line(40),
  email: line(120).refine((v) => v === "" || z.email().safeParse(v).success, "Email: адрес вида name@example.com"),
  telegram: line(64)
    .transform(telegramName)
    .refine((v) => v === "" || /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v), "Telegram: имя пользователя, например @invito_support"),
  bankName: line(200),
  bankAccount: line(40),
  mfo: line(20),
  director: line(200),
};
export const legalSchema = z.strictObject(legalShape);
export type Legal = z.infer<typeof legalSchema>;
// Чтение сохранённой записи терпит лишние ключи (например, поле, которое потом убрали из схемы).
const storedLegalSchema = z.object(legalShape);

export const emptyLegal: Legal = legalSchema.parse({});

/** Реквизиты из настроек; запись, которая не проходит схему, считается пустой. */
export async function getLegal(ctx: Pick<Ctx, "db" | "cache">): Promise<Legal> {
  return ctx.cache.wrap(`${cacheKeys.settings}:${LEGAL_KEY}`, 300, async () => {
    const [row] = await ctx.db.select().from(settings).where(eq(settings.key, LEGAL_KEY));
    const parsed = storedLegalSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : emptyLegal;
  });
}

export async function setLegal(ctx: Pick<Ctx, "db" | "cache">, legal: z.input<typeof legalSchema>): Promise<Legal> {
  const value = legalSchema.parse(legal);
  await ctx.db
    .insert(settings)
    .values({ key: LEGAL_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  await ctx.cache.invalidate(`${cacheKeys.settings}:${LEGAL_KEY}`);
  return value;
}
