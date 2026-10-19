import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * onError получает ошибки простаивающих соединений (перезапуск Postgres, обрыв сети). Без
 * обработчика события error pg.Pool роняет процесс; пул сам заменит соединение при следующем запросе.
 */
export function createDb(
  url: string,
  onError: (err: Error) => void = (err) => console.error("ошибка соединения с Postgres:", err.message),
): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", onError);
  return { db: drizzle(pool, { schema }), pool };
}
