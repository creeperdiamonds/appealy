DO $$ BEGIN
 CREATE TYPE "public"."custom_bot_status" AS ENUM('stopped', 'starting', 'running', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "custom_bot_token_enc" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "custom_bot_status" "custom_bot_status" DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "custom_bot_error" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "custom_bot_runner_id" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "custom_bot_heartbeat_at" timestamp with time zone;