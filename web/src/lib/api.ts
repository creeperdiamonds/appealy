// web/src/lib/api.ts
//
// Typed client for the Appealy API.
//
// Every path here corresponds to a route that actually exists in
// api/src/app.ts — this was written against the mounted routers, not
// invented alongside them. Where a shape below looks unusual it's because
// the API returns it that way (snowflakes as strings, money as integer
// cents), and reshaping it in the client would just move the mismatch
// somewhere harder to find.
//
// Two behaviours worth knowing:
//
//   429 — the API now enforces `apiRequestsPerMinute` and returns
//   Retry-After. `request()` honours it and retries once rather than
//   surfacing an error the user can't act on. A dashboard that fans out
//   several requests on page load will occasionally trip a 60/min free
//   tier through no fault of the user, and making them see that would be
//   punishing them for our own request pattern.
//
//   503 permission_check_unavailable — Discord was unreachable, so the API
//   genuinely does not know whether you have access. Surfaced distinctly
//   from 403, because "you can't do this" and "we couldn't check" need
//   different words in the UI and the old code conflated them.

// Empty by default, and empty is the right answer for every normal
// deployment: the API is reached through this same origin (the Vite dev
// server proxies /auth and /api in development, nginx does it in the built
// image), so these are relative paths and the session cookie is first-party.
//
// The cookie is SameSite=Lax. Pointing this at a different hostname than the
// console is served from means the browser stops attaching it and every
// request 401s — and CORS being configured correctly does not change that,
// because CORS governs reading the response, not sending the cookie.
const BASE = import.meta.env.VITE_API_URL ?? "";

// Where the OAuth popup's final page will be served from, which is this
// origin in the normal same-origin setup and the API's origin if someone has
// deliberately split them. Used to reject postMessage from anywhere else.
const AUTH_ORIGIN = new URL(BASE || "/", window.location.href).origin;

/**
 * Sign in through a popup, falling back to a full-page redirect.
 *
 * Why a popup at all: the redirect throws away the SPA. A session that
 * expires while someone is halfway through building a form costs them the
 * form. The popup leaves the page — and its unsaved state — untouched, and
 * the caller can simply retry the request that failed.
 *
 * Why the fallback is not optional:
 *
 *   - Popup blockers allow window.open only under user activation. Some 401s
 *     follow a click ("Save") and land inside the ~5s activation window;
 *     the fan-out of requests on page load does not, and gets blocked. A
 *     blocked popup returns null, which is the signal to redirect instead —
 *     i.e. exactly the behaviour this replaced, so the worst case is no worse.
 *
 *   - People reach a Discord bot dashboard from inside Discord, whose
 *     embedded webview handles popups poorly and often opens them as a tab
 *     with no window.opener at all. Mobile browsers do much the same.
 *
 * Nothing sensitive crosses postMessage: the session is an httpOnly cookie
 * that the popup's own response already set, so the message is only a signal
 * to re-check /auth/me.
 */
let authInFlight: Promise<boolean> | null = null;

function signIn(): Promise<boolean> {
  // A page-load fan-out produces several 401s at once. Without this they
  // would each open their own window.
  if (authInFlight) return authInFlight;

  authInFlight = new Promise<boolean>((resolve) => {
    const popup = window.open(
      `${BASE}/auth/discord/login?mode=popup`,
      "appealy-auth",
      "width=520,height=760",
    );

    if (!popup) {
      window.location.href = `${BASE}/auth/discord/login`;
      resolve(false); // the redirect is already underway; nothing to retry
      return;
    }

    const done = (ok: boolean) => {
      window.removeEventListener("message", onMessage);
      clearInterval(pollClosed);
      clearTimeout(giveUp);
      resolve(ok);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== AUTH_ORIGIN) return;
      if (event.data?.type !== "appealy:auth") return;
      done(Boolean(event.data.ok));
    };

    window.addEventListener("message", onMessage);

    // Covers the window being closed by hand, and the case where it was
    // opened as a tab and window.close() did nothing — without this the
    // promise would never settle and the caller would hang forever.
    const pollClosed = setInterval(() => {
      if (popup.closed) done(false);
    }, 500);

    // Matches STATE_TTL_SECONDS in api/src/routes/auth.ts: past this the
    // nonce is gone and the popup cannot succeed even if it is still open.
    const giveUp = setTimeout(() => done(false), 5 * 60 * 1000);
  }).finally(() => {
    authInFlight = null;
  });

  return authInFlight;
}

