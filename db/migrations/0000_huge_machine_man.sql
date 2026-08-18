DO $$ BEGIN
 CREATE TYPE "public"."anti_raid_action" AS ENUM('alert_only', 'lock_verification', 'kick_new_joins');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."application_type" AS ENUM('in_server', 'direct_message');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."dm_type" AS ENUM('submission', 'acceptance', 'denial');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."form_kind" AS ENUM('application', 'appeal');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."giveaway_status" AS ENUM('draft', 'scheduled', 'running', 'ended', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."hosting_mode" AS ENUM('shared', 'custom');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."leave_action" AS ENUM('none', 'deny_application');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."match_mode" AS ENUM('has_all', 'has_any');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."permission_level" AS ENUM('owner', 'admin', 'manager');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."poll_status" AS ENUM('draft', 'scheduled', 'published', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."question_type" AS ENUM('short_text', 'paragraph', 'select');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."question_validation_type" AS ENUM('none', 'regex');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."rate_limit_tier" AS ENUM('free', 'tier1', 'tier2', 'custom');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."scheduled_job_kind" AS ENUM('kick_unverified', 'close_poll', 'end_giveaway', 'purge_expired_history');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."submission_status" AS ENUM('pending', 'accepted', 'denied', 'withdrawn');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ticket_channel_type" AS ENUM('private_channel', 'private_thread', 'public_thread');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ticket_leave_action" AS ENUM('none', 'close', 'notify');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ticket_status" AS ENUM('open', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."verification_method" AS ENUM('button', 'captcha');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."ban_subject" AS ENUM('user', 'guild');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."platform_appeal_status" AS ENUM('open', 'accepted', 'denied', 'withdrawn');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"question_id" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anti_raid_configs" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"join_threshold" integer DEFAULT 10 NOT NULL,
	"window_seconds" integer DEFAULT 60 NOT NULL,
	"action" "anti_raid_action" DEFAULT 'alert_only' NOT NULL,
	"alert_channel_id" bigint,
	"alert_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_lockdown_expires_after_seconds" integer DEFAULT 1800 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appeal_configs" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"form_id" text,
	"dm_on_ban_enabled" boolean DEFAULT true NOT NULL,
	"dm_on_ban_note" text DEFAULT 'You have been banned and are receiving this message because ban appeals are enabled for this server. If you''d like to appeal, answer the questions below. Sending nothing will not appeal the ban.',
	"auto_unban_on_accept" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dashboard_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"action" varchar(50) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" text,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_application_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"applicant_id" bigint NOT NULL,
	"guild_id" bigint NOT NULL,
	"current_question_index" integer DEFAULT 0 NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"type" "dm_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"title" varchar(256),
	"body" text NOT NULL,
	"color" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text DEFAULT '',
	"application_type" "application_type" DEFAULT 'in_server' NOT NULL,
	"kind" "form_kind" DEFAULT 'application' NOT NULL,
	"log_channel_id" bigint NOT NULL,
	"accepted_channel_id" bigint,
	"denied_channel_id" bigint,
	"grant_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remove_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_grant_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deny_remove_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remove_roles_on_submit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ping_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"leave_action" "leave_action" DEFAULT 'none' NOT NULL,
	"required_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_roles_match_mode" "match_mode" DEFAULT 'has_all' NOT NULL,
	"blacklisted_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blacklisted_roles_match_mode" "match_mode" DEFAULT 'has_all' NOT NULL,
	"cooldown_seconds" integer DEFAULT 0 NOT NULL,
	"max_total_submissions" integer,
	"max_submissions_window_seconds" integer,
	"max_submissions_in_window" integer,
	"time_limit_seconds" integer,
	"allow_multiple_pending" boolean DEFAULT false NOT NULL,
	"thread_collab_enabled" boolean DEFAULT true NOT NULL,
	"thread_name" varchar(100) DEFAULT 'Review: {username}',
	"auto_archive_on_decision" boolean DEFAULT true NOT NULL,
	"hide_answers_in_embed" boolean DEFAULT false NOT NULL,
	"confirmation_message" text DEFAULT 'Are you sure you want to apply? Once you start, you''ll be asked a series of questions.',
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gate_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"applicant_id" bigint NOT NULL,
	"granted_by" bigint NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "giveaway_entries" (
	"giveaway_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaway_entries_giveaway_id_user_id_pk" PRIMARY KEY("giveaway_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "giveaways" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"prize" varchar(256) NOT NULL,
	"winner_count" integer DEFAULT 1 NOT NULL,
	"required_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blacklisted_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bonus_role_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "giveaway_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"winner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"host_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guilds" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"icon_hash" text,
	"owner_id" bigint NOT NULL,
	"rate_limit_tier" "rate_limit_tier" DEFAULT 'free' NOT NULL,
	"custom_rate_limits" jsonb,
	"hosting_mode" "hosting_mode" DEFAULT 'shared' NOT NULL,
	"custom_billing_renews_at" timestamp with time zone,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "panel_buttons" (
	"id" text PRIMARY KEY NOT NULL,
	"panel_id" text NOT NULL,
	"form_id" text NOT NULL,
	"label" varchar(80) NOT NULL,
	"emoji" varchar(64),
	"style" varchar(16) DEFAULT 'primary' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "panels" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"title" varchar(256) NOT NULL,
	"description" text DEFAULT '',
	"color" integer DEFAULT 5793266,
	"image_url" text,
	"thumbnail_url" text,
	"footer_text" varchar(256),
	"display_type" varchar(16) DEFAULT 'buttons' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poll_votes" (
	"poll_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"option_id" text NOT NULL,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_poll_id_user_id_option_id_pk" PRIMARY KEY("poll_id","user_id","option_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "polls" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"question" varchar(300) NOT NULL,
	"options" jsonb NOT NULL,
	"allow_multiselect" boolean DEFAULT false NOT NULL,
	"status" "poll_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"label" varchar(200) NOT NULL,
	"placeholder" varchar(100),
	"type" "question_type" DEFAULT 'short_text' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"min_length" integer,
	"max_length" integer,
	"options" jsonb,
	"validation_type" "question_validation_type" DEFAULT 'none' NOT NULL,
	"validation_pattern" varchar(256),
	"validation_error_message" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quick_response_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quick_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"category_id" text,
	"title" varchar(100) NOT NULL,
	"body" text NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raid_lockdowns" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_by_join_count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cleared_by" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_menu_options" (
	"id" text PRIMARY KEY NOT NULL,
	"menu_id" text NOT NULL,
	"role_id" bigint NOT NULL,
	"label" varchar(100) NOT NULL,
	"emoji" varchar(64),
	"description" varchar(100),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_menus" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"title" varchar(256) DEFAULT 'Choose your roles' NOT NULL,
	"description" text DEFAULT '',
	"selection_mode" varchar(16) DEFAULT 'multi' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "scheduled_job_kind" NOT NULL,
	"guild_id" bigint NOT NULL,
	"subject_id" bigint,
	"payload" jsonb,
	"run_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" varchar(64),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"role_id" bigint,
	"user_id" bigint,
	"level" "permission_level" DEFAULT 'manager' NOT NULL,
	"form_id" text,
	"can_review" boolean DEFAULT true NOT NULL,
	"can_manage_form" boolean DEFAULT false NOT NULL,
	"can_manage_panel" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sticky_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"content" text NOT NULL,
	"last_message_id" bigint,
	"repost_after_messages" integer DEFAULT 5 NOT NULL,
	"messages_since_repost" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticky_messages_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"guild_id" bigint NOT NULL,
	"applicant_id" bigint NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"log_message_id" bigint,
	"thread_id" bigint,
	"reviewer_id" bigint,
	"review_reason" text,
	"reviewed_at" timestamp with time zone,
	"completion_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" varchar(100) NOT NULL,
	"button_label" varchar(80) DEFAULT 'Open Ticket' NOT NULL,
	"button_emoji" varchar(64),
	"channel_id" bigint NOT NULL,
	"category_id" bigint,
	"channel_type" "ticket_channel_type" DEFAULT 'private_channel' NOT NULL,
	"support_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ping_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"welcome_message" text DEFAULT 'Thanks for opening a ticket. A member of staff will be with you shortly.',
	"ticket_name_format" varchar(100) DEFAULT 'ticket-{username}' NOT NULL,
	"max_open_per_user" integer DEFAULT 1 NOT NULL,
	"leave_action" "ticket_leave_action" DEFAULT 'none' NOT NULL,
	"transcript_on_close" boolean DEFAULT true NOT NULL,
	"transcript_channel_id" bigint,
	"creator_can_close" boolean DEFAULT true NOT NULL,
	"claiming_enabled" boolean DEFAULT false NOT NULL,
	"rating_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"guild_id" bigint NOT NULL,
	"opener_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"claimed_by" bigint,
	"closed_by" bigint,
	"close_reason" text,
	"transcript_url" text,
	"rating" integer,
	"rating_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"challenge_code" varchar(12),
	"verified" boolean DEFAULT false NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_configs" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" bigint,
	"message_id" bigint,
	"method" "verification_method" DEFAULT 'button' NOT NULL,
	"verified_role_id" bigint,
	"unverified_role_id" bigint,
	"panel_title" varchar(256) DEFAULT 'Verification' NOT NULL,
	"panel_description" text DEFAULT 'Click the button below to verify and gain access to the server.',
	"kick_unverified_after_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "welcomer_configs" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"join_enabled" boolean DEFAULT false NOT NULL,
	"join_channel_id" bigint,
	"join_message" text DEFAULT 'Welcome to {guild}, {username}! You are member #{membercount}.',
	"join_dm_enabled" boolean DEFAULT false NOT NULL,
	"join_dm_message" text,
	"join_embed_color" integer DEFAULT 5793266,
	"join_image_url" text,
	"auto_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"leave_enabled" boolean DEFAULT false NOT NULL,
	"leave_channel_id" bigint,
	"leave_message" text DEFAULT '{username} has left {guild}.',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_ban_appeals" (
	"id" text PRIMARY KEY NOT NULL,
	"ban_id" text NOT NULL,
	"appellant_id" bigint NOT NULL,
	"body" text NOT NULL,
	"status" "platform_appeal_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" bigint,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_bans" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" "ban_subject" NOT NULL,
	"subject_id" bigint NOT NULL,
	"reason_code" text NOT NULL,
	"reason_public" text NOT NULL,
	"notes" text,
	"evidence" jsonb,
	"actor_id" bigint NOT NULL,
	"automated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" bigint,
	"revoke_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "answers" ADD CONSTRAINT "answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "anti_raid_configs" ADD CONSTRAINT "anti_raid_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeal_configs" ADD CONSTRAINT "appeal_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeal_configs" ADD CONSTRAINT "appeal_configs_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_application_progress" ADD CONSTRAINT "dm_application_progress_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_templates" ADD CONSTRAINT "dm_templates_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "forms" ADD CONSTRAINT "forms_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gate_overrides" ADD CONSTRAINT "gate_overrides_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "panel_buttons" ADD CONSTRAINT "panel_buttons_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "panel_buttons" ADD CONSTRAINT "panel_buttons_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "panels" ADD CONSTRAINT "panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "polls" ADD CONSTRAINT "polls_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quick_response_categories" ADD CONSTRAINT "quick_response_categories_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quick_responses" ADD CONSTRAINT "quick_responses_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quick_responses" ADD CONSTRAINT "quick_responses_category_id_quick_response_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."quick_response_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raid_lockdowns" ADD CONSTRAINT "raid_lockdowns_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_menu_options" ADD CONSTRAINT "role_menu_options_menu_id_role_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."role_menus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_permissions" ADD CONSTRAINT "staff_permissions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_permissions" ADD CONSTRAINT "staff_permissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sticky_messages" ADD CONSTRAINT "sticky_messages_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "submissions" ADD CONSTRAINT "submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_configs" ADD CONSTRAINT "ticket_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tickets" ADD CONSTRAINT "tickets_config_id_ticket_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ticket_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_configs" ADD CONSTRAINT "verification_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "welcomer_configs" ADD CONSTRAINT "welcomer_configs_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_ban_appeals" ADD CONSTRAINT "platform_ban_appeals_ban_id_platform_bans_id_fk" FOREIGN KEY ("ban_id") REFERENCES "public"."platform_bans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_submission_idx" ON "answers" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dashboard_audit_guild_created_idx" ON "dashboard_audit_logs" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_progress_form_applicant_idx" ON "dm_application_progress" USING btree ("form_id","applicant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_progress_expires_idx" ON "dm_application_progress" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_template_form_type_idx" ON "dm_templates" USING btree ("form_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_guild_idx" ON "forms" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gate_override_form_applicant_idx" ON "gate_overrides" USING btree ("form_id","applicant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "giveaway_guild_idx" ON "giveaways" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "giveaway_status_ends_idx" ON "giveaways" USING btree ("status","ends_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "panel_button_panel_idx" ON "panel_buttons" USING btree ("panel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "panel_button_unique" ON "panel_buttons" USING btree ("panel_id","form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "panel_guild_idx" ON "panels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_guild_idx" ON "polls" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_status_scheduled_idx" ON "polls" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_form_idx" ON "questions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quick_response_category_guild_idx" ON "quick_response_categories" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quick_response_guild_idx" ON "quick_responses" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quick_response_category_idx" ON "quick_responses" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_menu_option_menu_idx" ON "role_menu_options" USING btree ("menu_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_menu_option_unique" ON "role_menu_options" USING btree ("menu_id","role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_menu_guild_idx" ON "role_menus" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_job_due_idx" ON "scheduled_jobs" USING btree ("run_at","claimed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_job_guild_idx" ON "scheduled_jobs" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_job_unique_pending" ON "scheduled_jobs" USING btree ("kind","guild_id","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_perm_guild_idx" ON "staff_permissions" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_perm_form_idx" ON "staff_permissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sticky_message_guild_idx" ON "sticky_messages" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_form_idx" ON "submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_applicant_idx" ON "submissions" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_status_idx" ON "submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_form_applicant_created_idx" ON "submissions" USING btree ("form_id","applicant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_config_guild_idx" ON "ticket_configs" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_config_idx" ON "tickets" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_opener_idx" ON "tickets" USING btree ("opener_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_config_opener_status_idx" ON "tickets" USING btree ("config_id","opener_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_attempt_guild_user_idx" ON "verification_attempts" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ban_appeals_one_open" ON "platform_ban_appeals" USING btree ("ban_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ban_appeals_triage_idx" ON "platform_ban_appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ban_appeals_appellant_idx" ON "platform_ban_appeals" USING btree ("appellant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_bans_active_uniq" ON "platform_bans" USING btree ("subject","subject_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_bans_expiry_idx" ON "platform_bans" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_bans_subject_idx" ON "platform_bans" USING btree ("subject","subject_id");