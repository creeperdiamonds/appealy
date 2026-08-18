// shared/types/index.ts
// Cross-service types. The bot and API both import from shared/ so the
// wire format between Discord interactions, Postgres, and the REST API
// never drifts out of sync.

export type Snowflake = string; // always transported/serialized as string, stored as bigint

export type QuestionType = "short_text" | "paragraph" | "select";

export type SubmissionStatus = "pending" | "accepted" | "denied" | "withdrawn";

export type DmType = "submission" | "acceptance" | "denial";

export type PermissionLevel = "owner" | "admin" | "manager";

export type PollStatus = "draft" | "scheduled" | "published" | "closed";

export type PlanTier = "free" | "pro";

// ---------------------------------------------------------------------------
// Custom ID encoding
//
// Discord component/modal custom_id fields are capped at 100 chars, so we use
// a compact, versioned, colon-delimited scheme rather than embedding JSON.
// Format: "<namespace>:<action>:<entityId>[:<extra>]"
//
// Examples:
//   panel:open:<formId>                 -> button on a panel opens a form modal
//   review:accept:<submissionId>        -> accept button on a review post
//   review:deny:<submissionId>          -> deny button; opens a reason modal
//   review:deny_confirm:<submissionId>  -> submit of the deny-reason modal
//   modal:submit:<formId>               -> the application modal's own submit id
//   modal:select:<formId>:<questionId>  -> pre-modal select-menu step
//   poll:vote:<pollId>:<optionId>       -> poll vote button/select
// ---------------------------------------------------------------------------

export const CUSTOM_ID_NAMESPACES = {
  PANEL: "panel",
  REVIEW: "review",
  MODAL: "modal",
  POLL: "poll",
  TICKET: "ticket",
  GIVEAWAY: "giveaway",
  VERIFY: "verify",
  ROLE_MENU: "rolemenu",
} as const;

export type CustomIdNamespace =
  (typeof CUSTOM_ID_NAMESPACES)[keyof typeof CUSTOM_ID_NAMESPACES];

export interface ParsedCustomId {
  namespace: string;
  action: string;
  entityId: string;
  extra?: string;
}

export function encodeCustomId(
  namespace: CustomIdNamespace,
  action: string,
  entityId: string,
  extra?: string,
): string {
  const parts = [namespace, action, entityId];
  if (extra) parts.push(extra);
  const id = parts.join(":");
  if (id.length > 100) {
    throw new Error(`custom_id exceeds 100 chars: ${id}`);
  }
  return id;
}

export function decodeCustomId(customId: string): ParsedCustomId {
  const [namespace, action, entityId, extra] = customId.split(":");
  return { namespace, action, entityId, extra };
}

// ---------------------------------------------------------------------------
// Placeholder interpolation for DM / embed templates
// ---------------------------------------------------------------------------

export interface TemplateContext {
  username: string;
  userTag: string;
  userId: Snowflake;
  guildName: string;
  formName?: string;
  reason?: string;
  memberCount?: number;
}

export function interpolateTemplate(template: string, ctx: TemplateContext): string {
  return template
    .replaceAll("{username}", ctx.username)
    .replaceAll("{usertag}", ctx.userTag)
    .replaceAll("{userid}", ctx.userId)
    .replaceAll("{guild}", ctx.guildName)
    .replaceAll("{form}", ctx.formName ?? "")
    .replaceAll("{reason}", ctx.reason ?? "No reason provided")
    .replaceAll("{membercount}", ctx.memberCount !== undefined ? String(ctx.memberCount) : "");
}

// ---------------------------------------------------------------------------
// API DTOs (request/response contracts for the dashboard)
// ---------------------------------------------------------------------------

export type MatchMode = "has_all" | "has_any";
export type ApplicationType = "in_server" | "direct_message";

export type FormKind = "application" | "appeal";

