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
  uuid,
} from "drizzle-orm/pg-core";

export const invitationMode = pgEnum("invitation_mode", ["shared", "personal"]);
export const invitationStatus = pgEnum("invitation_status", ["draft", "active", "archived"]);
export const orderKind = pgEnum("order_kind", ["template", "seats", "subscription"]);
export const orderStatus = pgEnum("order_status", ["pending", "paid", "failed", "cancelled"]);
export const rsvpStatus = pgEnum("rsvp_status", ["pending", "yes", "no", "maybe"]);
export const smsPurpose = pgEnum("sms_purpose", ["otp", "invite"]);
export const smsStatus = pgEnum("sms_status", ["queued", "sent", "delivered", "failed"]);

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
    // Язык интерфейса: ru, uz или en.
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
  // Название и описание на других языках: { uz: { title, description }, en: {...} }.
  translations: jsonb("translations").$type<TemplateTranslations>().notNull().default({}),
  ...timestamps,
});

export type TemplateTranslations = Partial<Record<"ru" | "uz" | "en", { title?: string; description?: string }>>;

export type TemplateField = {
  key: string;
  // Подпись поля; можно задать отдельно для каждого языка.
  label: string | Partial<Record<"ru" | "uz" | "en", string>>;
  type: "text" | "textarea" | "date" | "time" | "url";
  required?: boolean;
};

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
    data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
    // Публичная ссылка общего приглашения.
    slug: text("slug").notNull().unique(),
    // Общий шаблон оплачен (или открыт подпиской / бесплатным доступом).
    unlocked: boolean("unlocked").notNull().default(false),
    // Сколько персональных мест оплачено.
    paidSeats: integer("paid_seats").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("invitations_user_idx").on(t.userId)],
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
    // Порядковый номер гостя: ссылка работает, только если seat <= paid_seats.
    seat: integer("seat").notNull(),
    token: text("token").notNull().unique(),
    rsvp: rsvpStatus("rsvp").notNull().default("pending"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("guests_invitation_seat_idx").on(t.invitationId, t.seat)],
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

// Все отправленные SMS: коды входа и приглашения гостям.
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
  (t) => [index("sms_guest_idx").on(t.guestId), index("sms_created_idx").on(t.createdAt), index("sms_ref_idx").on(t.providerRef)],
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
