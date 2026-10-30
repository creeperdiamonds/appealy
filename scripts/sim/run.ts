// scripts/sim/run.ts
//
// One simulation run: a throwaway Postgres and Redis, the fake Discord, the real
// bot and API from --repo, then a fixed schedule of traffic, measuring as it
// goes. See README.md in this folder.
//
//   deno run -A -c bot/deno.json scripts/sim/run.ts --label before --repo <path> \
//     --pg-bin <dir> --redis-bin <dir> --out <dir>

import postgres from "postgres";
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { dirname, fromFileUrl, join, resolve, toFileUrl } from "jsr:@std/path@1";
import { migrate, seed, SESSION_COUNT, sessionId } from "./seed.ts";
import { APP_ID, SIM_TOKEN } from "./world.ts";

const args = parseArgs(Deno.args, {
  string: ["label", "repo", "api-dir", "pg-bin", "redis-bin", "out", "bot-v8", "api-node", "limits", "phases", "spike-factor"],
  default: { guilds: "50", "bot-v8": "", "api-node": "", limits: "", scale: "1", "spike-factor": "1" },
});

const HERE = dirname(fromFileUrl(import.meta.url));
const REPO = resolve(args.repo ?? join(HERE, "..", ".."));
// Laid out like the API image: dist/, node_modules/ and shared/ with no
// package.json above them. Run from api/ instead, Node takes the compiled shared/
// files (CommonJS) for ES modules because api/package.json says "type": "module".
const API_DIR = resolve(args["api-dir"] ?? join(REPO, "api"));
const PG_BIN = args["pg-bin"];
const REDIS_BIN = args["redis-bin"];
const OUT = resolve(args.out ?? ".");
const LABEL = args.label ?? "run";
const GUILDS = Number(args.guilds);
if (!PG_BIN || !REDIS_BIN) throw new Error("--pg-bin and --redis-bin are required");

const PORTS = { pg: 55432, redis: 56379, discord: 59000, bot: 59090, api: 53001 };
const DATABASE_URL = `postgres://appealy@127.0.0.1:${PORTS.pg}/appealy`;
const REDIS_URL = `redis://127.0.0.1:${PORTS.redis}`;
const DISCORD_ORIGIN = `http://127.0.0.1:${PORTS.discord}`;
// A throwaway key for rows in a throwaway database.
const TOKEN_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const WORK = join(OUT, `${LABEL}.work`);
await Deno.mkdir(OUT, { recursive: true });
await Deno.remove(WORK, { recursive: true }).catch(() => {});
await Deno.mkdir(WORK, { recursive: true });

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Traffic schedule. Rates are per 50 servers and scale with --guilds.
//
// "normal" comes from production: about 3 KB/s arrives from the internet at 188
// servers, which is at most ~2 gateway events a second, so 0.5 for 50 servers;
// about 31 applications a day across all servers; 0.08 HTTP requests a second.
// "busy" and "spike" are deliberately far above anything production has seen, so
// there are enough samples to compare latency and to find out where things bend.
// ---------------------------------------------------------------------------

const k = GUILDS / 50;
const scale = Number(args.scale);
const NORMAL = { messages: 0.5 * k, joins: 0.01 * k, leaves: 0.005 * k, memberUpdates: 0.02 * k, interactions: 0.01 * k, dashboard: 0.02 * k };
const BUSY = { messages: 5 * k, joins: 0.5 * k, leaves: 0.25 * k, memberUpdates: 0.5 * k, interactions: 1 * k, dashboard: 2 * k };
// --spike-factor finds where things start to bend without changing the other phases.
const f = Number(args["spike-factor"]);
const SPIKE = { messages: 50 * k * f, joins: 2 * k * f, leaves: 1 * k * f, memberUpdates: 5 * k * f, interactions: 5 * k * f, dashboard: 10 * k * f, raidJoins: 10 };

const ALL_PHASES: Array<{ name: string; seconds: number; rates: typeof NORMAL }> = [
  { name: "normal", seconds: 360, rates: NORMAL },
  { name: "busy", seconds: 300, rates: BUSY },
  { name: "spike", seconds: 60, rates: SPIKE },
  { name: "recovery", seconds: 180, rates: NORMAL },
];
const wanted = args.phases?.split(",");
const PHASES = ALL_PHASES
  .filter((p) => !wanted || wanted.includes(p.name))
  .map((p) => ({ ...p, seconds: Math.max(20, Math.round(p.seconds * scale)) }));

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const children: Array<{ name: string; proc: Deno.ChildProcess }> = [];
let stopping = false;

