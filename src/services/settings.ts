import { eq } from "drizzle-orm";
import { cacheKeys } from "../cache.js";
import type { Ctx } from "../context.js";
import { settings } from "../db/schema.js";
import { defaultPrices, pricesSchema, type Prices } from "../pricing.js";

const PRICES_KEY = "prices";

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
  await ctx.cache.del(`${cacheKeys.settings}:${PRICES_KEY}`);
  return value;
}
