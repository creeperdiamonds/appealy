DO $$ BEGIN
 CREATE TYPE "public"."outcome_decision" AS ENUM('accept', 'deny');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "form_outcome_label_uniq";--> statement-breakpoint
ALTER TABLE "form_outcomes" ADD COLUMN "decision" "outcome_decision" DEFAULT 'accept' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_outcome_label_uniq" ON "form_outcomes" USING btree ("form_id","decision","label");