import { Redis } from "ioredis";

export type Cache = ReturnType<typeof createCache>;

export function createCache(redis: Redis, prefix = "inv:") {
  const k = (key: string) => prefix + key;

  return {
    redis,

    async get<T>(key: string): Promise<T | undefined> {
      const raw = await redis.get(k(key));
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },

    async set(key: string, value: unknown, ttlSeconds: number) {
      await redis.set(k(key), JSON.stringify(value), "EX", ttlSeconds);
    },

    async del(...keys: string[]) {
      if (keys.length) await redis.del(...keys.map(k));
    },

    /** Читает из кэша, а при промахе вычисляет и сохраняет. null/undefined не кэшируются. */
    async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
      const hit = await this.get<T>(key);
      if (hit !== undefined) return hit;
      const value = await load();
      if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
      return value;
    },

    /** Одноразовое значение: читается и удаляется атомарно. */
    async take<T>(key: string): Promise<T | undefined> {
      const raw = await redis.getdel(k(key));
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },

    /** Счётчик в окне: true, если лимит превышен. */
    async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
      const full = k(`rl:${key}`);
      const count = await redis.incr(full);
      if (count === 1) await redis.expire(full, windowSeconds);
      return count > limit;
    },

    /** Текущее значение счётчика hit() без увеличения. */
    async hits(key: string): Promise<number> {
      return Number((await redis.get(k(`rl:${key}`))) ?? 0);
    },
  };
}

export const cacheKeys = {
  settings: "settings",
  templates: "templates:catalog",
  user: (id: string) => `user:${id}`,
  // Записи публичных страниц (см. src/services/public.ts).
  publicShared: (slug: string) => `public:i:${slug}`,
  publicGuest: (token: string) => `public:g:${token}`,
  loginCode: (code: string) => `login:${code}`,
  multicardToken: "multicard:token",
  eskizToken: "eskiz:token",
  otp: (phone: string) => `otp:${phone}`,
};