export interface FormDTO {
  kind: FormKind;
  id: string;
  guildId: Snowflake;
  name: string;
  description: string;
  applicationType: ApplicationType;
  logChannelId: Snowflake;
  acceptedChannelId: Snowflake | null;
  deniedChannelId: Snowflake | null;
  grantRoleIds: Snowflake[];
  removeRoleIds: Snowflake[];
  deniedGrantRoleIds: Snowflake[];
  denyRemoveRoleIds: Snowflake[];
  pendingRoleIds: Snowflake[];
  removeRolesOnSubmitIds: Snowflake[];
  pingRoleIds: Snowflake[];
  leaveAction: "none" | "deny_application";
  requiredRoleIds: Snowflake[];
  requiredRolesMatchMode: MatchMode;
  blacklistedRoleIds: Snowflake[];
  blacklistedRolesMatchMode: MatchMode;
  cooldownSeconds: number;
  maxTotalSubmissions: number | null;
  maxSubmissionsWindowSeconds: number | null;
  maxSubmissionsInWindow: number | null;
  timeLimitSeconds: number | null;
  allowMultiplePending: boolean;
  threadCollabEnabled: boolean;
  threadName: string;
  autoArchiveOnDecision: boolean;
  hideAnswersInEmbed: boolean;
  confirmationMessage: string | null;
  active: boolean;
  questions: QuestionDTO[];
}

export type QuestionValidationType = "none" | "regex";

export interface QuestionDTO {
  id: string;
  label: string;
  placeholder: string | null;
  type: QuestionType;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  options: { label: string; value: string; description?: string }[] | null;
  validationType: QuestionValidationType;
  validationPattern: string | null;
  validationErrorMessage: string | null;
  sortOrder: number;
}

export interface PanelDTO {
  id: string;
  guildId: Snowflake;
  channelId: Snowflake;
  messageId: Snowflake | null;
  title: string;
  description: string;
  color: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  footerText: string | null;
  displayType: "buttons" | "dropdown";
  published: boolean;
  buttons: PanelButtonDTO[];
}

export interface PanelButtonDTO {
  id: string;
  formId: string;
  label: string;
  emoji: string | null;
  style: "primary" | "secondary" | "success" | "danger";
  sortOrder: number;
}

export interface SubmissionDTO {
  id: string;
  formId: string;
  applicantId: Snowflake;
  status: SubmissionStatus;
  reviewerId: Snowflake | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  answers: { questionId: string; label: string; value: string }[];
}

export interface DmTemplateDTO {
  id: string;
  formId: string;
  type: DmType;
  enabled: boolean;
  title: string | null;
  body: string;
  color: number | null;
}

export interface PollDTO {
  id: string;
  guildId: Snowflake;
  channelId: Snowflake;
  messageId: Snowflake | null;
  question: string;
  options: { id: string; label: string; emoji?: string }[];
  allowMultiselect: boolean;
  status: PollStatus;
  scheduledFor: string | null;
  closesAt: string | null;
}

// ---------------------------------------------------------------------------
// Gating evaluation result — computed by shared logic, consumed by the bot
// before opening a modal, and by the API for dashboard "preview access" UI.
// ---------------------------------------------------------------------------

export interface GateCheckResult {
  allowed: boolean;
  reason?:
    | "missing_required_role"
    | "has_blacklisted_role"
    | "cooldown_active"
    | "max_total_reached"
    | "max_window_reached"
    | "pending_exists"
    | "form_inactive";
  cooldownExpiresAt?: string;
}

// ---------------------------------------------------------------------------
// Ticket system DTOs
// ---------------------------------------------------------------------------

export type TicketChannelType = "private_channel" | "private_thread" | "public_thread";
export type TicketStatus = "open" | "closed";
export type TicketLeaveAction = "none" | "close" | "notify";

