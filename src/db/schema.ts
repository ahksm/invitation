import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";
import type { InvContent } from "../content.js";

export const invitationMode = pgEnum("invitation_mode", ["shared", "personal"]);
export const invitationStatus = pgEnum("invitation_status", ["draft", "active", "archived"]);
export const orderKind = pgEnum("order_kind", ["template", "seats", "subscription"]);
export const orderStatus = pgEnum("order_status", ["pending", "paid", "failed", "cancelled"]);
export const rsvpStatus = pgEnum("rsvp_status", ["pending", "yes", "no", "maybe"]);
// invite и reminder — SMS гостям: вместе ограничены 3 на гостя и paidSeats × 3 на приглашение.
export const smsPurpose = pgEnum("sms_purpose", ["otp", "invite", "reminder"]);
export const smsStatus = pgEnum("sms_status", ["queued", "sent", "delivered", "failed"]);
export const guestGroup = pgEnum("guest_group", ["family", "friends", "work", "other"]);
export const guestSource = pgEnum("guest_source", ["owner", "self"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Вход через Telegram или по номеру телефона: должно быть заполнено хотя бы одно.
    telegramId: bigint("telegram_id", { mode: "number" }).unique(),
    // Номер в формате 998XXXXXXXXX.
    phone: text("phone").unique(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    // Имя изменено в профиле (PATCH /api/auth/me): вход через Telegram и бот его больше не перезаписывают.
    nameEdited: boolean("name_edited").notNull().default(false),
    // Язык интерфейса: ru, uz, uzc или en.
    locale: text("locale").notNull().default("ru"),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Бесплатный доступ ко всей платформе, выдаётся владельцем вручную.
    freeAccess: boolean("free_access").notNull().default(false),
    freeAccessNote: text("free_access_note"),
    blocked: boolean("blocked").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [check("users_identity_check", sql`${t.telegramId} is not null or ${t.phone} is not null`)],
);

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  previewUrl: text("preview_url"),
  // Цена общего шаблона в минимальных единицах валюты; null = цена по умолчанию из настроек.
  price: integer("price"),
  isActive: boolean("is_active").notNull().default(true),
  // Можно ли рассылать приглашения этого шаблона гостям по SMS.
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  // Описание полей, которые заполняет пользователь (название события, дата, место и т.д.).
  fields: jsonb("fields").$type<TemplateField[]>().notNull().default([]),
  // Название и описание на других языках: { uz: { title, description }, uzc: {...}, en: {...} }.
  translations: jsonb("translations").$type<TemplateTranslations>().notNull().default({}),
  // Шаблоны Invito: событие и стиль из web/invito-data.js (slug = "<event>-<style>"). У старых шаблонов пусто.
  event: text("event"),
  style: text("style"),
  // Порядок в каталоге: события по EVENT_ORDER, внутри события по стилям.
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export type TemplateTranslations = Partial<Record<"ru" | "uz" | "uzc" | "en", { title?: string; description?: string }>>;

export type TemplateField = {
  key: string;
  // Подпись поля; можно задать отдельно для каждого языка.
  label: string | Partial<Record<"ru" | "uz" | "uzc" | "en", string>>;
  type: "text" | "textarea" | "date" | "time" | "url";
  required?: boolean;
};

/** Настройки приглашения: напоминания и уведомления бота, число столов в рассадке. */
export type InvitationSettings = { r1d: boolean; r3h: boolean; morning: boolean; notify: boolean; tables: number };
export const defaultInvitationSettings: InvitationSettings = { r1d: true, r3h: true, morning: true, notify: true, tables: 4 };

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    mode: invitationMode("mode").notNull(),
    status: invitationStatus("status").notNull().default("draft"),
    title: text("title").notNull(),
    // Язык, на котором гости видят приглашение и получают SMS.
    language: text("language").notNull().default("ru"),
    // Содержимое приглашения (InvContent, проверяется схемой из src/content.ts).
    data: jsonb("data").$type<InvContent>().notNull().default({}),
    // Публичная ссылка общего приглашения.
    slug: text("slug").notNull().unique(),
    // Общий шаблон оплачен (или открыт подпиской / бесплатным доступом).
    unlocked: boolean("unlocked").notNull().default(false),
    // Сколько персональных мест оплачено.
    paidSeats: integer("paid_seats").notNull().default(0),
    // Номер места для следующего гостя. Номера не переиспользуются, даже после удаления гостя.
    nextSeat: integer("next_seat").notNull().default(1),
    // Пароль общей ссылки; null — без пароля.
    accessCode: text("access_code"),
    settings: jsonb("settings").$type<InvitationSettings>().notNull().default(defaultInvitationSettings),
    // Картинка для превью ссылки (og:image), загружается фронтендом: /media/<id>.<ext>.
    ogImageUrl: text("og_image_url"),
    // Время первой публикации.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("invitations_user_idx").on(t.userId),
    // Напоминания по расписанию раз в минуту ищут опубликованные приглашения по дате события.
    index("invitations_event_date_idx")
      .on(sql`(${t.data} ->> 'date')`)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    // Номер места из invitations.next_seat. Гость оплачен, если его порядковый номер
    // среди текущих гостей (по seat) не больше paid_seats; см. src/services/seats.ts.
    seat: integer("seat").notNull(),
    token: text("token").notNull().unique(),
    rsvp: rsvpStatus("rsvp").notNull().default("pending"),
    group: guestGroup("group").notNull().default("other"),
    // Сколько человек придёт вместе с гостем.
    plus: integer("plus").notNull().default(0),
    // Стол в рассадке; 0 — без стола.
    tableNo: integer("table_no").notNull().default(0),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    // Сообщение гостя хозяевам. В гостевую книгу (видна всем, у кого есть ссылка) попадает, только если
    // гость сам отметил «Показать в гостевой книге» (message_public); иначе его видит только владелец.
    message: text("message"),
    messagePublic: boolean("message_public").notNull().default(false),
    diet: text("diet").array().$type<GuestDiet[]>().notNull().default(sql`'{}'::text[]`),
    // owner — добавил владелец, self — ответил сам по общей ссылке.
    source: guestSource("source").notNull().default("owner"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    // Чат гостя с ботом, если он подключил напоминания.
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("guests_invitation_seat_idx").on(t.invitationId, t.seat)],
);

export const guestDiets = ["veg", "halal", "nonut", "noalc"] as const;
export type GuestDiet = (typeof guestDiets)[number];

// Лента приглашения: открытия, ответы, оплаты, напоминания.
export const invitationEvents = pgTable(
  "invitation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    kind: text("kind").$type<InvitationEventKind>().notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitation_events_inv_idx").on(t.invitationId, t.createdAt)],
);

