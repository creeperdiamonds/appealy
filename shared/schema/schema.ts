// shared/schema/schema.ts
// Single source of truth DB schema, consumed by both bot and api via shared package.
// Drizzle ORM + Postgres.

import {
  pgTable,
  pgEnum,
  text,
  varchar,
  bigint,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const questionTypeEnum = pgEnum("question_type", [
  "short_text",
  "paragraph",
  "select", // maps to a Discord select menu shown as a pre-modal step, since
            // native modals don't support select components; see docs/ARCHITECTURE.md
]);

export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "accepted",
  "denied",
  "withdrawn",
]);

export const dmTypeEnum = pgEnum("dm_type", [
  "submission",
  "acceptance",
  "denial",
]);

export const permissionLevelEnum = pgEnum("permission_level", [
  "owner",
  "admin",
  "manager", // fine-grained, per-form delegation
]);

export const pollStatusEnum = pgEnum("poll_status", [
  "draft",
  "scheduled",
  "published",
  "closed",
]);

export const rateLimitTierEnum = pgEnum("rate_limit_tier", ["free", "tier1", "tier2", "custom"]);

export const hostingModeEnum = pgEnum("hosting_mode", ["shared", "custom"]);

export const leaveActionEnum = pgEnum("leave_action", [
  "none",
  "deny_application",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "closed",
]);

export const ticketChannelTypeEnum = pgEnum("ticket_channel_type", [
  "private_channel",
  "private_thread",
  "public_thread",
]);

export const ticketLeaveActionEnum = pgEnum("ticket_leave_action", [
  "none",
  "close",
  "notify",
]);

export const giveawayStatusEnum = pgEnum("giveaway_status", [
  "draft",
  "scheduled",
  "running",
  "ended",
  "cancelled",
]);

export const verificationMethodEnum = pgEnum("verification_method", [
  "button", // single "I agree / Verify" button, no challenge
  "captcha", // button reveals a text challenge the user must retype
]);

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

export const guilds = pgTable("guilds", {
  id: bigint("id", { mode: "bigint" }).primaryKey(), // Discord snowflake
  name: varchar("name", { length: 100 }).notNull(),
  iconHash: text("icon_hash"),
  ownerId: bigint("owner_id", { mode: "bigint" }).notNull(),
  // --- Billing: two independent axes, see shared/schema/pricing.ts ---
  // Axis A — throughput. All features are available at every tier; only
  // the numeric caps enforced by bot/src/services/rateLimitService.ts
  // change. "custom" reads its actual numbers from customRateLimits below
  // rather than a preset — every field there is still capped by
  // CUSTOM_CAP_MAXIMUMS in pricing.ts, there is no unlimited tier.
  rateLimitTier: rateLimitTierEnum("rate_limit_tier").notNull().default("free"),
  // Only populated (and only read) when rateLimitTier === "custom". Shape
  // matches RateLimitCaps in shared/schema/pricing.ts.
  customRateLimits: jsonb("custom_rate_limits").$type<Record<string, number>>(),
  // Axis B — hosting. "custom" means a dedicated hosted instance of this
  // same open-source bot running under the guild's own bot token, billed
  // annually and unrelated to rateLimitTier — a guild can be on the free
  // throughput tier and still pay for custom hosting, or vice versa.
  hostingMode: hostingModeEnum("hosting_mode").notNull().default("shared"),
  customBillingRenewsAt: timestamp("custom_billing_renews_at", { withTimezone: true }),
  // Tebex's reference for the recurring payment behind the current paid plan.
  //
  // Needed because the subscription lifecycle events — renewed, ended,
  // cancellation requested — identify themselves by this reference and do not
  // necessarily carry back the custom data the original checkout set. Without
  // somewhere to correlate it, a cancellation is a webhook about a
  // subscription we cannot match to a guild, and the plan would simply never
  // end. Null for guilds on the free selection.
  tebexRecurringReference: text("tebex_recurring_reference"),
  // Whether the bot is currently in this guild.
  //
  // A row here means the bot was in the guild at some point, not that it still
  // is — someone can remove it and everything they configured stays, which is
  // deliberate: deleting the row would cascade away every form, panel and
  // submission over a removal that might be a mistake or last five minutes.
  //
  // So presence is a flag rather than the row's existence. guildCreate sets it
  // true, guildDelete sets it false, and the dashboard uses it to say a server
  // needs an invite instead of showing a console that cannot work.
  //
  // Known gap: a removal that happens while the bot is offline emits no
  // guildDelete, so the flag stays true until it is added back. The dashboard
  // would show that server as installed and its requests would fail. Fixing it
  // properly means reconciling the full guild list on every ready burst.
  botPresent: boolean("bot_present").notNull().default(true),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Manager delegation: which roles/users can manage/review which forms without Administrator.
export const staffPermissions = pgTable(
  "staff_permissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    // exactly one of roleId / userId is set
    roleId: bigint("role_id", { mode: "bigint" }),
    userId: bigint("user_id", { mode: "bigint" }),
    level: permissionLevelEnum("level").notNull().default("manager"),
    // null = applies to all forms in guild; otherwise scoped to a specific form
    formId: text("form_id").references(() => forms.id, { onDelete: "cascade" }),
    canReview: boolean("can_review").notNull().default(true),
    canManageForm: boolean("can_manage_form").notNull().default(false),
    canManagePanel: boolean("can_manage_panel").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("staff_perm_guild_idx").on(t.guildId),
    formIdx: index("staff_perm_form_idx").on(t.formId),
  }),
);

