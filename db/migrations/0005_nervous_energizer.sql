ALTER TABLE "forms" ADD COLUMN "reviewer_whitelist_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "reviewer_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "reviewer_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;