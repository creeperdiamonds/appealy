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

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

/**
 * Thrown when the API answers 403 { error: "banned" }. Carries the ban so the
 * shell can render the ban screen instead of a generic fatal error.
 *
 * Deliberately not a route: a banned account that can navigate to and from
 * /banned is one bad guard away from a redirect loop it cannot escape.
 */
export class BannedError extends Error {
  constructor(public ban: import("../../../shared/schema/platformBans.ts").PublicBan) {
    super("banned");
    this.name = "BannedError";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }

  /** True when the API couldn't verify permissions, as opposed to
   * verifying them and saying no. */
  get isUnavailable() {
    return this.status === 503 || this.code === "permission_check_unavailable";
  }
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include", // the session cookie is httpOnly; nothing else authenticates us
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get("Retry-After") ?? 2);
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    return request<T>(path, init, true);
  }

  if (res.status === 403) {

    const body = await res.clone().json().catch(() => ({}));

    if (body?.error === "banned") throw new BannedError(body.ban);

  }

  if (res.status === 401) {
    // Session expired or was never established. Sending them to login is
    // the only useful action, so do it rather than rendering an error.
    window.location.href = `${BASE}/auth/discord/login`;
    throw new ApiError(401, "not_authenticated", "Signing you in…");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error ?? "unknown_error",
      body.detail ?? body.error ?? `Request failed (${res.status})`,
      body.retryAfter,
    );
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

export const api = {
  loginUrl: () => `${BASE}/auth/discord/login`,

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