// ---------------------------------------------------------------------------
// Panels — a message in a channel with buttons that open forms
// ---------------------------------------------------------------------------

export const panels = pgTable(
  "panels",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }), // null until published
    title: varchar("title", { length: 256 }).notNull(),
    description: text("description").default(""),
    color: integer("color").default(0x5865f2),
    imageUrl: text("image_url"),
    thumbnailUrl: text("thumbnail_url"),
    footerText: varchar("footer_text", { length: 256 }),
    // "buttons": one Discord button per attached form. "dropdown": a single
    // select menu listing all attached forms (up to 25). Both are available
    // to every guild regardless of billing tier — this project only charges
    // for throughput (see shared/schema/pricing.ts), never individual
    // features.
    displayType: varchar("display_type", { length: 16 }).notNull().default("buttons"),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("panel_guild_idx").on(t.guildId),
  }),
);

// Join table: which forms are attached to a panel, and button label/style/order.
export const panelButtons = pgTable(
  "panel_buttons",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    panelId: text("panel_id")
      .notNull()
      .references(() => panels.id, { onDelete: "cascade" }),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 80 }).notNull(),
    emoji: varchar("emoji", { length: 64 }),
    style: varchar("style", { length: 16 }).notNull().default("primary"), // primary|secondary|success|danger
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    panelIdx: index("panel_button_panel_idx").on(t.panelId),
    uniqueFormPerPanel: uniqueIndex("panel_button_unique").on(t.panelId, t.formId),
  }),
);

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const matchModeEnum = pgEnum("match_mode", ["has_all", "has_any"]);

export const applicationTypeEnum = pgEnum("application_type", ["in_server", "direct_message"]);

export const formKindEnum = pgEnum("form_kind", ["application", "appeal"]);

export const forms = pgTable(
  "forms",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description").default(""),
    // "in_server": the existing button/modal flow, requires the applicant
    // to be actively in the guild interacting with a panel or /apply.
    // "direct_message": the bot DMs the applicant the questions one at a
    // time and collects answers there — see
    // bot/src/services/dmApplicationService.ts for why this needs a
    // different delivery mechanism than modals (DMs can't show a Discord
    // Modal; the bot has to run a message-based back-and-forth instead).
    applicationType: applicationTypeEnum("application_type").notNull().default("in_server"),
    // "appeal" forms are only ever reached via the ban-time DM flow (see the
    // appealConfigs comment below) — never a panel or /apply, since a banned
    // user can see neither. Enforced at the API layer that kind = "appeal"
    // always implies applicationType = "direct_message".
    kind: formKindEnum("kind").notNull().default("application"),
    // Per-outcome log channels, replacing the old single logChannelId.
    // logChannelId is kept as the PENDING-submission channel (existing
    // rows/behavior are unaffected — pending was always where new
    // submissions posted); acceptedChannelId/deniedChannelId are new and
    // optional, falling back to logChannelId when unset so a form doesn't
    // silently stop posting anywhere on upgrade.
    logChannelId: bigint("log_channel_id", { mode: "bigint" }).notNull(), // pending-submission channel
    acceptedChannelId: bigint("accepted_channel_id", { mode: "bigint" }),
    deniedChannelId: bigint("denied_channel_id", { mode: "bigint" }),
    // role automation
    grantRoleIds: jsonb("grant_role_ids").$type<string[]>().notNull().default([]),
    removeRoleIds: jsonb("remove_role_ids").$type<string[]>().notNull().default([]),
    // denial-path role changes, kept distinct from the accept-path fields
    // above: deniedGrantRoleIds are ADDED on denial (e.g. tag a user as
    // "previously denied"), deniedRemoveRoleIds are the roles stripped
    // regardless of outcome (e.g. an "Applicant" holding role).
    deniedGrantRoleIds: jsonb("denied_grant_role_ids").$type<string[]>().notNull().default([]),
    denyRemoveRoleIds: jsonb("deny_remove_role_ids").$type<string[]>().notNull().default([]),
    // Granted the moment a submission is created and held only while it's
    // pending — e.g. a temporary "Applicant" tag visible to staff. Removed
    // automatically the moment the submission is accepted/denied/withdrawn.
    pendingRoleIds: jsonb("pending_role_ids").$type<string[]>().notNull().default([]),
    // Stripped immediately at submission time regardless of eventual
    // outcome — distinct from denyRemoveRoleIds (deny-only) and
    // removeRoleIds (accept-only). E.g. remove a "Can Apply" role the
    // instant someone uses it, so they can't start a second application
    // even before staff have reviewed the first (allowMultiplePending
    // already blocks a second submission by default, but a guild that
    // sets allowMultiplePending=true might still want this as a signal).
    removeRolesOnSubmitIds: jsonb("remove_roles_on_submit_ids").$type<string[]>().notNull().default([]),
    // roles pinged in the review post when a new submission arrives
    pingRoleIds: jsonb("ping_role_ids").$type<string[]>().notNull().default([]),
    // what happens to a pending submission if the applicant leaves the guild
    leaveAction: leaveActionEnum("leave_action").notNull().default("none"),
    // gating (paid tier)
    requiredRoleIds: jsonb("required_role_ids").$type<string[]>().notNull().default([]),
    requiredRolesMatchMode: matchModeEnum("required_roles_match_mode").notNull().default("has_all"),
    blacklistedRoleIds: jsonb("blacklisted_role_ids").$type<string[]>().notNull().default([]),
    blacklistedRolesMatchMode: matchModeEnum("blacklisted_roles_match_mode").notNull().default("has_all"),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(0),
    maxTotalSubmissions: integer("max_total_submissions"), // null = unlimited
    maxSubmissionsWindowSeconds: integer("max_submissions_window_seconds"), // rolling window
    maxSubmissionsInWindow: integer("max_submissions_in_window"),
    // Time allotted to complete the application after starting it. Applies
    // to both application types, but matters most for direct_message ones
    // since those can span a real back-and-forth over time; null = no
    // limit. Enforced by bot/src/services/dmApplicationService.ts for DM
    // flows and as a soft accounting field for in_server (Discord's own
    // modal/interaction token lifetime already bounds those tightly).
    timeLimitSeconds: integer("time_limit_seconds"),
    // behavior
    allowMultiplePending: boolean("allow_multiple_pending").notNull().default(false),
    threadCollabEnabled: boolean("thread_collab_enabled").notNull().default(true),
    threadName: varchar("thread_name", { length: 100 }).default("Review: {username}"),
    autoArchiveOnDecision: boolean("auto_archive_on_decision").notNull().default(true),
    // When true, the review embed omits the applicant's actual answers —
    // only submission stats (time taken, question count) are shown in
    // Discord; full answers remain visible on the dashboard only. Useful
    // for sensitive application content staff don't want sitting in a
    // Discord channel's message history indefinitely.
    hideAnswersInEmbed: boolean("hide_answers_in_embed").notNull().default(false),
    // Shown before the first question, asking the applicant to confirm
    // they want to proceed — distinct from the post-submit "completion"
    // DM (dmTemplates type="submission" already covers completion).
    // sql`` and a doubled apostrophe, not a plain string: drizzle-kit emits a
    // string default straight into the migration without escaping it, so
    // "you'll" closes the SQL literal early and the migration cannot be
    // applied at all. It was written as a plain string, and this table could
    // never be created. See the note on dmOnBanNote below.
    confirmationMessage: text("confirmation_message").default(
      sql`'Are you sure you want to apply? Once you start, you''ll be asked a series of questions.'`,
    ),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("form_guild_idx").on(t.guildId),
  }),
);

