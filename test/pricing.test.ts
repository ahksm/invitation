import { describe, expect, it } from "vitest";
import { accessFor, defaultPrices, extendSubscription, quoteSeats, quoteSubscription, quoteTemplate } from "../src/pricing.js";

const prices = defaultPrices;
const paying = accessFor({ freeAccess: false, isAdmin: false }, false);
const subscribed = accessFor({ freeAccess: false, isAdmin: false }, true);
const free = accessFor({ freeAccess: true, isAdmin: false }, false);
const admin = accessFor({ freeAccess: false, isAdmin: true }, false);

describe("тарифы", () => {
  it("общий шаблон платный без подписки", () => {
    expect(quoteTemplate(paying, { price: null }, prices)).toBe(prices.sharedTemplate);
    expect(quoteTemplate(paying, { price: 777 }, prices)).toBe(777);
  });

  it("подписка открывает шаблоны, но не места", () => {
    expect(quoteTemplate(subscribed, { price: 777 }, prices)).toBe(0);
    expect(quoteSeats(subscribed, 3, prices)).toBe(3 * prices.seat);
  });

  it("бесплатный доступ и админ ничего не платят", () => {
    for (const a of [free, admin]) {
      expect(quoteTemplate(a, { price: 777 }, prices)).toBe(0);
      expect(quoteSeats(a, 10, prices)).toBe(0);
    }
  });

  it("персональные приглашения оплачиваются за каждого гостя", () => {
    expect(quoteSeats(paying, 7, prices)).toBe(7 * prices.seat);
    expect(() => quoteSeats(paying, 0, prices)).toThrow();
  });

  it("подписка считается по месяцам и продлевается от конца текущей", () => {
    expect(quoteSubscription(3, prices)).toBe(3 * prices.subscriptionMonth);
    expect(() => quoteSubscription(13, prices)).toThrow();
    const now = new Date("2026-01-10T00:00:00Z");
    expect(extendSubscription(now, null, 1).endsAt.toISOString()).toBe("2026-02-10T00:00:00.000Z");
    const end = new Date("2026-01-20T00:00:00Z");
    expect(extendSubscription(now, end, 1)).toEqual({ startsAt: end, endsAt: new Date("2026-02-20T00:00:00Z") });
  });
});
