DO $$ BEGIN
 CREATE TYPE "public"."poll_engine" AS ENUM('native', 'legacy');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "polls" ADD COLUMN "engine" "poll_engine" DEFAULT 'legacy' NOT NULL;