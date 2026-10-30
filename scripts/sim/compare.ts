// scripts/sim/compare.ts
//
// Prints two simulation results side by side.
//
//   deno run --allow-read scripts/sim/compare.ts results/before.json results/after.json

const [beforePath, afterPath] = Deno.args;
if (!beforePath || !afterPath) throw new Error("usage: compare.ts <before.json> <after.json>");

// deno-lint-ignore no-explicit-any
const before: any = JSON.parse(await Deno.readTextFile(beforePath));
// deno-lint-ignore no-explicit-any
const after: any = JSON.parse(await Deno.readTextFile(afterPath));

const pad = (v: unknown, n: number) => String(v ?? "-").padStart(n);
const change = (a: number | undefined, b: number | undefined) => {
  if (a === undefined || b === undefined || a === 0) return "";
  const pct = Math.round(((b - a) / a) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
};

function row(label: string, a: number | undefined, b: number | undefined, unit = "") {
  console.log(`  ${label.padEnd(44)} ${pad(a, 9)} ${pad(b, 9)} ${pad(change(a, b), 7)}  ${unit}`);
}

console.log(`\nbefore = ${before.label} (${before.guilds} servers)   after = ${after.label} (${after.guilds} servers)`);
if (after.limits && Object.keys(after.limits).length) console.log(`after held to: ${JSON.stringify(after.limits)}`);

for (const phase of ["boot", "normal", "busy", "spike", "recovery"]) {
  const a = before.phases[phase];
  const b = after.phases[phase];
  if (!a || !b) continue;
  console.log(`\n${phase.toUpperCase()}${" ".repeat(46 - phase.length)} ${pad("before", 9)} ${pad("after", 9)}`);
  for (const proc of ["bot", "api"]) {
    const x = a.resources?.[proc] ?? {};
    const y = b.resources?.[proc] ?? {};
    row(`${proc} CPU, average`, x.avgMilliCpu, y.avgMilliCpu, "mCPU");
    row(`${proc} CPU, busiest 10s`, x.peak10sMilliCpu, y.peak10sMilliCpu, "mCPU");
    row(`${proc} memory, median private`, x.privateMedianMiB, y.privateMedianMiB, "MiB");
    row(`${proc} memory, peak since start`, x.peakPrivateMiB, y.peakPrivateMiB, "MiB");
  }
  row("Postgres CPU, average", a.resources?.postgres?.avgMilliCpu, b.resources?.postgres?.avgMilliCpu, "mCPU");
  row("whole machine CPU, average", a.resources?.machineCpuPercent, b.resources?.machineCpuPercent, "%");
  if (!a.traffic) continue;
  row("DB connections opened", a.database.connectionsOpenedPerMin, b.database.connectionsOpenedPerMin, "per min");
  row("DB queries", a.database.queriesPerMin, b.database.queriesPerMin, "per min");
  row("Redis commands", a.redis.commandsPerMin, b.redis.commandsPerMin, "per min");
  for (const [name, kind] of [
    ["first reply to a click", "ack:all"],
    ["click fully handled", "done:all"],
    ["dashboard request", "http:all"],
  ]) {
    const x = a.traffic.latency?.[kind];
    const y = b.traffic.latency?.[kind];
    row(`${name}, p50`, x?.p50, y?.p50, "ms");
    row(`${name}, p95`, x?.p95, y?.p95, "ms");
    row(`${name}, p99`, x?.p99, y?.p99, "ms");
  }
  const failures = (t: { counters?: Record<string, number> }) =>
    Object.entries(t.counters ?? {})
      .filter(([k]) => k === "missed_3s_deadline" || k.startsWith("unanswered:") || k.startsWith("flow_error") || k.startsWith("http_fail") || k.startsWith("http_error") || k === "ticket_not_created" || k === "gateway_closed")
      .reduce((sum, [, n]) => sum + n, 0);
  row("failures (missed deadlines, errors)", failures(a.traffic), failures(b.traffic), "");
}

console.log("\nLOGS");
for (const proc of ["bot", "api"]) {
  const x = before.logs?.[proc];
  const y = after.logs?.[proc];
  row(`${proc} log bytes`, x?.logBytes, y?.logBytes, "");
  row(`${proc} errors logged`, x?.levels?.error ?? 0, y?.levels?.error ?? 0, "");
  row(`${proc} worst event loop lag`, x?.eventLoopLagMs?.max, y?.eventLoopLagMs?.max, "ms");
}
