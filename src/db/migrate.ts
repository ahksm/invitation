import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./index.js";

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
  await runMigrations(db);
  await pool.end();
  console.log("Миграции применены");
}
