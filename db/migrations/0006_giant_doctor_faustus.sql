DO $$ BEGIN
 CREATE TYPE "public"."platform_appeal_kind" AS ENUM('appeal', 'apology');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_ban_appeals" ADD COLUMN "kind" "platform_appeal_kind" DEFAULT 'appeal' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ban_appeals_apology_idx" ON "platform_ban_appeals" USING btree ("appellant_id","kind");