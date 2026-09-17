CREATE TABLE IF NOT EXISTS "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"used_for" text,
	"annoyance" text,
	"missing" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback" ADD CONSTRAINT "feedback_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_guild_idx" ON "feedback" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_created_idx" ON "feedback" USING btree ("created_at");