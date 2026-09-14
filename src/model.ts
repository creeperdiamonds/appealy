// src/model.ts
//
// Everything the status Worker decides, with no I/O: what a probe result
// means, how a heartbeat rolls up, and what the page is sent. Nothing in here
// touches a binding, so it runs under `node --test` without Cloudflare's
// runtime.

export type State = "up" | "degraded" | "down";
export type ComponentId = "bot" | "dashboard" | "api" | "database";

/** Page order. The bot first: it is what most people mean by "Appealy". */
export const COMPONENTS: readonly { id: ComponentId; name: string }[] = [
  { id: "bot", name: "Discord bot" },
  { id: "dashboard", name: "Dashboard" },
  { id: "api", name: "API" },
  { id: "database", name: "Database" },
];

export const HISTORY_DAYS = 90;
/** The bot posts every 30s. Three missed beats is not a blip. */
export const HEARTBEAT_STALE_MS = 90_000;
/** A probe that answers, but slower than this, reads as degraded. */
export const SLOW_PROBE_MS = 2_500;
/** Bounds what a heartbeat may claim, so parsing one stays cheap. */
export const MAX_SHARDS = 1_024;

const DAY_MS = 86_400_000;

export interface ProbeResult {
  ok: boolean;
  ms: number;
}

export interface ShardReport {
  id: number;
  state: State;
}

export interface Heartbeat {
  sentAt: string;
  totalShards: number;
  shards: ShardReport[];
  database: "up" | "down";
}

/** The last heartbeat, stamped with when the Worker received it. The Worker's
 *  clock decides staleness, never the bot's, so clock skew can't fake a pulse. */
export interface ReceivedHeartbeat {
  receivedAt: number;
  heartbeat: Heartbeat;
}

/** Minutes spent in each state on one UTC day. */
export interface DayCounts {
  day: string;
  up: number;
  degraded: number;
  down: number;
}

export interface DailyRow extends DayCounts {
  component: string;
}

export interface Reading {
  bot: State;
  dashboard: State;
  api: State;
  /** Null when the bot is silent: its check is the only view of the database,
   *  and a missing answer is not the same as a database that is down. */
  database: State | null;
}

export interface ComponentSummary {
  id: ComponentId;
  name: string;
  state: State | null;
  since: string | null;
  /** Percentage over the days that have data, or null if none do. */
  uptime: number | null;
  /** Oldest first, one entry per day, null where nothing was recorded. */
  days: (DayCounts | null)[];
}

export interface Summary {
  generatedAt: string;
  overall: State;
  components: ComponentSummary[];
  shards: { reportedAt: string; totalShards: number; list: ShardReport[] } | null;
}

const STATES: ReadonlySet<string> = new Set(["up", "degraded", "down"]);

export function classifyProbe(probe: ProbeResult): State {
  if (!probe.ok) return "down";
  return probe.ms > SLOW_PROBE_MS ? "degraded" : "up";
}

/**
 * Some shards down is reported as degraded, not down: most servers are still
 * being answered. The page still shows exactly which shards are out, and the
 * lookup tells someone whether theirs is one of them.
 */
export function rollupShards(shards: readonly ShardReport[]): State {
  if (shards.length === 0) return "down";
  const down = shards.filter((s) => s.state === "down").length;
  if (down === shards.length) return "down";
  if (down > 0 || shards.some((s) => s.state === "degraded")) return "degraded";
  return "up";
}

/** Accepts only the exact shape the bot sends. Anything else is rejected
 *  whole rather than partly stored. */
export function parseHeartbeat(input: unknown): Heartbeat | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;

  if (typeof o.sentAt !== "string" || Number.isNaN(Date.parse(o.sentAt))) return null;
  const total = o.totalShards;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1 || total > MAX_SHARDS) return null;
  if (o.database !== "up" && o.database !== "down") return null;
  if (!Array.isArray(o.shards) || o.shards.length > total) return null;

  const shards: ShardReport[] = [];
  const seen = new Set<number>();
  for (const entry of o.shards) {
    if (typeof entry !== "object" || entry === null) return null;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== "number" || !Number.isInteger(s.id) || s.id < 0 || s.id >= total) return null;
    if (seen.has(s.id)) return null;
    if (typeof s.state !== "string" || !STATES.has(s.state)) return null;
    seen.add(s.id);
    shards.push({ id: s.id, state: s.state as State });
  }

  return { sentAt: o.sentAt, totalShards: total, shards, database: o.database };
}

export function evaluate(
  now: number,
  beat: ReceivedHeartbeat | null,
  dashboard: ProbeResult,
  api: ProbeResult,
): Reading {
  const fresh = beat !== null && now - beat.receivedAt <= HEARTBEAT_STALE_MS;
  return {
    bot: fresh ? rollupShards(beat.heartbeat.shards) : "down",
    dashboard: classifyProbe(dashboard),
    api: classifyProbe(api),
    database: fresh ? beat.heartbeat.database : null,
  };
}

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A summary older than this is refreshed by the next request for it. */
export const REFRESH_AFTER_MS = 60_000;

/** The minute a timestamp falls in: the key a check claims so each minute is
 *  counted exactly once, whether a cron or a request got there first. */
export function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

export function needsRefresh(generatedAt: number, now: number): boolean {
  return now - generatedAt >= REFRESH_AFTER_MS;
}

/** The last HISTORY_DAYS UTC days, oldest first, ending with today. */
export function historyDays(now: number): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) days.push(dayKey(today - i * DAY_MS));
  return days;
}

/** Slow still counts as available. Floored, so a single bad minute can never
 *  round up to a clean 100%. */
export function uptime(series: readonly (DayCounts | null)[]): number | null {
  let good = 0;
  let total = 0;
  for (const d of series) {
    if (!d) continue;
    good += d.up + d.degraded;
    total += d.up + d.degraded + d.down;
  }
  return total === 0 ? null : Math.floor((good / total) * 10_000) / 100;
}

export function worst(states: readonly (State | null)[]): State {
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  return "up";
}

export function buildSummary(
  now: number,
  reading: Reading,
  previous: Summary | null,
  rows: readonly DailyRow[],
  beat: ReceivedHeartbeat | null,
): Summary {
  const nowIso = new Date(now).toISOString();
  const days = historyDays(now);
  const byKey = new Map(rows.map((r) => [`${r.component}|${r.day}`, r]));

  const components = COMPONENTS.map(({ id, name }): ComponentSummary => {
    const state = reading[id];
    const before = previous?.components.find((c) => c.id === id);
    // `since` is when the state last changed, not when it was last checked:
    // "down for 3 minutes" and "down since Tuesday" are different messages.
    const since = state === null ? null : before && before.state === state && before.since ? before.since : nowIso;
    const series = days.map((day) => {
      const r = byKey.get(`${id}|${day}`);
      return r ? { day, up: Number(r.up), degraded: Number(r.degraded), down: Number(r.down) } : null;
    });
    return { id, name, state, since, uptime: uptime(series), days: series };
  });

  return {
    generatedAt: nowIso,
    overall: worst(components.map((c) => c.state)),
    components,
    shards: beat
      ? {
          reportedAt: new Date(beat.receivedAt).toISOString(),
          totalShards: beat.heartbeat.totalShards,
          list: beat.heartbeat.shards,
        }
      : null,
  };
}