export const questionValidationTypeEnum = pgEnum("question_validation_type", ["none", "regex"]);

export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    // Was capped at 45 chars to match Discord's modal label limit, but that
    // constraint only applies to the in_server application flow (see
    // forms.applicationType) — a direct_message-flow question is sent as a
    // plain chat message with no such limit. Raised to 200 here; the
    // in_server modal-building code (bot/src/interactions/buttons/panelOpen.ts)
    // is responsible for truncating/rejecting anything over 45 chars for
    // that flow specifically, rather than the schema silently constraining
    // both flows to the tighter of the two.
    label: varchar("label", { length: 200 }).notNull(),
    placeholder: varchar("placeholder", { length: 100 }),
    type: questionTypeEnum("type").notNull().default("short_text"),
    required: boolean("required").notNull().default(true),
    minLength: integer("min_length"),
    maxLength: integer("max_length"),
    // for type = select
    options: jsonb("options").$type<{ label: string; value: string; description?: string }[]>(),
    // Optional regex validation, in addition to min/max length. "none" is
    // the default and skips regex entirely. Never valid for type="select"
    // (a select's answer is one of a fixed set of values chosen from a
    // menu — there's nothing free-text for a pattern to validate against),
    // enforced in the API's zod schema rather than only in application code.
    validationType: questionValidationTypeEnum("validation_type").notNull().default("none"),
    // Stored as the pattern source only (no flags) — always compiled with
    // no flags at validation time. Capped at 256 chars and checked against
    // a conservative ReDoS-shaped-pattern rejection list at write time; see
    // shared/schema/regexValidation.ts for the actual checks. Never trust
    // a stored pattern as pre-vetted just because it made it into the
    // database — bot/src/services and api/src/routes both re-run the same
    // shared check before ever executing a pattern against user input,
    // in case a row was inserted through some path that skipped the checks.
    validationPattern: varchar("validation_pattern", { length: 256 }),
    validationErrorMessage: varchar("validation_error_message", { length: 200 }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    formIdx: index("question_form_idx").on(t.formId),
  }),
);

// Custom DM templates per form (paid tier: custom message editor)
export const dmTemplates = pgTable(
  "dm_templates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    type: dmTypeEnum("type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    title: varchar("title", { length: 256 }),
    body: text("body").notNull(), // supports {username} {guild} {form} {reason} placeholders
    color: integer("color"),
  },
  (t) => ({
    formTypeIdx: uniqueIndex("dm_template_form_type_idx").on(t.formId, t.type),
  }),
);

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    applicantId: bigint("applicant_id", { mode: "bigint" }).notNull(),
    status: submissionStatusEnum("status").notNull().default("pending"),
    logMessageId: bigint("log_message_id", { mode: "bigint" }),
    threadId: bigint("thread_id", { mode: "bigint" }),
    reviewerId: bigint("reviewer_id", { mode: "bigint" }),
    reviewReason: text("review_reason"),
    // Which outcome was chosen, when the form has more than one. Null for
    // denials and for forms using the single-accept path. outcomeLabel is a
    // deliberate snapshot — see shared/schema/outcomes.ts.
    outcomeId: text("outcome_id"),
    outcomeLabel: text("outcome_label"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // How long the applicant took from starting to submitting — populated
    // for both application types, shown in the review embed when the
    // form's showStats-equivalent is on (see FormDTO.hideAnswersInEmbed —
    // stats display independent of whether answers themselves are shown).
    completionSeconds: integer("completion_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    formIdx: index("submission_form_idx").on(t.formId),
    applicantIdx: index("submission_applicant_idx").on(t.applicantId),
    statusIdx: index("submission_status_idx").on(t.status),
    // supports cooldown + submission-limit queries efficiently
    formApplicantCreatedIdx: index("submission_form_applicant_created_idx").on(
      t.formId,
      t.applicantId,
      t.createdAt,
    ),
  }),
);