async function runOnce(cmd: string, argv: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command(cmd, { args: argv, env, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`${cmd} ${argv.join(" ")} failed:\n${new TextDecoder().decode(out.stderr)}\n${new TextDecoder().decode(out.stdout)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function spawnLogged(name: string, cmd: string, argv: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const proc = new Deno.Command(cmd, {
    args: argv,
    env: opts.env ?? {},
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const file = await Deno.open(join(WORK, `${name}.log`), { write: true, create: true, append: true });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) await file.write(chunk);
  };
  void Promise.all([pump(proc.stdout), pump(proc.stderr)]).catch((err) => log(`${name} log: ${err}`));
  // Said out loud: a process dying mid-run invalidates the numbers.
  void proc.status.then((status) => {
    if (!stopping) log(`!! ${name} exited early with code ${status.code}; see ${name}.log`);
  });
  children.push({ name, proc });
  return proc;
}

function parseLimits(spec: string) {
  // "bot=0.25:512,api=0.15:384": a share of one logical CPU, and MiB.
  const out: Record<string, { cpu: number; mem: number }> = {};
  for (const part of spec.split(",").filter(Boolean)) {
    const [name, rest] = part.split("=");
    const [cpu, mem] = rest.split(":");
    out[name] = { cpu: Number(cpu), mem: Number(mem ?? 0) };
  }
  return out;
}

const limits = parseLimits(args.limits);
let limiter: { write: (line: string) => Promise<void>; next: () => Promise<string> } | null = null;

async function startLimiter() {
  const proc = new Deno.Command("powershell", {
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "limit-daemon.ps1")],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  children.push({ name: "limiter", proc });
  const writer = proc.stdin.getWriter();
  const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const next = async () => {
    while (!buffer.includes("\n")) {
      const { value, done } = await lines.read();
      if (done) throw new Error("limiter exited");
      buffer += value;
    }
    const at = buffer.indexOf("\n");
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    return line;
  };
  if ((await next()) !== "ready") throw new Error("limiter did not start");
  limiter = {
    write: (line) => writer.write(new TextEncoder().encode(line + "\n")),
    next,
  };
}

async function applyLimit(name: string, pid: number) {
  const l = limits[name];
  if (!l || !limiter) return;
  await limiter.write(`${pid} ${l.cpu} ${l.mem}`);
  const answer = await limiter.next();
  if (!answer.startsWith("ok")) throw new Error(`could not limit ${name}: ${answer}`);
  log(`  ${name} held to ${l.cpu} of a CPU and ${l.mem} MiB`);
}

async function cleanup() {
  stopping = true;
  for (const { proc } of [...children].reverse()) {
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  await runOnce(join(PG_BIN!, "pg_ctl.exe"), ["-D", join(WORK, "pg"), "-m", "immediate", "-w", "stop"]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

const samples: Array<Record<string, any>> = [];

function startSampler(botPid: number, apiPid: number) {
  const proc = new Deno.Command("powershell", {
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "sampler.ps1"), "-BotPid", String(botPid), "-ApiPid", String(apiPid)],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  children.push({ name: "sampler", proc });
  void (async () => {
    let buffer = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) samples.push(JSON.parse(line));
      }
    }
  })().catch(() => {});
}

const MiB = 1024 * 1024;

function resourceStats(fromAt: number, toAt: number) {
  const inRange = samples.filter((s) => s.at >= fromAt && s.at <= toAt);
  const out: Record<string, unknown> = {};
  if (inRange.length < 2) return out;
  const machine = inRange.map((s) => Number(s.machine ?? 0));
  out.machineCpuPercent = Math.round(machine.reduce((a, b) => a + b, 0) / machine.length);
  for (const name of ["bot", "api", "postgres", "redis-server"]) {
    const rows = inRange.filter((s) => s[name]);
    if (rows.length < 2) continue;
    const first = rows[0];
    const last = rows.at(-1)!;
    const seconds = (last.at - first.at) / 1000;
    const cpuSeconds = (last[name].cpu - first[name].cpu) / 1000;
    // Busiest 10 seconds, because a burst is what a low CPU limit actually squeezes.
    let peak = 0;
    for (let i = 0; i < rows.length; i++) {
      const j = rows.findIndex((r, idx) => idx > i && r.at - rows[i].at >= 10_000);
      if (j < 0) break;
      peak = Math.max(peak, (rows[j][name].cpu - rows[i][name].cpu) / (rows[j].at - rows[i].at));
    }
    const ws = rows.map((r) => r[name].ws / MiB).sort((a, b) => a - b);
    const priv = rows.filter((r) => r[name].priv).map((r) => r[name].priv / MiB).sort((a, b) => a - b);
    out[name] = {
      avgMilliCpu: Math.round((cpuSeconds / seconds) * 1000 * 10) / 10,
      peak10sMilliCpu: Math.round(peak * 1000),
      memMedianMiB: Math.round(ws[Math.floor(ws.length / 2)]),
      memMaxMiB: Math.round(ws.at(-1)!),
      ...(priv.length ? { privateMedianMiB: Math.round(priv[Math.floor(priv.length / 2)]), privateMaxMiB: Math.round(priv.at(-1)!) } : {}),
      // Since the process started, so a peak between two samples still counts.
      ...(last[name].peakWs ? { peakWsMiB: Math.round(last[name].peakWs / MiB), peakPrivateMiB: Math.round(last[name].peakPriv / MiB) } : {}),
    };
  }
  return out;
}

async function redisInfo(): Promise<Record<string, number>> {
  const out = await runOnce(join(REDIS_BIN!, "redis-cli.exe"), ["-p", String(PORTS.redis), "info", "commandstats"]);
  const stats: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^cmdstat_([^:]+):calls=(\d+)/);
    if (m && m[1] !== "info") stats[m[1]] = Number(m[2]);
  }
  return stats;
}

function diffCounts(after: Record<string, number>, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d) out[k] = d;
  }
  return out;
}

async function waitFor(what: string, test: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const results: Record<string, any> = {
  label: LABEL,
  guilds: GUILDS,
  repo: REPO,
  botV8: args["bot-v8"],
  apiNode: args["api-node"],
  limits,
  startedAt: new Date().toISOString(),
  phases: {},
};

try {
  log(`Starting Postgres and Redis for "${LABEL}" with ${GUILDS} servers`);
  const pgData = join(WORK, "pg");
  await runOnce(join(PG_BIN, "initdb.exe"), ["-D", pgData, "-U", "appealy", "-A", "trust", "-E", "UTF8", "--locale=C"]);
  // max_connections matches the production db-f1-micro.
  await Deno.writeTextFile(join(pgData, "postgresql.conf"), `
port = ${PORTS.pg}
listen_addresses = '127.0.0.1'
max_connections = 25
shared_buffers = 64MB
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
fsync = on
synchronous_commit = on
log_min_messages = warning
`, { append: true });
  // Not runOnce: the server inherits pg_ctl's pipes, so waiting on them never ends.
  const pgStart = await new Deno.Command(join(PG_BIN, "pg_ctl.exe"), {
    args: ["-D", pgData, "-l", join(WORK, "postgres.log"), "-w", "start"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn().status;
  if (!pgStart.success) throw new Error(`Postgres didn't start; see ${join(WORK, "postgres.log")}`);
  await runOnce(join(PG_BIN, "createdb.exe"), ["-p", String(PORTS.pg), "-U", "appealy", "appealy"]);

  await spawnLogged("redis", join(REDIS_BIN, "redis-server.exe"), ["--port", String(PORTS.redis), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"]);
  await waitFor("Redis", async () => {
    await runOnce(join(REDIS_BIN!, "redis-cli.exe"), ["-p", String(PORTS.redis), "ping"]);
    return true;
  }, 15_000);

  await migrate(DATABASE_URL, REPO);
  await seed(DATABASE_URL, GUILDS, TOKEN_KEY);

  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {}, connection: { application_name: "sim-harness" } });
  await sql`create extension if not exists pg_stat_statements`;

  await spawnLogged("discord", Deno.execPath(), [
    "run", "--no-lock", "--allow-net=127.0.0.1", "--allow-env", "-c", join(HERE, "..", "..", "bot", "deno.json"), join(HERE, "fake-discord.ts"),
  ], {
    env: {
      SIM_PORT: String(PORTS.discord),
      SIM_GUILDS: String(GUILDS),
      SIM_API_ORIGIN: `http://127.0.0.1:${PORTS.api}`,
      SIM_SESSIONS: Array.from({ length: SESSION_COUNT }, (_, i) => sessionId(i)).join(","),
    },
  });
  await waitFor("fake Discord", async () => (await (await fetch(`${DISCORD_ORIGIN}/__sim/state`)).json()) !== null, 30_000);

  if (Object.keys(limits).length) await startLimiter();

  // Values production gets from Secret Manager. All fake, and useless anywhere else.
  const shared = {
    APPEALY_ENV: "production",
    DEPLOYMENT_MODE: "platform",
    LOG_LEVEL: "info",
    INTERNAL_RPC_SECRET: "sim-internal-secret",
    DATABASE_URL,
    REDIS_URL,
    DISCORD_BOT_TOKEN: SIM_TOKEN,
    DISCORD_APPLICATION_ID: APP_ID.toString(),
    DISCORD_PUBLIC_KEY: "0".repeat(64),
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    PADDLE_API_KEY: "sim_paddle_key",
    PADDLE_WEBHOOK_SECRET: "sim_paddle_secret",
    SIM_DISCORD_ORIGIN: DISCORD_ORIGIN,
  };

  log("Starting the bot");
  const bootAt = Date.now();
  const botV8 = args["bot-v8"] ? [`--v8-flags=${args["bot-v8"]}`] : [];
  const bot = await spawnLogged("bot", Deno.execPath(), [
    "run",
    // 0.0.0.0 only because the control server binds there. Nothing off this
    // machine is reachable, which is the point.
    "--allow-net=127.0.0.1,localhost,0.0.0.0",
    "--allow-env",
    "--allow-read",
    "--allow-sys=hostname",
    ...botV8,
    "-c", join(REPO, "bot", "deno.json"),
    join(HERE, "bot-entry.ts"),
  ], {
    cwd: join(REPO, "bot"),
    env: {
      ...shared,
      BOT_INTERNAL_PORT: String(PORTS.bot),
      DASHBOARD_BASE_URL: "http://127.0.0.1/dashboard",
      STATUS_HEARTBEAT_URL: `${DISCORD_ORIGIN}/__status`,
      STATUS_HEARTBEAT_SECRET: "sim-status-secret",
      SIM_BOT_MAIN: toFileUrl(join(REPO, "bot", "src", "main.ts")).href,
    },
  });
  await applyLimit("bot", bot.pid);

  log("Starting the API");
  const apiNode = args["api-node"] ? args["api-node"].split(" ") : [];
  const api = await spawnLogged("api", "node", [
    ...apiNode,
    "--import", toFileUrl(join(HERE, "api-preload.mjs")).href,
    "dist/api/src/main.js",
  ], {
    cwd: API_DIR,
    env: {
      ...shared,
      PORT: String(PORTS.api),
      NODE_ENV: "production",
      BOT_INTERNAL_URL: `http://127.0.0.1:${PORTS.bot}`,
      DISCORD_REDIRECT_URI: "http://127.0.0.1/auth/discord/callback",
      FRONTEND_ORIGIN: "http://127.0.0.1",
      DISCORD_CLIENT_ID: APP_ID.toString(),
      DISCORD_CLIENT_SECRET: "sim-client-secret",
      SESSION_SECRET: "sim-session-secret-sim-session-secret",
      OPS_USER_IDS: "",
      PADDLE_ENV: "sandbox",
      PADDLE_CHECKOUT_URL: "http://127.0.0.1/pay",
      PADDLE_CLIENT_TOKEN: "test_sim",
      TOPGG_WEBHOOK_SECRET: "sim-topgg",
    },
  });
  await applyLimit("api", api.pid);
  startSampler(bot.pid, api.pid);

  // Boot: from starting the processes to every server having arrived and the API
  // answering. Holds the memory peak that decides how low a limit can go.
  await waitFor("the gateway burst", async () => {
    const state = await (await fetch(`${DISCORD_ORIGIN}/__sim/state`)).json();
    return state.burstDone;
  }, 180_000);
  await waitFor("the API", async () => (await fetch(`http://127.0.0.1:${PORTS.api}/health`)).ok, 60_000);
  const readyAt = Date.now();
  log(`Up in ${((readyAt - bootAt) / 1000).toFixed(1)}s; settling`);
  await sleep(20_000);
  const settled = Date.now();
  results.phases.boot = { seconds: (readyAt - bootAt) / 1000, resources: resourceStats(bootAt - 2000, settled) };

  const snapshot = async () => {
    const [db] = await sql`select sessions, xact_commit, xact_rollback, blks_read, blks_hit, tup_inserted, tup_updated, tup_deleted, tup_fetched, tup_returned
      from pg_stat_database where datname = 'appealy'`;
    const [backends] = await sql`select count(*)::int n from pg_stat_activity where datname = 'appealy' and application_name <> 'sim-harness'`;
    return { db: Object.fromEntries(Object.entries(db).map(([k, v]) => [k, Number(v)])), backends: backends.n, redis: await redisInfo() };
  };

  for (const phase of PHASES) {
    log(`Phase "${phase.name}": ${phase.seconds}s`);
    await sql`select pg_stat_statements_reset()`;
    await sql`select pg_stat_reset()`.catch(() => {});
    await sleep(1_100); // pg_stat_database reports with up to a second's delay
    const before = await snapshot();
    const startAt = Date.now();

    const res = await fetch(`${DISCORD_ORIGIN}/__sim/phase`, {
      method: "POST",
      body: JSON.stringify({ seconds: phase.seconds, rates: phase.rates }),
    });
    const traffic = await res.json();
    const endAt = Date.now();
    await sleep(1_100);
    const after = await snapshot();
    const minutes = (endAt - startAt) / 60_000;

    const statements = await sql`select left(regexp_replace(query, '\\s+', ' ', 'g'), 110) q, calls::int, round(total_exec_time)::int total_ms
      from pg_stat_statements where query not like '%pg_stat%' order by calls desc limit 12`;
    const redisDelta = diffCounts(after.redis, before.redis);
    const redisTotal = Object.values(redisDelta).reduce((a, b) => a + b, 0);
    const totalCalls = (await sql`select coalesce(sum(calls),0)::int n from pg_stat_statements where query not like '%pg_stat%'`)[0].n;

    results.phases[phase.name] = {
      seconds: (endAt - startAt) / 1000,
      rates: phase.rates,
      resources: resourceStats(startAt, endAt),
      traffic,
      database: {
        // The harness's own connection is already open, so these are all the app's.
        connectionsOpenedPerMin: Math.round(((after.db.sessions - before.db.sessions) / minutes) * 10) / 10,
        openNow: after.backends,
        queriesPerMin: Math.round(totalCalls / minutes),
        commitsPerMin: Math.round((after.db.xact_commit - before.db.xact_commit) / minutes),
        topStatements: statements,
      },
      redis: { commandsPerMin: Math.round(redisTotal / minutes), byCommand: redisDelta },
    };
    const lat = traffic.latency?.["ack:all"];
    log(`  done: ack p50=${lat?.p50 ?? "-"} p95=${lat?.p95 ?? "-"} p99=${lat?.p99 ?? "-"} ms (n=${lat?.n ?? 0}), missed=${traffic.counters?.missed_3s_deadline ?? 0}`);
  }

  await sql.end();
} finally {
  await sleep(500);
  await cleanup();
}

// Logs: what the app itself reported, and how much it wrote.
async function logSummary(name: string) {
  const text = await Deno.readTextFile(join(WORK, `${name}.log`)).catch(() => "");
  const levels: Record<string, number> = {};
  const messages = new Map<string, number>();
  const heap: Array<Record<string, number>> = [];
  let bytes = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.sim === name) {
        heap.push(entry);
        continue;
      }
      if (entry.sim === "blocked") {
        levels.blocked = (levels.blocked ?? 0) + 1;
        continue;
      }
      bytes += line.length + 1;
      const level = entry.level ?? "other";
      levels[level] = (levels[level] ?? 0) + 1;
      if (level === "error" || level === "warn") {
        const key = `${level}: ${String(entry.msg).slice(0, 100)}`;
        messages.set(key, (messages.get(key) ?? 0) + 1);
      }
    } catch {
      bytes += line.length + 1;
      levels.plain = (levels.plain ?? 0) + 1;
    }
  }
  const worst = [...messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([msg, n]) => ({ msg, n }));
  const lag = heap.map((h) => h.lagMs ?? 0).sort((a, b) => a - b);
  const heapUsed = heap.map((h) => (h.heapUsed ?? 0) / MiB).sort((a, b) => a - b);
  return {
    levels,
    logBytes: bytes,
    worst,
    eventLoopLagMs: lag.length ? { p50: lag[Math.floor(lag.length / 2)], max: lag.at(-1) } : null,
    heapUsedMiB: heapUsed.length ? { median: Math.round(heapUsed[Math.floor(heapUsed.length / 2)]), max: Math.round(heapUsed.at(-1)!) } : null,
  };
}

results.logs = { bot: await logSummary("bot"), api: await logSummary("api") };
results.finishedAt = new Date().toISOString();
await Deno.writeTextFile(join(OUT, `${LABEL}.json`), JSON.stringify(results, null, 2));
log(`Wrote ${join(OUT, `${LABEL}.json`)}`);
Deno.exit(0);
