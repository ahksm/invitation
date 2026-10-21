import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export type Cache = ReturnType<typeof createCache>;

/** Блокировка, взятая через Cache.lock. */
export type Lock = {
  /** Продлевает блокировку ещё на ttl секунд, пока она наша. */
  extend(): Promise<void>;
  /** Снимает блокировку, если она ещё наша (после истечения её мог взять другой). */
  release(): Promise<void>;
};

// Продление и снятие только своей блокировки: значение ключа сверяется с токеном владельца.
const EXTEND_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
// Версии ключей wrap живут дольше любой загрузки значения.
const VERSION_TTL = 3600;

export function createCache(redis: Redis, prefix = "inv:") {
  const k = (key: string) => prefix + key;
  const ver = (key: string) => k(`ver:${key}`);

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

    /**
     * Читает из кэша, а при промахе вычисляет и сохраняет. null/undefined не кэшируются.
     * Если за время загрузки ключ сбросили через invalidate, загруженное значение могло устареть
     * (прочитано до изменения в базе): оно удаляется сразу, а не живёт до конца срока.
     */
    async wrap<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
      const hit = await this.get<T>(key);
      if (hit !== undefined) return hit;
      const version = await redis.get(ver(key));
      const value = await load();
      if (value !== null && value !== undefined) {
        await this.set(key, value, ttlSeconds);
        if ((await redis.get(ver(key))) !== version) await redis.del(k(key));
      }
      return value;
    },

    /**
     * Сбрасывает значения wrap после изменения в базе. Версия ключа растёт до удаления: загрузка,
     * начатая раньше, увидит новую версию и не оставит в кэше старое значение.
     */
    async invalidate(...keys: string[]) {
      if (!keys.length) return;
      const tx = redis.multi();
      for (const key of keys) tx.incr(ver(key)).expire(ver(key), VERSION_TTL);
      tx.del(...keys.map(k));
      await tx.exec();
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

    /** Ставит отметку на ttl секунд; false, если она уже стоит (например, напоминание уже отправлено). */
    async claim(key: string, ttlSeconds: number): Promise<boolean> {
      return (await redis.set(k(key), "1", "EX", ttlSeconds, "NX")) === "OK";
    },

    /** Берёт блокировку на ttl секунд; null, если её уже держит другой запрос. */
    async lock(key: string, ttlSeconds: number): Promise<Lock | null> {
      const full = k(`lock:${key}`);
      const token = randomUUID();
      if ((await redis.set(full, token, "EX", ttlSeconds, "NX")) !== "OK") return null;
      return {
        extend: async () => void (await redis.eval(EXTEND_SCRIPT, 1, full, token, ttlSeconds)),
        release: async () => void (await redis.eval(RELEASE_SCRIPT, 1, full, token)),
      };
    },
  };
}

export const cacheKeys = {
  settings: "settings",
  templates: "templates:catalog",
  user: (id: string) => `user:${id}`,
  // Записи публичных страниц (см. src/services/public.ts). Версия в ключе меняется вместе с составом записи:
  // после выкладки старые записи (v1 — гостевая книга со всеми сообщениями гостей, даже личными) не читаются.
  publicShared: (slug: string) => `public:v2:i:${slug}`,
  publicGuest: (token: string) => `public:v2:g:${token}`,
  loginCode: (code: string) => `login:${code}`,
  multicardToken: "multicard:token",
  eskizToken: "eskiz:token",
  otp: (phone: string) => `otp:${phone}`,
  // Рассылки гостям приглашения (SMS и напоминания) идут по одной.
  sendLock: (invitationId: string) => `send:${invitationId}`,
  // Напоминания по расписанию: один запуск за раз на все процессы.
  remindersLock: "reminders",
  // Удаление файлов, которых нет ни в одном приглашении (src/services/media.ts).
  mediaSweepLock: "media-sweep",
};