// Tracks a direct_message application that has been started but not yet
// completed — one row per in-progress DM application, deleted once it
// either completes (becomes a real `submissions` row) or expires past the
// form's timeLimitSeconds. Doesn't exist for in_server applications, since
// those complete atomically via a single modal submit with no
// partially-answered state to track.
export const dmApplicationProgress = pgTable(
  "dm_application_progress",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    applicantId: bigint("applicant_id", { mode: "bigint" }).notNull(),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    currentQuestionIndex: integer("current_question_index").notNull().default(0),
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // null = form has no timeLimitSeconds
  },
  (t) => ({
    // one in-progress DM application per (form, applicant) at a time
    formApplicantIdx: uniqueIndex("dm_progress_form_applicant_idx").on(t.formId, t.applicantId),
    expiresIdx: index("dm_progress_expires_idx").on(t.expiresAt),
  }),
);

// Staff override for one applicant's gating checks on one form — created
// by /reset-cooldown. When present and unexpired, evaluateGate's cooldown
// and standing-limit checks are bypassed for that (guild, form, user)
// combination. Deliberately NOT implemented by mutating or deleting
// submission history (which would corrupt the audit trail /
// /export_applications relies on) — an explicit, auditable override row
// is added instead, with who granted it and why.
export const gateOverrides = pgTable(
  "gate_overrides",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    applicantId: bigint("applicant_id", { mode: "bigint" }).notNull(),
    grantedBy: bigint("granted_by", { mode: "bigint" }).notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // null = never expires
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    formApplicantIdx: uniqueIndex("gate_override_form_applicant_idx").on(t.formId, t.applicantId),
  }),
);

export const answers = pgTable(
  "answers",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
  },
  (t) => ({
    submissionIdx: index("answer_submission_idx").on(t.submissionId),
  }),
);

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export const polls = pgTable(
  "polls",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }),
    question: varchar("question", { length: 300 }).notNull(),
    options: jsonb("options").$type<{ id: string; label: string; emoji?: string }[]>().notNull(),
    allowMultiselect: boolean("allow_multiselect").notNull().default(false),
    status: pollStatusEnum("status").notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    createdBy: bigint("created_by", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("poll_guild_idx").on(t.guildId),
    statusScheduledIdx: index("poll_status_scheduled_idx").on(t.status, t.scheduledFor),
  }),
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    pollId: text("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" }).notNull(),
    optionId: text("option_id").notNull(),
    votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pollId, t.userId, t.optionId] }),
  }),
);

// ---------------------------------------------------------------------------
// Ticket system
// ---------------------------------------------------------------------------

// One config per guild per "panel" of ticket types (e.g. "Support",
// "Report a player") — kept separate from application forms/panels since
// tickets have a different lifecycle (open/close, transcripts) rather than
// a one-shot submission + accept/deny decision.
export const ticketConfigs = pgTable(
  "ticket_configs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    buttonLabel: varchar("button_label", { length: 80 }).notNull().default("Open Ticket"),
    buttonEmoji: varchar("button_emoji", { length: 64 }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(), // where the open-ticket panel is posted
    categoryId: bigint("category_id", { mode: "bigint" }), // parent category for private_channel mode
    // Choice the user asked for: staff can pick how a ticket manifests.
    // private_channel: a brand-new channel, applicant + support roles only.
    // private_thread: a thread only staff + applicant can see (needs the
    //   guild to have private threads available on its boost tier).
    // public_thread: a thread visible to anyone who can see the parent
    //   channel — cheaper (doesn't count against channel limits) but not
    //   private; useful for low-sensitivity "help" tickets.
    channelType: ticketChannelTypeEnum("channel_type").notNull().default("private_channel"),
    supportRoleIds: jsonb("support_role_ids").$type<string[]>().notNull().default([]),
    pingRoleIds: jsonb("ping_role_ids").$type<string[]>().notNull().default([]),
    welcomeMessage: text("welcome_message").default(
      "Thanks for opening a ticket. A member of staff will be with you shortly.",
    ),
    ticketNameFormat: varchar("ticket_name_format", { length: 100 }).notNull().default("ticket-{username}"),
    maxOpenPerUser: integer("max_open_per_user").notNull().default(1),
    leaveAction: ticketLeaveActionEnum("leave_action").notNull().default("none"),
    transcriptOnClose: boolean("transcript_on_close").notNull().default(true),
    transcriptChannelId: bigint("transcript_channel_id", { mode: "bigint" }),
    // If false, only support team roles can close — the opener themselves
    // cannot. Confirmed as a real toggle in the reference dashboard rather
    // than assumed always-on.
    creatorCanClose: boolean("creator_can_close").notNull().default(true),
    // If false, the Claim button/behavior is hidden entirely rather than
    // always-on — some guilds run tickets without a claim workflow at all.
    claimingEnabled: boolean("claiming_enabled").notNull().default(false),
    ratingEnabled: boolean("rating_enabled").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("ticket_config_guild_idx").on(t.guildId),
  }),
);

