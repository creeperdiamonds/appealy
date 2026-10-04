CREATE TABLE IF NOT EXISTS "moderation_configs" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"text_commands_enabled" boolean DEFAULT true NOT NULL,
	"prefix" varchar(5) DEFAULT '?' NOT NULL,
	"allowed_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "temp_bans" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"unban_at" timestamp with time zone NOT NULL,
	"banned_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "moderation_configs" ADD CONSTRAINT "moderation_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "temp_bans" ADD CONSTRAINT "temp_bans_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "temp_bans_guild_user_idx" ON "temp_bans" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "temp_bans_unban_at_idx" ON "temp_bans" USING btree ("unban_at");