export interface TicketConfigDTO {
  id: string;
  guildId: Snowflake;
  name: string;
  buttonLabel: string;
  buttonEmoji: string | null;
  channelId: Snowflake;
  categoryId: Snowflake | null;
  channelType: TicketChannelType;
  supportRoleIds: Snowflake[];
  pingRoleIds: Snowflake[];
  welcomeMessage: string;
  ticketNameFormat: string;
  maxOpenPerUser: number;
  leaveAction: TicketLeaveAction;
  transcriptOnClose: boolean;
  transcriptChannelId: Snowflake | null;
  creatorCanClose: boolean;
  claimingEnabled: boolean;
  ratingEnabled: boolean;
  active: boolean;
}

export interface TicketDTO {
  id: string;
  configId: string;
  openerId: Snowflake;
  channelId: Snowflake;
  status: TicketStatus;
  claimedBy: Snowflake | null;
  closedBy: Snowflake | null;
  closeReason: string | null;
  transcriptUrl: string | null;
  rating: number | null;
  ratingComment: string | null;
  createdAt: string;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// Giveaway DTOs
// ---------------------------------------------------------------------------

export type GiveawayStatus = "draft" | "scheduled" | "running" | "ended" | "cancelled";

export interface GiveawayDTO {
  id: string;
  guildId: Snowflake;
  channelId: Snowflake;
  messageId: Snowflake | null;
  prize: string;
  winnerCount: number;
  requiredRoleIds: Snowflake[];
  blacklistedRoleIds: Snowflake[];
  bonusRoleEntries: { roleId: Snowflake; extraEntries: number }[];
  status: GiveawayStatus;
  scheduledFor: string | null;
  endsAt: string | null;
  endedAt: string | null;
  winnerIds: Snowflake[];
  entryCount?: number;
}

// ---------------------------------------------------------------------------
// Verification DTOs
// ---------------------------------------------------------------------------

export type VerificationMethod = "button" | "captcha";

export interface VerificationConfigDTO {
  guildId: Snowflake;
  enabled: boolean;
  channelId: Snowflake | null;
  messageId: Snowflake | null;
  method: VerificationMethod;
  verifiedRoleId: Snowflake | null;
  unverifiedRoleId: Snowflake | null;
  panelTitle: string;
  panelDescription: string;
  kickUnverifiedAfterSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Welcomer DTOs
// ---------------------------------------------------------------------------

export interface WelcomerConfigDTO {
  guildId: Snowflake;
  joinEnabled: boolean;
  joinChannelId: Snowflake | null;
  joinMessage: string;
  joinDmEnabled: boolean;
  joinDmMessage: string | null;
  joinEmbedColor: number;
  joinImageUrl: string | null;
  autoRoleIds: Snowflake[];
  leaveEnabled: boolean;
  leaveChannelId: Snowflake | null;
  leaveMessage: string;
}

// ---------------------------------------------------------------------------
// Ban appeal DTOs — see shared/schema/schema.ts's appealConfigs comment
// for the full design rationale (why this has to be DM-based).
// ---------------------------------------------------------------------------

export interface AppealConfigDTO {
  guildId: Snowflake;
  enabled: boolean;
  formId: string | null;
  dmOnBanEnabled: boolean;
  dmOnBanNote: string | null;
  autoUnbanOnAccept: boolean;
  updatedAt: string;
}

/**
 * The public shape of a platform ban.
 *
 * Lives here rather than in shared/schema/platformBans.ts because the console
 * needs it and that module defines drizzle tables — importing it from the
 * browser bundle drags the ORM in as a type dependency the frontend has no
 * reason to install. Type-only imports still type-check the whole module they
 * come from, so "it's only a type" does not avoid it.
 *
 * shared/schema/platformBans.ts re-exports this and owns the serialization
 * (toPublicBan), which is still the single boundary a ban row crosses.
 */
export interface PublicBan {
  id: string;
  subject: "user" | "guild";
  subjectId: Snowflake;
  reasonCode: string;
  reasonPublic: string;
  createdAt: string;
  expiresAt: string | null;
  automated: boolean;
  openAppeal: { createdAt: string } | null;
}