/**
 * Thrown when the API answers 403 { error: "banned" }. Carries the ban so the
 * shell can render the ban screen instead of a generic fatal error.
 *
 * Deliberately not a route: a banned account that can navigate to and from
 * /banned is one bad guard away from a redirect loop it cannot escape.
 */
export class BannedError extends Error {
  constructor(public ban: import("../../../shared/types/index.ts").PublicBan) {
    super("banned");
    this.name = "BannedError";
  }
}

/** What a zod `flatten()` looks like once it reaches the browser. */
export interface FieldErrors {
  formErrors?: string[];
  fieldErrors?: Record<string, string[] | undefined>;
}

export class ApiError extends Error {
  /**
   * The API's `detail`, unflattened.
   *
   * The routes validate with zod and return `detail: error.flatten()` on a
   * 400 — an object naming each field and what is wrong with it, which is by
   * far the most useful thing the server ever says. It used to be handed
   * straight to `Error(...)`, where an object stringifies to "[object
   * Object]": every field error destroyed at the boundary, and a page left
   * showing that literal text to someone who mistyped one input.
   *
   * Kept structured here so a form can put the message next to the field it
   * belongs to. `message` stays a readable sentence for callers that only
   * want one.
   */
  public detail?: string | FieldErrors;

  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
    detail?: string | FieldErrors,
  ) {
    super(message);
    this.detail = detail;
  }

  /**
   * Field errors as flat "field: problem" lines, or null if the API did not
   * send any. For the common case of listing what went wrong without building
   * a per-field UI.
   */
  get fieldMessages(): string[] | null {
    const d = this.detail;
    if (!d || typeof d === "string") return null;
    const out: string[] = [...(d.formErrors ?? [])];
    for (const [field, msgs] of Object.entries(d.fieldErrors ?? {})) {
      for (const m of msgs ?? []) out.push(`${field}: ${m}`);
    }
    return out.length > 0 ? out : null;
  }

  /** True when the API couldn't verify permissions, as opposed to
   * verifying them and saying no. */
  get isUnavailable() {
    return this.status === 503 || this.code === "permission_check_unavailable";
  }
}

/** One sentence from a zod flatten, for callers that only want a message. */
function summarise(detail: FieldErrors): string | null {
  const parts: string[] = [...(detail.formErrors ?? [])];
  for (const [field, msgs] of Object.entries(detail.fieldErrors ?? {})) {
    if (msgs?.length) parts.push(`${field}: ${msgs[0]}`);
  }
  if (parts.length === 0) return null;
  // Two is enough to be useful without becoming a wall in a toast.
  return parts.length <= 2 ? parts.join("; ") : `${parts.slice(0, 2).join("; ")} (+${parts.length - 2} more)`;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retried = false,
  reauthed = false,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include", // the session cookie is httpOnly; nothing else authenticates us
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    // reauthed is carried through, or a 429 landing between a re-auth and its
    // retry would reset the loop guard.
    return request<T>(path, init, true, reauthed);
  }

  if (res.status === 403) {

    const body = await res.clone().json().catch(() => ({}));

    if (body?.error === "banned") throw new BannedError(body.ban);

  }

  if (res.status === 401) {
    // Session expired or was never established. Sending them to login is the
    // only useful action, so do it rather than rendering an error — but try
    // to do it without destroying the page they are standing on.
    //
    // `reauthed` stops a loop: if the request still 401s after a sign-in that
    // reported success, something is wrong that signing in again won't fix.
    if (!reauthed && (await signIn())) {
      return request<T>(path, init, retried, true);
    }
    throw new ApiError(401, "not_authenticated", "Signing you in…");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));

    // A readable sentence for `message`, and the original structure kept on
    // `detail`. Passing an object as the message is what turned every zod
    // validation failure into "[object Object]".
    const detail = body.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail && typeof detail === "object"
        ? summarise(detail as FieldErrors) ?? body.error ?? `Request failed (${res.status})`
        : body.error ?? `Request failed (${res.status})`;

    throw new ApiError(res.status, body.error ?? "unknown_error", message, body.retryAfter, detail);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — mirroring what the API actually sends
// ---------------------------------------------------------------------------

export interface RateLimitCaps {
  submissionsPerDay: number;
  ticketsPerDay: number;
  giveawayEntriesPerDay: number;
  apiRequestsPerMinute: number;
  formsPerGuild: number;
  panelsPerGuild: number;
  rolesPerRuleType: number;
  historyRetentionDays: number;
}

