DO $$ BEGIN
 CREATE TYPE "public"."appeal_kind" AS ENUM('ban', 'timeout', 'restriction');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appeal_notices" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"kind" "appeal_kind" NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_notices_guild_id_user_id_kind_key_pk" PRIMARY KEY("guild_id","user_id","kind","key")
);
--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "timeout_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "timeout_form_id" text;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "timeout_min_seconds" integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "dm_on_timeout_note" text;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "lift_timeout_on_accept" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "restriction_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "restriction_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "restriction_form_id" text;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "dm_on_restriction_note" text;--> statement-breakpoint
ALTER TABLE "appeal_configs" ADD COLUMN "lift_restriction_on_accept" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_application_progress" ADD COLUMN "appeal_kind" "appeal_kind";--> statement-breakpoint
ALTER TABLE "dm_application_progress" ADD COLUMN "appeal_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_application_progress" ADD COLUMN "appeal_timeout_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "appeal_kind" "appeal_kind";--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "appeal_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "appeal_timeout_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeal_notices" ADD CONSTRAINT "appeal_notices_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeal_configs" ADD CONSTRAINT "appeal_configs_timeout_form_id_forms_id_fk" FOREIGN KEY ("timeout_form_id") REFERENCES "public"."forms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeal_configs" ADD CONSTRAINT "appeal_configs_restriction_form_id_forms_id_fk" FOREIGN KEY ("restriction_form_id") REFERENCES "public"."forms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
