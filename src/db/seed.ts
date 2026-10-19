import { and, eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { TEMPLATES } from "../design-data.js";
import { createDb, type Db } from "./index.js";
import { templates } from "./schema.js";

/** Шаблон до Invito: остаётся в базе ради старых приглашений, но новые на нём не создаются. */
export const LEGACY_TEMPLATE_SLUG = "invite-cover";

/**
 * Каталог шаблонов Invito: 60 строк из TEMPLATES (web/invito-data.js), slug = "<event>-<style>".
 * Повторный запуск ничего не дублирует: название, событие, стиль и порядок берутся из дизайна,
 * а цену и флаги (isActive, smsEnabled), которые меняет админ, сид не трогает.
 */
export async function seed(db: Db) {
  const rows = TEMPLATES.map((t, i) => ({ slug: t.id, title: t.name, event: t.event, style: t.style, sortOrder: i }));
  await db.transaction(async (tx) => {
    await tx
      .insert(templates)
      .values(rows)
      .onConflictDoUpdate({
        target: templates.slug,
        set: { title: sql`excluded.title`, event: sql`excluded.event`, style: sql`excluded.style`, sortOrder: sql`excluded.sort_order` },
        // Без изменений строку не трогаем, чтобы updated_at показывал настоящие правки.
        setWhere: sql`("templates"."title", "templates"."event", "templates"."style", "templates"."sort_order")
          is distinct from (excluded.title, excluded.event, excluded.style, excluded.sort_order)`,
      });
    await tx
      .update(templates)
      .set({ isActive: false })
      .where(and(eq(templates.slug, LEGACY_TEMPLATE_SLUG), eq(templates.isActive, true)));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
  await seed(db);
  await pool.end();
  console.log("Шаблоны добавлены");
}
