import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./index.js";
import { templates, type TemplateField } from "./schema.js";

const coverFields: TemplateField[] = [
  { key: "hosts", label: { ru: "Кто приглашает", uz: "Kim taklif qilmoqda", en: "Hosts" }, type: "text", required: true },
  { key: "event", label: { ru: "Событие", uz: "Tadbir", en: "Event" }, type: "text", required: true },
  { key: "date", label: { ru: "Дата", uz: "Sana", en: "Date" }, type: "date", required: true },
  { key: "time", label: { ru: "Время", uz: "Vaqt", en: "Time" }, type: "time" },
  { key: "venue", label: { ru: "Место", uz: "Joy", en: "Venue" }, type: "text", required: true },
  { key: "address", label: { ru: "Адрес", uz: "Manzil", en: "Address" }, type: "textarea" },
  { key: "mapUrl", label: { ru: "Ссылка на карту", uz: "Xarita havolasi", en: "Map link" }, type: "url" },
  { key: "message", label: { ru: "Текст приглашения", uz: "Taklif matni", en: "Invitation text" }, type: "textarea" },
];

/** Базовые шаблоны. Повторный запуск ничего не дублирует. */
export async function seed(db: Db) {
  await db
    .insert(templates)
    .values({
      slug: "invite-cover",
      title: "Обложка приглашения",
      description: "Шаблон по дизайну InviteCover из Claude Design",
      fields: coverFields,
      translations: {
        uz: { title: "Taklifnoma muqovasi", description: "Claude Design dagi InviteCover dizayni asosidagi shablon" },
        en: { title: "Invitation cover", description: "Template based on the InviteCover design from Claude Design" },
      },
    })
    .onConflictDoNothing({ target: templates.slug });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
  await seed(db);
  await pool.end();
  console.log("Шаблоны добавлены");
}
