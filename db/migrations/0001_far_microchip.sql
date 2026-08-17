CREATE TABLE IF NOT EXISTS "form_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"emoji" text,
	"grant_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remove_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"log_channel_id" bigint,
	"min_staff_level" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"requires_confirm" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "outcome_id" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "outcome_label" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_outcomes" ADD CONSTRAINT "form_outcomes_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_outcome_form_idx" ON "form_outcomes" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_outcome_label_uniq" ON "form_outcomes" USING btree ("form_id","label");