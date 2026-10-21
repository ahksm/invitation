import { z } from "zod";

/**
 * Правила оплаты:
 * - бесплатный доступ (выдан владельцем) и админы: всё бесплатно;
 * - общий шаблон («одно приглашение для всех»): оплата за шаблон;
 * - персональные приглашения: оплата за каждого гостя (место);
 * - подписка: любой шаблон без оплаты, но места оплачиваются отдельно.
 *
 * Все суммы в минимальных единицах валюты (для UZS это тийины: 1 сум = 100).
 */
export const pricesSchema = z.object({
  sharedTemplate: z.number().int().min(0),
  seat: z.number().int().min(0),
  subscriptionMonth: z.number().int().min(0),
});
export type Prices = z.infer<typeof pricesSchema>;

export const defaultPrices: Prices = {
  sharedTemplate: 50_000_00,
  seat: 5_000_00,
  subscriptionMonth: 150_000_00,
};

export type Access = { free: boolean; subscribed: boolean };

export function accessFor(user: { freeAccess: boolean; isAdmin: boolean }, hasActiveSubscription: boolean): Access {
  return { free: user.freeAccess || user.isAdmin, subscribed: hasActiveSubscription };
}

export function templatePrice(template: { price: number | null }, prices: Prices): number {
  return template.price ?? prices.sharedTemplate;
}

/** Сколько стоит открыть общий шаблон. */
export function quoteTemplate(access: Access, template: { price: number | null }, prices: Prices): number {
  if (access.free || access.subscribed) return 0;
  return templatePrice(template, prices);
}

/** Сколько стоят дополнительные персональные места. Подписка места не покрывает. */
export function quoteSeats(access: Access, seats: number, prices: Prices): number {
  if (!Number.isInteger(seats) || seats <= 0) throw new Error("Количество мест должно быть положительным целым");
  if (access.free) return 0;
  return seats * prices.seat;
}

export function quoteSubscription(months: number, prices: Prices): number {
  if (!Number.isInteger(months) || months <= 0 || months > 12) throw new Error("Подписка оформляется на 1–12 месяцев");
  return months * prices.subscriptionMonth;
}

/** Новый срок подписки: продлевается от текущего окончания, если она ещё активна. */
export function extendSubscription(now: Date, currentEnd: Date | null, months: number): { startsAt: Date; endsAt: Date } {
  const startsAt = currentEnd && currentEnd > now ? currentEnd : now;
  const endsAt = new Date(startsAt);
  endsAt.setUTCMonth(endsAt.getUTCMonth() + months);
  return { startsAt, endsAt };
}