export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    configId: text("config_id")
      .notNull()
      .references(() => ticketConfigs.id, { onDelete: "cascade" }),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    openerId: bigint("opener_id", { mode: "bigint" }).notNull(),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(), // channel OR thread id, per channelType
    status: ticketStatusEnum("status").notNull().default("open"),
    claimedBy: bigint("claimed_by", { mode: "bigint" }),
    closedBy: bigint("closed_by", { mode: "bigint" }),
    closeReason: text("close_reason"),
    transcriptUrl: text("transcript_url"),
    // Rating support experience: opener-provided, 1-5, collected via a DM
    // prompt sent right after close (see
    // bot/src/services/ticketRatingService.ts). Both null until rated;
    // rating stays null forever if the config has ratingEnabled=false or
    // the opener never responds.
    rating: integer("rating"),
    ratingComment: text("rating_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    configIdx: index("ticket_config_idx").on(t.configId),
    openerIdx: index("ticket_opener_idx").on(t.openerId),
    statusIdx: index("ticket_status_idx").on(t.status),
    // supports the maxOpenPerUser check efficiently
    configOpenerStatusIdx: index("ticket_config_opener_status_idx").on(
      t.configId,
      t.openerId,
      t.status,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------

export const giveaways = pgTable(
  "giveaways",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }),
    prize: varchar("prize", { length: 256 }).notNull(),
    winnerCount: integer("winner_count").notNull().default(1),
    // role restrictions mirror the forms gating pattern for consistency
    requiredRoleIds: jsonb("required_role_ids").$type<string[]>().notNull().default([]),
    blacklistedRoleIds: jsonb("blacklisted_role_ids").$type<string[]>().notNull().default([]),
    bonusRoleEntries: jsonb("bonus_role_entries")
      .$type<{ roleId: string; extraEntries: number }[]>()
      .notNull()
      .default([]),
    status: giveawayStatusEnum("status").notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    winnerIds: jsonb("winner_ids").$type<string[]>().notNull().default([]),
    hostId: bigint("host_id", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("giveaway_guild_idx").on(t.guildId),
    statusEndsIdx: index("giveaway_status_ends_idx").on(t.status, t.endsAt),
  }),
);

