ALTER TABLE "forms" ADD COLUMN "gate_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "gate_reset_by" bigint;