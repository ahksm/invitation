ALTER TYPE "public"."sms_purpose" ADD VALUE 'reminder';--> statement-breakpoint
CREATE INDEX "sms_invitation_idx" ON "sms_messages" USING btree ("invitation_id");