CREATE TABLE IF NOT EXISTS "update_subscriptions" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"webhook_id" bigint NOT NULL,
	"followed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "update_subscriptions" ADD CONSTRAINT "update_subscriptions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
