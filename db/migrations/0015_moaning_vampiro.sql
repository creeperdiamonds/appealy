CREATE TABLE IF NOT EXISTS "submission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"submission_id" text NOT NULL,
	"actor_id" bigint,
	"action" varchar(40) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_event_submission_idx" ON "submission_events" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_event_guild_created_idx" ON "submission_events" USING btree ("guild_id","created_at");