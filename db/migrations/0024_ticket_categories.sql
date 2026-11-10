CREATE TABLE IF NOT EXISTS "ticket_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"label" varchar(80) NOT NULL,
	"emoji" varchar(64),
	"description" varchar(100),
	"discord_category_id" bigint,
	"support_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ping_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"welcome_message" text,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ticket_category_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_config_id_ticket_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ticket_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_category_config_idx" ON "ticket_categories" USING btree ("config_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_category_id_ticket_categories_id_fk" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."ticket_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