export interface GuildSummary {
  /** Ready-to-use CDN URL, or null. The API sends this alongside the raw
   *  `icon` hash because building it needs the guild id too. */
  iconUrl: string | null;
  /** Whether the bot is actually in this server. Discord tells us which
   *  servers you can manage; it says nothing about where Appealy is. */
  installed: boolean;
  /** Where to send someone to add it, with this server preselected. */
  inviteUrl: string;
  id: string;
  name: string;
  icon: string | null;
  access: "owner" | "admin" | "manager";
}

export interface ShardStatus {
  id: number;
  state: number | null;
  rttMs: number | null;
}

export interface BotHealth {
  status: "ok" | "degraded";
  redis: "up" | "down";
  uptimeSeconds: number;
  guildsCached: number;
  cacheEntries: number;
  inFlightCacheLoads: number;
  shards: { available: boolean; shards: ShardStatus[] };
  memoryMb: number;
}

export interface Overview {
  guild: {
    id: string;
    name: string;
    iconHash: string | null;
    tier: "free" | "tier1" | "tier2" | "custom";
    hostingMode: "shared" | "custom";
    timezone: string;
  } | null;
  accessLevel: "admin" | "manager";
  isOwner: boolean;
  capacity: {
    caps: RateLimitCaps;
    used: Record<string, number>;
    resetsInSeconds: number;
  };
  activity: {
    pendingSubmissions: number;
    submissions24h: number;
    openTickets: number;
    runningGiveaways: number;
    statusBreakdown7d: Record<string, number>;
    submissionsByDay: { day: string; count: number }[];
  };
  security: {
    antiRaidEnabled: boolean;
    antiRaidAction: string | null;
    joinThreshold: number | null;
    windowSeconds: number | null;
    lockdown:
      | { active: false }
      | {
          active: true;
          triggeredAt: string;
          triggeredByJoinCount: number;
          expiresAt: string;
        };
  };
  /** null when the bot didn't answer the health probe within 2s. */
  bot: BotHealth | null;
  recentActivity: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  userId: string;
  changes?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ScheduledJob {
  id: string;
  kind: string;
  subjectId: string | null;
  runAt: string;
  attempts: number;
  lastError: string | null;
  claimed: boolean;
}

export interface Submission {
  id: string;
  formId: string;
  applicantId: string;
  status: "pending" | "accepted" | "denied" | "withdrawn";
  reviewerId: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  completionSeconds: number | null;
  createdAt: string;
}

export interface FormSummary {
  id: string;
  // The API has always sent this (forms.kind, "application" | "appeal") and
  // AppealConfig filters on it; it was simply never declared here.
  kind: "application" | "appeal";
  name: string;
  description: string | null;
  applicationType: "in_server" | "direct_message";
  active: boolean;
  cooldownSeconds: number;
  allowMultiplePending: boolean;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Typed escape hatch for pages that own their own request shapes.
 *
 * The named methods on `api` below stay the front door for anything shared.
 * This exists so a page covering one router can declare its own DTOs next to
 * the screen that renders them, instead of every shape in the product piling
 * into this file — and so those pages get the 401 re-auth, the 429 retry and
 * the ban handling for free rather than reimplementing fetch.
 */
export function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

/** Convenience wrappers, so a page body reads as what it does. */
export const http = {
  get: <T,>(path: string) => apiRequest<T>(path),
  post: <T,>(path: string, body: unknown) =>
    apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    apiRequest<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T,>(path: string) => apiRequest<T>(path, { method: "DELETE" }),
};

export const api = {
  loginUrl: () => `${BASE}/auth/discord/login`,

  /**
   * Explicit sign-in, for a button. Resolves true once the session exists.
   *
   * Prefer this over loginUrl() anywhere a person clicks: called from a click
   * handler it has user activation, so the popup opens instead of being
   * blocked, and the dashboard behind it survives.
   */
  signIn,

  me: () => request<{ userId: string }>("/auth/me"),

  myGuilds: () =>
    request<{ guilds: GuildSummary[]; discordReachable: boolean }>("/auth/me/guilds"),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  overview: (guildId: string) => request<Overview>(`/api/guilds/${guildId}/overview`),

  audit: (guildId: string, limit = 50, offset = 0) =>
    request<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>(
      `/api/guilds/${guildId}/overview/audit?limit=${limit}&offset=${offset}`,
    ),

  scheduledJobs: (guildId: string) =>
    request<{ jobs: ScheduledJob[] }>(`/api/guilds/${guildId}/overview/scheduled-jobs`),

  cancelJob: (guildId: string, jobId: string) =>
    request<void>(`/api/guilds/${guildId}/overview/scheduled-jobs/${jobId}`, {
      method: "DELETE",
    }),

  forms: (guildId: string) => request<FormSummary[]>(`/api/guilds/${guildId}/forms`),

  // --- Form accept outcomes ---
  outcomes: (guildId: string, formId: string, decision?: "accept" | "deny") =>
    request<{ outcomes: FormOutcomeDTO[] }>(
      `/api/guilds/${guildId}/forms/${formId}/outcomes${decision ? `?decision=${decision}` : ""}`,
    ),

  createOutcome: (guildId: string, formId: string, body: Partial<FormOutcomeDTO>) =>
    request<{ outcome: FormOutcomeDTO; warnings: string[] }>(
      `/api/guilds/${guildId}/forms/${formId}/outcomes`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateOutcome: (guildId: string, formId: string, outcomeId: string, body: Partial<FormOutcomeDTO>) =>
    request<{ outcome: FormOutcomeDTO }>(
      `/api/guilds/${guildId}/forms/${formId}/outcomes/${outcomeId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  deleteOutcome: (guildId: string, formId: string, outcomeId: string) =>
    request<{ deleted: boolean; revertedToSingleAccept: boolean }>(
      `/api/guilds/${guildId}/forms/${formId}/outcomes/${outcomeId}`,
      { method: "DELETE" },
    ),

  // --- Guild ban appeals (the product feature) ---
  appealConfig: (guildId: string) =>
    request<AppealConfigDTO>(`/api/guilds/${guildId}/appeal-config`),

  saveAppealConfig: (guildId: string, body: Partial<AppealConfigDTO>) =>
    request<AppealConfigDTO>(`/api/guilds/${guildId}/appeal-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // --- Platform bans (operator only; 404s for everyone else by design) ---
  opsAppeals: () => request<{ appeals: OpsAppeal[] }>("/api/ops/appeals"),

  decideAppeal: (id: string, decision: "accept" | "deny", note: string) =>
    request<void>(`/api/ops/appeals/${id}/${decision}`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  createPlatformBan: (body: {
    subject: "user" | "guild";
    subjectId: string;
    reasonCode: string;
    reasonPublic: string;
    notes?: string;
    expiresAt?: string | null;
  }) => request<{ id: string }>("/api/ops/bans", { method: "POST", body: JSON.stringify(body) }),

  submissions: (guildId: string, params: { status?: string; formId?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    const suffix = q.toString() ? `?${q}` : "";
    return request<Submission[]>(`/api/guilds/${guildId}/submissions${suffix}`);
  },

  antiRaid: (guildId: string) =>
    request<Record<string, unknown>>(`/api/guilds/${guildId}/anti-raid`),

  clearLockdown: (guildId: string) =>
    request<{ cleared: boolean }>(`/api/guilds/${guildId}/anti-raid/lockdown/clear`, {
      method: "POST",
    }),

  channels: (guildId: string) =>
    request<{ id: string; name: string; type: number; position: number }[]>(
      `/api/guilds/${guildId}/resources/channels`,
    ),

  roles: (guildId: string) =>
    request<{ id: string; name: string; color: number; position: number }[]>(
      `/api/guilds/${guildId}/resources/roles`,
    ),
};

// --- Types for the two appeal surfaces ---

export interface AppealConfigDTO {
  guildId: string;
  enabled: boolean;
  formId: string | null;
  dmOnBanEnabled: boolean;
  dmOnBanNote: string | null;
  autoUnbanOnAccept: boolean;
  updatedAt: string;
}

/** Operator view of a platform appeal — includes the internal ban fields that
 *  never leave /api/ops. */
export interface OpsAppeal {
  id: string;
  body: string;
  appellantId: string;
  createdAt: string;
  ban: {
    id: string;
    subject: "user" | "guild";
    subjectId: string;
    reasonCode: string;
    reasonPublic: string;
    createdAt: string;
    expiresAt: string | null;
    automated: boolean;
    notes: string | null;
    evidence: Record<string, unknown> | null;
  };
}

export interface FormOutcomeDTO {
  id: string;
  decision: "accept" | "deny";
  label: string;
  description: string | null;
  emoji: string | null;
  grantRoleIds: string[];
  removeRoleIds: string[];
  message: string | null;
  logChannelId: string | null;
  minStaffLevel: number;
  position: number;
  requiresConfirm: boolean;
  isNoop?: boolean;
}
