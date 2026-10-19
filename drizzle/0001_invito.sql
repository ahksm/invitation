CREATE TYPE "public"."guest_group" AS ENUM('family', 'friends', 'work', 'other');--> statement-breakpoint
CREATE TYPE "public"."guest_source" AS ENUM('owner', 'self');--> statement-breakpoint
CREATE TABLE "guest_reminders" (
	"guest_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_reminders_guest_id_kind_pk" PRIMARY KEY("guest_id","kind")
);
--> statement-breakpoint
CREATE TABLE "invitation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"guest_id" uuid,
	"kind" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "group" "guest_group" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "plus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "table_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "diet" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "source" "guest_source" DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "telegram_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "next_seat" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "access_code" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "settings" jsonb DEFAULT '{"r1d":true,"r3h":true,"morning":true,"notify":true,"tables":4}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "og_image_url" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "event" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "style" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_reminders" ADD CONSTRAINT "guest_reminders_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_events" ADD CONSTRAINT "invitation_events_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_events" ADD CONSTRAINT "invitation_events_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_events_inv_idx" ON "invitation_events" USING btree ("invitation_id","created_at");--> statement-breakpoint
CREATE INDEX "media_user_idx" ON "media" USING btree ("user_id");--> statement-breakpoint
-- Данные: счётчик мест продолжает нумерацию существующих гостей.
UPDATE "invitations" SET "next_seat" = coalesce((SELECT max("seat") FROM "guests" WHERE "guests"."invitation_id" = "invitations"."id"), 0) + 1;--> statement-breakpoint
UPDATE "invitations" SET "published_at" = "updated_at" WHERE "status" = 'active';--> statement-breakpoint
UPDATE "guests" SET "responded_at" = coalesce("opened_at", "updated_at") WHERE "rsvp" <> 'pending';
