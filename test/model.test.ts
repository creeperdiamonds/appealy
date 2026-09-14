// test/model.test.ts
//
// Run with `npm test`. Node strips the types itself, so these run
// without a build step and without Cloudflare's runtime.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEARTBEAT_STALE_MS,
  HISTORY_DAYS,
  SLOW_PROBE_MS,
  buildSummary,
  classifyProbe,
  evaluate,
  historyDays,
  parseHeartbeat,
  rollupShards,
  uptime,
  type Heartbeat,
  type Reading,
} from "../src/model.ts";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  sentAt: "2026-09-14T11:59:50Z",
  totalShards: 2,
  shards: [
    { id: 0, state: "up" },
    { id: 1, state: "up" },
  ],
  database: "up",
  ...over,
});

test("a probe is down when it fails, degraded when slow, up otherwise", () => {
  assert.equal(classifyProbe({ ok: false, ms: 10 }), "down");
  assert.equal(classifyProbe({ ok: true, ms: SLOW_PROBE_MS + 1 }), "degraded");
  assert.equal(classifyProbe({ ok: true, ms: 120 }), "up");
});

test("shards roll up: all down is down, some down or slow is degraded", () => {
  assert.equal(rollupShards([]), "down");
  assert.equal(rollupShards([{ id: 0, state: "down" }, { id: 1, state: "down" }]), "down");
  assert.equal(rollupShards([{ id: 0, state: "down" }, { id: 1, state: "up" }]), "degraded");
  assert.equal(rollupShards([{ id: 0, state: "degraded" }, { id: 1, state: "up" }]), "degraded");
  assert.equal(rollupShards([{ id: 0, state: "up" }, { id: 1, state: "up" }]), "up");
});

test("parseHeartbeat accepts the bot's shape and rejects anything else", () => {
  assert.deepEqual(parseHeartbeat(beat()), beat());
  assert.equal(parseHeartbeat(null), null);
  assert.equal(parseHeartbeat({ ...beat(), database: "maybe" }), null);
  assert.equal(parseHeartbeat({ ...beat(), totalShards: 0 }), null);
  assert.equal(parseHeartbeat({ ...beat(), sentAt: "yesterday" }), null);
  // An id outside the declared shard count, or the same shard twice.
  assert.equal(parseHeartbeat(beat({ shards: [{ id: 2, state: "up" }] })), null);
  assert.equal(parseHeartbeat(beat({ shards: [{ id: 0, state: "up" }, { id: 0, state: "up" }] })), null);
  assert.equal(parseHeartbeat({ ...beat(), shards: [{ id: 0, state: "sideways" }] }), null);
});

test("a stale heartbeat makes the bot down and the database unknown", () => {
  const ok = { ok: true, ms: 100 };
  const fresh = evaluate(NOW, { receivedAt: NOW - 30_000, heartbeat: beat() }, ok, ok);
  assert.deepEqual(fresh, { bot: "up", dashboard: "up", api: "up", database: "up" });

  const stale = evaluate(NOW, { receivedAt: NOW - HEARTBEAT_STALE_MS - 1, heartbeat: beat() }, ok, ok);
  assert.equal(stale.bot, "down");
  assert.equal(stale.database, null);

  assert.equal(evaluate(NOW, null, ok, ok).bot, "down");
});

test("history covers the last 90 UTC days, oldest first, ending today", () => {
  const days = historyDays(NOW);
  assert.equal(days.length, HISTORY_DAYS);
  assert.equal(days.at(-1), "2026-09-14");
  assert.equal(days[0], "2026-06-17");
});

test("uptime counts slow as available, skips empty days, and never rounds up to 100", () => {
  assert.equal(uptime([null, null]), null);
  assert.equal(uptime([{ day: "d", up: 1438, degraded: 1, down: 1 }]), 99.93);
  assert.equal(uptime([{ day: "d", up: 99_999, degraded: 0, down: 1 }]), 99.99);
  assert.equal(uptime([{ day: "d", up: 10, degraded: 0, down: 0 }, null]), 100);
});

test("since carries over while the state holds and resets when it changes", () => {
  const reading: Reading = { bot: "up", dashboard: "up", api: "up", database: "up" };
  const first = buildSummary(NOW, reading, null, [], null);
  assert.equal(first.components[0].since, new Date(NOW).toISOString());

  const later = NOW + 60_000;
  const same = buildSummary(later, reading, first, [], null);
  assert.equal(same.components[0].since, first.components[0].since);

  const changed = buildSummary(later, { ...reading, bot: "down" }, first, [], null);
  assert.equal(changed.components[0].since, new Date(later).toISOString());
  assert.equal(changed.overall, "down");
});

test("daily rows land on the right component and day", () => {
  const reading: Reading = { bot: "up", dashboard: "up", api: "up", database: null };
  const summary = buildSummary(
    NOW,
    reading,
    null,
    [{ day: "2026-09-14", component: "api", up: 700, degraded: 0, down: 20 }],
    null,
  );
  const api = summary.components.find((c) => c.id === "api")!;
  assert.deepEqual(api.days.at(-1), { day: "2026-09-14", up: 700, degraded: 0, down: 20 });
  assert.equal(api.days.at(-2), null);
  assert.equal(summary.components.find((c) => c.id === "database")!.state, null);
  assert.equal(summary.shards, null);
});
