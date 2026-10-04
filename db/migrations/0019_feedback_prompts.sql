CREATE TABLE IF NOT EXISTS "feedback_prompt_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_prompts" (
	"user_id" bigint NOT NULL,
	"round" varchar(32) NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_prompt_settings" ADD CONSTRAINT "feedback_prompt_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_prompts_user_round_idx" ON "feedback_prompts" USING btree ("user_id","round");