export const invitationEventKinds = ["created", "published", "paid", "opened", "yes", "no", "maybe", "reminder", "sms", "checkin", "test"] as const;
export type InvitationEventKind = (typeof invitationEventKinds)[number];

// Загруженные файлы (картинки, аудио, видео). Файл лежит в MEDIA_DIR под именем <id>.<ext>.
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MediaKind>().notNull(),
    mime: text("mime").notNull(),
    ext: text("ext").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("media_user_idx").on(t.userId)],
);

export type MediaKind = "image" | "audio" | "video";

// Отправленные напоминания гостям: строка вставляется до отправки, повторная вставка не проходит.
export const guestReminders = pgTable(
  "guest_reminders",
  {
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guestId, t.kind] })],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Короткий числовой номер счёта для платёжной системы.
    number: integer("number").generatedAlwaysAsIdentity({ startWith: 1000 }).notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: orderKind("kind").notNull(),
    invitationId: uuid("invitation_id").references(() => invitations.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(1),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    status: orderStatus("status").notNull().default("pending"),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    checkoutUrl: text("checkout_url"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index("orders_user_idx").on(t.userId), index("orders_status_idx").on(t.status)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("subscriptions_user_idx").on(t.userId, t.endsAt)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

// Все отправленные SMS: коды входа, приглашения и напоминания гостям.
export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: smsPurpose("purpose").notNull(),
    phone: text("phone").notNull(),
    // Текст кода входа не храним, только тексты приглашений.
    text: text("text"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    invitationId: uuid("invitation_id").references(() => invitations.id, { onDelete: "set null" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    status: smsStatus("status").notNull().default("queued"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("sms_guest_idx").on(t.guestId),
    index("sms_invitation_idx").on(t.invitationId),
    index("sms_created_idx").on(t.createdAt),
    index("sms_ref_idx").on(t.providerRef),
  ],
);

// Журнал действий: кто и когда пользовался платформой.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_user_idx").on(t.userId, t.createdAt), index("usage_created_idx").on(t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type SmsMessage = typeof smsMessages.$inferSelect;
export type InvitationEvent = typeof invitationEvents.$inferSelect;
export type Media = typeof media.$inferSelect;
