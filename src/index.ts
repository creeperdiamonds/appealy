// src/index.ts
//
// The public status page, on Cloudflare rather than Google Cloud.
//
// The one rule
// ------------
// A status page must survive the outage it reports. Appealy runs on one Cloud
// Run instance, so anything served from there — a route, a static file, a
// shared volume — goes down with the thing it is describing. This Worker
// shares nothing with it: not the hosting, not the database, not the DNS
// record.
//
// Where the data comes from
// -------------------------
// A check probes the dashboard and the API from outside, the way a visitor
// would reach them. The two things invisible from outside — Discord shards and
// the database — come from a heartbeat the bot posts every 30s. A heartbeat
// older than 90s means the bot is down: a dead process can't say so, but it
// stops saying anything, and that is the signal.
//
// When a check runs
// -----------------
// Three things start one, and any of them is enough:
//   - the Ticker Durable Object's alarm, which runs a check and sets its next
//     alarm for early in the next minute — the loop that keeps the page current
//     with nobody visiting;
//   - the Cron Trigger, every minute;
//   - a request for /status.json that finds the summary a minute old or more.
// The loop exists because Cloudflare's cron scheduler registered this Worker's
// trigger on a new Workers Free account and then never fired it, silently.
// Durable Object alarms are a separate mechanism. Every one of the three claims
// its minute in the `ticks` table first, so whichever arrives second does
// nothing and no minute is ever counted twice. Anything that reaches the Worker
// — a page view, the cron, a heartbeat — also restarts the loop if it stopped.
//
// Free-plan budget
// ----------------
// The page is a static asset, which costs nothing. /status.json reads one
// precomputed row and is edge-cached for 30s. A check does the expensive part at
// most once a minute: a few upserts, a read of 90 days of daily rows, and one
// write of the summary. Roughly 17k D1 rows written and 520k read per day,
// against limits of 100k and 5M. The loop is ~1,440 alarm runs a day, against a
// Durable Objects limit of 100k requests. See README.md.

import { DurableObject } from "cloudflare:workers";
import {
  buildSummary,
  dayKey,
  evaluate,
  historyDays,
  minuteOf,
  needsRefresh,
  nextAlarmAt,
  parseHeartbeat,
  type ComponentId,
  type DailyRow,
  type Heartbeat,
  type ProbeResult,
  type ReceivedHeartbeat,
  type State,
  type Summary,
} from "./model.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TICKER: DurableObjectNamespace<Ticker>;
  HEARTBEAT_SECRET: string;
  DASHBOARD_URL: string;
  API_URL: string;
}

const PROBE_TIMEOUT_MS = 8_000;
/** A real heartbeat is a few hundred bytes. */
const MAX_HEARTBEAT_BYTES = 64_000;
/** Minute claims older than a day are pruned; nothing ever reads them. */
const TICK_RETENTION_MINUTES = 1_440;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/heartbeat") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return receiveHeartbeat(request, env, ctx);
    }

    if (pathname === "/status.json") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      return serveSummary(request, env, ctx);
    }

    // Only reached for paths that aren't a file in public/ — those are served
    // before the Worker runs, and don't count against the request limit.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(keepLoopRunning(env));
    await tick(controller.scheduledTime, env);
  },
} satisfies ExportedHandler<Env>;

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow } });
}

// ---------------------------------------------------------------------------
// The check loop
// ---------------------------------------------------------------------------

/**
 * One instance, addressed by a fixed name, holding one alarm. Each alarm runs a
 * check and sets the next alarm, so once started it runs every minute on its
 * own. It keeps no state of its own; the alarm is the only thing it stores.
 */
export class Ticker extends DurableObject<Env> {
  /** Starts the loop if no alarm is set. One storage read when it's running. */
  async ensureRunning(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(nextAlarmAt(Date.now()));
    }
  }

  async alarm(): Promise<void> {
    try {
      await tick(Date.now(), this.env);
    } catch (error) {
      // Caught rather than thrown: a thrown alarm is retried with backoff,
      // which would stack retries on top of the next minute's run. One failed
      // minute is a gap; the loop carrying on matters more.
      console.error("status check failed", String(error));
    } finally {
      await this.ctx.storage.setAlarm(nextAlarmAt(Date.now()));
    }
  }
}

/** Anything that reaches the Worker calls this, so the loop can't stay stopped
 *  for longer than it takes someone to look at the page. */
