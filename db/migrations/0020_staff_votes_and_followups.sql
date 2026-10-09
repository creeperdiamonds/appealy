CREATE TABLE IF NOT EXISTS "submission_followups" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"guild_id" bigint NOT NULL,
	"asker_id" bigint NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "submission_votes" (
	"submission_id" text NOT NULL,
	"voter_id" bigint NOT NULL,
	"vote" varchar(8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_votes_submission_id_voter_id_pk" PRIMARY KEY("submission_id","voter_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "submission_followups" ADD CONSTRAINT "submission_followups_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "submission_votes" ADD CONSTRAINT "submission_votes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_followup_submission_idx" ON "submission_followups" USING btree ("submission_id");