export const giveawayEntries = pgTable(
  "giveaway_entries",
  {
    giveawayId: text("giveaway_id")
      .notNull()
      .references(() => giveaways.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" }).notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.giveawayId, t.userId] }),
  }),
);

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// One config per guild (unlike forms/tickets, verification is a single
// server-wide gate, not something you'd run multiple parallel copies of).
export const verificationConfigs = pgTable("verification_configs", {
  guildId: bigint("guild_id", { mode: "bigint" })
    .primaryKey()
    .references(() => guilds.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  channelId: bigint("channel_id", { mode: "bigint" }),
  messageId: bigint("message_id", { mode: "bigint" }),
  method: verificationMethodEnum("method").notNull().default("button"),
  verifiedRoleId: bigint("verified_role_id", { mode: "bigint" }),
  unverifiedRoleId: bigint("unverified_role_id", { mode: "bigint" }), // optional: applied on join, removed on verify
  panelTitle: varchar("panel_title", { length: 256 }).notNull().default("Verification"),
  panelDescription: text("panel_description").default(
    "Click the button below to verify and gain access to the server.",
  ),
  kickUnverifiedAfterSeconds: integer("kick_unverified_after_seconds"), // null = never
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verificationAttempts = pgTable(
  "verification_attempts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    userId: bigint("user_id", { mode: "bigint" }).notNull(),
    challengeCode: varchar("challenge_code", { length: 12 }), // captcha method only
    verified: boolean("verified").notNull().default(false),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildUserIdx: index("verification_attempt_guild_user_idx").on(t.guildId, t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Anti-raid
//
// A join-velocity detector: if more than joinThreshold members join within
// windowSeconds, the configured action fires once (not per-join) and stays
// latched until staff manually clear it (raidLockdowns row deleted) or
// autoLockdownExpiresAfterSeconds elapses. Deliberately conservative about
// what "action" can mean — this project does not implement automatic
// mass-kick/mass-ban of the joining members, since a false positive there
// (e.g. a legitimate growth spike from a public invite going viral) is
// far more damaging than a false negative. The available actions instead
// restrict NEW joins and alert staff, who make the actual
// kick/ban call themselves with full context.
// ---------------------------------------------------------------------------

export const antiRaidActionEnum = pgEnum("anti_raid_action", [
  "alert_only", // ping staff, take no automatic action
  "lock_verification", // if verification is enabled, force it on / raise friction
  "kick_new_joins", // kick (not ban) members who join WHILE lockdown is active — never retroactive
]);

export const antiRaidConfigs = pgTable("anti_raid_configs", {
  guildId: bigint("guild_id", { mode: "bigint" })
    .primaryKey()
    .references(() => guilds.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  joinThreshold: integer("join_threshold").notNull().default(10),
  windowSeconds: integer("window_seconds").notNull().default(60),
  action: antiRaidActionEnum("action").notNull().default("alert_only"),
  alertChannelId: bigint("alert_channel_id", { mode: "bigint" }),
  alertRoleIds: jsonb("alert_role_ids").$type<string[]>().notNull().default([]),
  autoLockdownExpiresAfterSeconds: integer("auto_lockdown_expires_after_seconds").notNull().default(1800), // 30 min
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A currently-active lockdown for a guild. Presence of a row (with
// expiresAt in the future) means kick_new_joins / lock_verification is
// actively in effect. Deleted (or expired) to end the lockdown.
export const raidLockdowns = pgTable("raid_lockdowns", {
  guildId: bigint("guild_id", { mode: "bigint" })
    .primaryKey()
    .references(() => guilds.id, { onDelete: "cascade" }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  triggeredByJoinCount: integer("triggered_by_join_count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  clearedBy: bigint("cleared_by", { mode: "bigint" }), // set if a staff member manually cleared it early
});

// ---------------------------------------------------------------------------
// Welcomer
// ---------------------------------------------------------------------------

// One config per guild, covering both join and (optionally) leave messages,
// plus an auto-role grant on join — kept as a single row since these three
// behaviors are almost always configured together.
export const welcomerConfigs = pgTable("welcomer_configs", {
  guildId: bigint("guild_id", { mode: "bigint" })
    .primaryKey()
    .references(() => guilds.id, { onDelete: "cascade" }),
  joinEnabled: boolean("join_enabled").notNull().default(false),
  joinChannelId: bigint("join_channel_id", { mode: "bigint" }),
  joinMessage: text("join_message").default("Welcome to {guild}, {username}! You are member #{membercount}."),
  joinDmEnabled: boolean("join_dm_enabled").notNull().default(false),
  joinDmMessage: text("join_dm_message"),
  joinEmbedColor: integer("join_embed_color").default(0x5865f2),
  joinImageUrl: text("join_image_url"),
  autoRoleIds: jsonb("auto_role_ids").$type<string[]>().notNull().default([]),
  leaveEnabled: boolean("leave_enabled").notNull().default(false),
  leaveChannelId: bigint("leave_channel_id", { mode: "bigint" }),
  leaveMessage: text("leave_message").default("{username} has left {guild}."),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Quick Responses — staff-authored canned replies triggered via a message
// context-menu command ("right-click a message > Quick Response"), grouped
// into categories for organization. Distinct from dmTemplates (which are
// automated, event-triggered) and from ticket welcome messages (fixed,
// per-ticket-type) — these are ad-hoc, staff-invoked, reusable snippets for
// answering repeat questions without retyping them.
// ---------------------------------------------------------------------------

export const quickResponseCategories = pgTable(
  "quick_response_categories",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    guildIdx: index("quick_response_category_guild_idx").on(t.guildId),
  }),
);

export const quickResponses = pgTable(
  "quick_responses",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => quickResponseCategories.id, { onDelete: "set null" }),
    title: varchar("title", { length: 100 }).notNull(),
    body: text("body").notNull(),
    createdBy: bigint("created_by", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("quick_response_guild_idx").on(t.guildId),
    categoryIdx: index("quick_response_category_idx").on(t.categoryId),
  }),
);

// ---------------------------------------------------------------------------
// Sticky Messages — a message the bot re-posts at the bottom of a channel
// every time new activity would otherwise bury it (e.g. rules, an invite
// link, an FAQ pointer). One active sticky per channel; re-posting works by
// deleting the previous bot-sent sticky and sending a fresh one so it's
// always the most recent message, since Discord has no native "pin to
// bottom" primitive.
// ---------------------------------------------------------------------------

export const stickyMessages = pgTable(
  "sticky_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull().unique(),
    content: text("content").notNull(),
    lastMessageId: bigint("last_message_id", { mode: "bigint" }), // the currently-posted copy, if any
    // Re-posting on every single message would be extremely spammy and
    // rate-limit-hostile; instead the bot re-posts only after this many
    // OTHER messages have been sent in the channel since the sticky was
    // last (re)posted, checked opportunistically on messageCreate rather
    // than on a timer.
    repostAfterMessages: integer("repost_after_messages").notNull().default(5),
    messagesSinceRepost: integer("messages_since_repost").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("sticky_message_guild_idx").on(t.guildId),
  }),
);

// ---------------------------------------------------------------------------
// Self-assignable roles ("reaction roles" / role menus)
//
// Deliberately separate from welcomerConfigs.autoRoleIds: that field grants
// a fixed set of roles automatically on join with no user choice involved.
// This is the opposite — a published menu of OPTIONAL roles a member picks
// for themselves at any time, unrelated to joining. Conflating the two
// would make welcomer's "always grant these on join" semantics ambiguous
// with "let people opt in/out whenever they want".
// ---------------------------------------------------------------------------

export const roleMenus = pgTable(
  "role_menus",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    channelId: bigint("channel_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }),
    title: varchar("title", { length: 256 }).notNull().default("Choose your roles"),
    description: text("description").default(""),
    // "multi": member can hold any number of the listed roles at once.
    // "single": selecting one option removes any other role from this menu
    // the member currently holds — a mutually-exclusive picker (e.g.
    // pronoun or region roles where only one should apply at a time).
    selectionMode: varchar("selection_mode", { length: 16 }).notNull().default("multi"),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index("role_menu_guild_idx").on(t.guildId),
  }),
);

export const roleMenuOptions = pgTable(
  "role_menu_options",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    menuId: text("menu_id")
      .notNull()
      .references(() => roleMenus.id, { onDelete: "cascade" }),
    roleId: bigint("role_id", { mode: "bigint" }).notNull(),
    label: varchar("label", { length: 100 }).notNull(),
    emoji: varchar("emoji", { length: 64 }),
    description: varchar("description", { length: 100 }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    menuIdx: index("role_menu_option_menu_idx").on(t.menuId),
    uniqueRolePerMenu: uniqueIndex("role_menu_option_unique").on(t.menuId, t.roleId),
  }),
);

// ---------------------------------------------------------------------------
// Dashboard audit log — who changed what config, when. Distinct from any
// per-feature audit trail (e.g. gate_overrides already records its own
// grantedBy/reason) — this is a general-purpose log of dashboard mutations
// across every resource type, for accountability when multiple staff share
// dashboard access.
// ---------------------------------------------------------------------------

export const dashboardAuditLogs = pgTable(
  "dashboard_audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    userId: bigint("user_id", { mode: "bigint" }).notNull(),
    action: varchar("action", { length: 50 }).notNull(), // e.g. "form.update", "panel.publish", "billing.checkout"
    resourceType: varchar("resource_type", { length: 50 }).notNull(), // e.g. "form", "panel", "ticket_config"
    resourceId: text("resource_id"),
    // Best-effort before/after snapshot for update actions; omitted for
    // create/delete where the full row itself is the record. Never stores
    // secrets (session tokens, encrypted fields) — callers are responsible
    // for redacting before passing a diff in.
    changes: jsonb("changes").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildCreatedIdx: index("dashboard_audit_guild_created_idx").on(t.guildId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Dashboard sessions (OAuth2)
// ---------------------------------------------------------------------------

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: bigint("user_id", { mode: "bigint" }).notNull(),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const guildsRelations = relations(guilds, ({ many }) => ({
  forms: many(forms),
  panels: many(panels),
  staffPermissions: many(staffPermissions),
  polls: many(polls),
}));

export const formsRelations = relations(forms, ({ one, many }) => ({
  guild: one(guilds, { fields: [forms.guildId], references: [guilds.id] }),
  questions: many(questions),
  submissions: many(submissions),
  dmTemplates: many(dmTemplates),
  panelButtons: many(panelButtons),
}));

export const panelsRelations = relations(panels, ({ one, many }) => ({
  guild: one(guilds, { fields: [panels.guildId], references: [guilds.id] }),
  buttons: many(panelButtons),
}));

export const panelButtonsRelations = relations(panelButtons, ({ one }) => ({
  panel: one(panels, { fields: [panelButtons.panelId], references: [panels.id] }),
  form: one(forms, { fields: [panelButtons.formId], references: [forms.id] }),
}));

export const questionsRelations = relations(questions, ({ one }) => ({
  form: one(forms, { fields: [questions.formId], references: [forms.id] }),
}));

export const submissionsRelations = relations(submissions, ({ one, many }) => ({
  form: one(forms, { fields: [submissions.formId], references: [forms.id] }),
  answers: many(answers),
}));

export const answersRelations = relations(answers, ({ one }) => ({
  submission: one(submissions, { fields: [answers.submissionId], references: [submissions.id] }),
  question: one(questions, { fields: [answers.questionId], references: [questions.id] }),
}));

export const pollsRelations = relations(polls, ({ many }) => ({
  votes: many(pollVotes),
}));

// The other half of polls.votes. Drizzle infers a join from BOTH sides, so a
// many() with no matching one() is not a half-defined relation — it is an
// unusable one, and asking for it fails at runtime with "not enough
// information to infer relation \"polls.votes\"".
//
// It went unnoticed because nothing queried `with: { votes: true }` until the
// data export started including polls. Every other many() here has its
// counterpart; see giveawayEntriesRelations directly below.
export const pollVotesRelations = relations(pollVotes, ({ one }) => ({
  poll: one(polls, { fields: [pollVotes.pollId], references: [polls.id] }),
}));

export const ticketConfigsRelations = relations(ticketConfigs, ({ one, many }) => ({
  guild: one(guilds, { fields: [ticketConfigs.guildId], references: [guilds.id] }),
  tickets: many(tickets),
}));

export const ticketsRelations = relations(tickets, ({ one }) => ({
  config: one(ticketConfigs, { fields: [tickets.configId], references: [ticketConfigs.id] }),
}));

export const giveawaysRelations = relations(giveaways, ({ many }) => ({
  entries: many(giveawayEntries),
}));

export const giveawayEntriesRelations = relations(giveawayEntries, ({ one }) => ({
  giveaway: one(giveaways, { fields: [giveawayEntries.giveawayId], references: [giveaways.id] }),
}));

export const roleMenusRelations = relations(roleMenus, ({ many }) => ({
  options: many(roleMenuOptions),
}));

export const roleMenuOptionsRelations = relations(roleMenuOptions, ({ one }) => ({
  menu: one(roleMenus, { fields: [roleMenuOptions.menuId], references: [roleMenus.id] }),
}));

export const quickResponseCategoriesRelations = relations(quickResponseCategories, ({ many }) => ({
  responses: many(quickResponses),
}));

export const quickResponsesRelations = relations(quickResponses, ({ one }) => ({
  category: one(quickResponseCategories, {
    fields: [quickResponses.categoryId],
    references: [quickResponseCategories.id],
  }),
}));

// ---------------------------------------------------------------------------
// Scheduled jobs
//
// Replaces the in-memory `setTimeout` calls that previously handled delayed
// work (auto-kicking members who never verified). An in-process timer has
// three problems that only show up at scale or on deploy day:
//
//   - It's lost on restart, with no record that it was lost. A deploy
//     silently cancels every pending kick.
//   - It holds a closure over its arguments for its entire duration, so
//     N pending jobs cost N live closures. During a raid, N is however
//     many people just joined.
//   - It's invisible. Staff can't see what's queued or cancel it.
//
// A durable row fixes all three, and gives the dashboard something real to
// display. `claimedAt`/`claimedBy` exist so multiple bot replicas can share
// the queue without executing the same job twice — see the claim query in
// bot/src/core/scheduler.ts.
// ---------------------------------------------------------------------------

export const scheduledJobKindEnum = pgEnum("scheduled_job_kind", [
  "kick_unverified",
  "close_poll",
  "end_giveaway",
  "purge_expired_history",
]);

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    kind: scheduledJobKindEnum("kind").notNull(),
    guildId: bigint("guild_id", { mode: "bigint" }).notNull(),
    // The user/entity the job acts on. Meaning depends on `kind`:
    // the member to kick, the poll to close, the giveaway to end.
    subjectId: bigint("subject_id", { mode: "bigint" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    // Set when a worker takes the job, cleared if it fails and should be
    // retried. A row with claimedAt older than the visibility timeout is
    // treated as abandoned and re-claimable, so a worker that dies
    // mid-job doesn't strand it forever.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: varchar("claimed_by", { length: 64 }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The scheduler's only query: "unclaimed jobs that are due". Partial
    // index on runAt with claimedAt null keeps it small no matter how much
    // completed history accumulates.
    dueIdx: index("scheduled_job_due_idx").on(t.runAt, t.claimedAt),
    guildIdx: index("scheduled_job_guild_idx").on(t.guildId),
    // One pending job of a given kind per (guild, subject). Stops a member
    // who rejoins repeatedly from queueing a kick job per rejoin.
    uniquePending: uniqueIndex("scheduled_job_unique_pending").on(t.kind, t.guildId, t.subjectId),
  }),
);

// ---------------------------------------------------------------------------
// Appealy's Appealable Appealing Appeal System — ban appeals.
//
// One config row per guild (like welcomerConfigs/antiRaidConfigs above).
// `formId` designates which appeal-kind form (forms.kind = "appeal") is
// "the" ban-appeal form for this guild — a guild can have zero-or-more
// appeal-kind forms defined but at most one active at a time here, same
// as how a server realistically only wants a single appeal queue.
//
// Why this can't be an in-server flow: by the time someone wants to
// appeal, they have already been removed from the guild, so a panel
// button or /apply is never reachable for them. The only channel back to
// them is a DM the bot sends the moment guildBanAdd fires
// (bot/src/events/guildBanAdd.ts), reusing the exact same
// direct_message-application machinery (bot/src/services/dmApplicationService.ts)
// that already exists for in-server "apply by DM" forms.
//
// Known reliability caveat, worth stating plainly rather than glossing
// over (same spirit as the importAppy attachment-resolution note in
// README.md): Discord only allows a bot to open a DM with a user it
// shares no guild with if a DM channel already exists between them.
// guildBanAdd fires after the ban (and the implicit kick) has already
// happened, so whether the proactive DM lands depends on exactly how
// Discord's backend sequences the ban vs. the "shared guild" check at
// the moment `createDm` is called — this is NOT a guaranteed delivery
// channel. A guild relying on this feature should also tell members
// (in its rules/ban message) that appeals can be requested by DMing the
// bot directly if the automatic DM never arrives and a shared-DM-channel
// already exists from some earlier interaction.
// ---------------------------------------------------------------------------

export const appealConfigs = pgTable("appeal_configs", {
  guildId: bigint("guild_id", { mode: "bigint" })
    .primaryKey()
    .references(() => guilds.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  // Nullable: a guild can enable the feature before it has actually
  // built/designated an appeal-kind form yet; enforced at the API layer
  // that this must point at a forms row with kind = "appeal" in the same
  // guild before dmOnBanEnabled can do anything meaningful.
  formId: text("form_id").references(() => forms.id, { onDelete: "set null" }),
  // Best-effort proactive DM at ban time (see reliability caveat above).
  // When false, the appeal form still exists and can be reached if the
  // banned user DMs the bot directly (not implemented as an explicit
  // command here — messageCreate.ts's existing in-progress-application
  // check only continues a flow already started via startDmApplication,
  // it doesn't start one from a cold DM; a guild that wants a
  // DM-triggered entry point should keep this enabled).
  dmOnBanEnabled: boolean("dm_on_ban_enabled").notNull().default(true),
  // Optional extra line shown before the form's own confirmationMessage,
  // e.g. explaining *why* they're suddenly getting a DM from this bot —
  // distinct from confirmationMessage (which is about the form itself,
  // reused from the generic forms flow) since this is specifically about
  // the unsolicited-DM context an appeal recipient is in that an ordinary
  // applicant never is.
  // sql`` with the apostrophe doubled, for the reason given on
  // confirmationMessage above: a plain string default containing an
  // apostrophe is emitted unescaped and breaks the generated migration. Any
  // prose default added here needs the same treatment, or no apostrophe.
  dmOnBanNote: text("dm_on_ban_note").default(
    sql`'You have been banned and are receiving this message because ban appeals are enabled for this server. If you''d like to appeal, answer the questions below. Sending nothing will not appeal the ban.'`,
  ),
  // When true (default), accepting an appeal submission calls Discord's
  // unban endpoint automatically (bot/src/interactions/buttons/reviewAccept.ts).
  // When false, staff still see and can accept/deny the appeal as a
  // normal submission, but must unban manually — useful for guilds that
  // want a human to double-check before anyone is let back in.
  autoUnbanOnAccept: boolean("auto_unban_on_accept").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Platform-level bans live in their own file but are re-exported here, because
// db/client.ts does `import * as schema from "./schema.ts"` — there is no
// barrel module. Without this line `schema.platformBans` is undefined at
// runtime and the failure looks like a Drizzle bug rather than a missing
// export. See shared/schema/platformBans.ts for why they're kept separate.
// ---------------------------------------------------------------------------
export * from "./platformBans.ts";

// Multiple accept outcomes per form. Kept in its own file for size; re-exported
// here because db/client.ts does `import * as schema from "./schema.ts"` and
// there is no barrel module.
export * from "./outcomes.ts";
