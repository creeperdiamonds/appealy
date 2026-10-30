CREATE TABLE IF NOT EXISTS "raid_actions" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"action" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raid_actions_guild_id_user_id_action_pk" PRIMARY KEY("guild_id","user_id","action")
);
--> statement-breakpoint
ALTER TABLE "anti_raid_configs" ADD COLUMN "new_account_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "anti_raid_configs" ADD COLUMN "verification_forced_by_raid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_actions" ADD CONSTRAINT "raid_actions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raid_actions_created_idx" ON "raid_actions" USING btree ("created_at");