async function keepLoopRunning(env: Env): Promise<void> {
  try {
    await env.TICKER.get(env.TICKER.idFromName("status")).ensureRunning();
  } catch (error) {
    console.error("could not start the check loop", String(error));
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/** Both sides are hashed first so the comparison is over equal lengths, and
 *  timingSafeEqual doesn't leak how much of a guessed secret was right. */
async function secretMatches(provided: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function receiveHeartbeat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await secretMatches(token, env.HEARTBEAT_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (Number(request.headers.get("content-length") ?? "0") > MAX_HEARTBEAT_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_HEARTBEAT_BYTES) return new Response("Payload too large", { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const heartbeat = parseHeartbeat(body);
  if (!heartbeat) return new Response("Invalid heartbeat", { status: 400 });

  await env.DB.prepare(
    `INSERT INTO heartbeat (id, received_at, body) VALUES (1, ?1, ?2)
     ON CONFLICT (id) DO UPDATE SET received_at = excluded.received_at, body = excluded.body`,
  )
    .bind(Date.now(), JSON.stringify(heartbeat))
    .run();

  // The bot calls every 30s, so while it's up the loop is checked twice a minute.
  ctx.waitUntil(keepLoopRunning(env));
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

type SummaryRow = { generated_at: number; body: string };

function readSummary(env: Env): Promise<SummaryRow | null> {
  return env.DB.prepare("SELECT generated_at, body FROM summary WHERE id = 1").first<SummaryRow>();
}

async function serveSummary(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL("/status.json", request.url).toString(), { method: "GET" });
  const cached = await cache.match(key);
  if (cached) return cached;

  // Past the edge cache, so at most about twice a minute per location.
  ctx.waitUntil(keepLoopRunning(env));

  const now = Date.now();
  let row = await readSummary(env);

  if (!row) {
    // Nothing has ever been checked. Run one now rather than answer "no data":
    // this request waits a few seconds once, instead of every visitor waiting
    // on a loop that has only just been started.
    await tick(now, env);
    row = await readSummary(env);
  } else if (needsRefresh(Number(row.generated_at), now)) {
    // Serve what there is immediately and bring it up to date behind it. The
    // minute lock means a crowd of stale requests still produces one check.
    ctx.waitUntil(
      tick(now, env).catch((error: unknown) => console.error("status refresh failed", String(error))),
    );
  }

  if (!row) {
    return Response.json({ error: "no_data" }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const response = new Response(row.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Short on purpose. The data is refreshed every minute, and a status page
      // that lags an outage by more than a refresh is lying.
      "cache-control": "public, max-age=30",
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function probe(url: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "appealy-status (+https://status.appealy.app)" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { ok: res.status === 200, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

/** One retry, so a single dropped connection doesn't paint a red minute. */
async function probeWithRetry(url: string): Promise<ProbeResult> {
  const first = await probe(url);
  return first.ok ? first : probe(url);
}

/**
 * One check, for the minute `time` falls in. Called by the loop, the cron and
 * stale requests alike; the first to claim the minute does the work, and any
 * other caller for that minute returns without touching the counts.
 */
async function tick(time: number, env: Env): Promise<void> {
  const minute = minuteOf(time);
  const claim = await env.DB.prepare("INSERT INTO ticks (minute) VALUES (?1) ON CONFLICT (minute) DO NOTHING")
    .bind(minute)
    .run();
  if (!claim.meta.changes) return;

  const [dashboard, api, beatRow, summaryRow] = await Promise.all([
    probeWithRetry(env.DASHBOARD_URL),
    probeWithRetry(env.API_URL),
    env.DB.prepare("SELECT received_at, body FROM heartbeat WHERE id = 1").first<{
      received_at: number;
      body: string;
    }>(),
    env.DB.prepare("SELECT body FROM summary WHERE id = 1").first<{ body: string }>(),
  ]);

  const beat: ReceivedHeartbeat | null = beatRow
    ? { receivedAt: Number(beatRow.received_at), heartbeat: JSON.parse(beatRow.body) as Heartbeat }
    : null;
  // Date.now(), not `time`, for staleness: the probes above may have taken
  // seconds, and a heartbeat that arrived during them is still fresh.
  const reading = evaluate(Date.now(), beat, dashboard, api);

  const day = dayKey(time);
  const oldestKept = historyDays(time)[0];
  const upsert = env.DB.prepare(
    `INSERT INTO daily (day, component, up, degraded, down) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (day, component) DO UPDATE SET
       up = up + excluded.up,
       degraded = degraded + excluded.degraded,
       down = down + excluded.down`,
  );

  // A null reading records nothing: a minute with no answer is left as a gap,
  // not counted as either up or down.
  const writes = (Object.entries(reading) as [ComponentId, State | null][])
    .filter((entry): entry is [ComponentId, State] => entry[1] !== null)
    .map(([id, state]) =>
      upsert.bind(day, id, state === "up" ? 1 : 0, state === "degraded" ? 1 : 0, state === "down" ? 1 : 0),
    );

  const results = await env.DB.batch([
    ...writes,
    env.DB.prepare("DELETE FROM daily WHERE day < ?1").bind(oldestKept),
    env.DB.prepare("DELETE FROM ticks WHERE minute < ?1").bind(minute - TICK_RETENTION_MINUTES),
    env.DB.prepare("SELECT day, component, up, degraded, down FROM daily WHERE day >= ?1").bind(oldestKept),
  ]);
  const rows = (results[results.length - 1].results ?? []) as DailyRow[];

  const previous = summaryRow ? (JSON.parse(summaryRow.body) as Summary) : null;
  const summary = buildSummary(time, reading, previous, rows, beat);

  await env.DB.prepare(
    `INSERT INTO summary (id, generated_at, body) VALUES (1, ?1, ?2)
     ON CONFLICT (id) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body`,
  )
    .bind(time, JSON.stringify(summary))
    .run();
}
