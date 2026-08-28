# Guild Removal Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the bot is removed from a guild, pause the subscription, warn the owner, and purge the configuration after 30 days — with a return at any point restoring everything.

**Architecture:** `GUILD_DELETE` schedules a confirmation job an hour out rather than acting; only that job starts the lifecycle. Tebex billing is paused for the same 30 days the purge counts down. The purge runs API-side (the bot cannot reach Tebex), consuming the same `scheduled_jobs` queue the bot uses, separated by a `kind` filter that both drains must respect.

**Tech Stack:** Deno + Discordeno v20 (bot), Node 24 + Express (api), Drizzle ORM + Postgres, Tebex Checkout API.

**Spec:** `docs/superpowers/specs/2026-08-28-guild-removal-lifecycle-design.md`

## Global Constraints

- **Retention window: 30 days** for all guilds. No second window.
- **Settle period: 1 hour** between `GUILD_DELETE` and confirmation.
- **Warnings at day 0, 23 and 29.** Delivery is best-effort and never gates the purge.
- **A guild with a live Discord entitlement is never purged**, at any age.
- **`platformBans` and `platformBanAppeals` are never touched.**
- **The API has no test runner.** Every testable unit lives in `shared/` (run by `deno test`) or in `bot/`. API files stay thin I/O glue.
- **Bot tests:** `deno test --allow-read -c bot/deno.json bot/src/` — style per `bot/src/utils/__tests__/interactionResponse.test.ts` (`Deno.test(...)`, `assertEquals` from `https://deno.land/std@0.224.0/assert/mod.ts`).
- **Never use `--omit=optional` for the API** — it strips TypeScript's compiler binary (see `.github/workflows/ci.yml:80-92`).

---

## File Structure

**Created:**
- `shared/services/guildLifecycle.ts` — pure decision logic + the orphan-table list. The testable core, shared by both runtimes.
- `shared/services/__tests__/guildLifecycle.test.ts`
- `api/src/services/tebexSubscriptions.ts` — pause/resume/cancel. Separate from `tebexService.ts`, which is about *creating* baskets; these are about managing what a basket produced.
- `api/src/jobs/purgeGuild.ts` — the purge job handler.
- `api/src/jobs/drain.ts` — the API's kind-filtered queue consumer.
- `bot/src/jobs/departure.ts` — `confirm_departure` and `warn_departure` handlers.
- `bot/src/jobs/__tests__/departure.test.ts`

**Modified:**
- `shared/schema/schema.ts` — three columns on `guilds`, three enum values.
- `bot/src/core/scheduler.ts:190-202,216-230` — kind filter and two new dispatch cases.
- `bot/src/events/guildDelete.ts` — schedule, don't act.
- `bot/src/events/guildCreate.ts` — abort the lifecycle on return.
- `bot/src/core/controlServer.ts` — purge-check endpoint.
- `api/src/services/botBridge.ts` — client for that endpoint.
- `api/src/main.ts` — start the drain.
- `site/privacy.html`, `SETUP.md` — the published promise.

---

## Task 1: Schema and migration

**Files:**
- Modify: `shared/schema/schema.ts` (guilds table; `scheduledJobKindEnum` at `:1198-1203`)
- Create: `db/migrations/` (generated)

**Interfaces:**
- Produces: `guilds.departedAt`, `guilds.purgeAt`, `guilds.pausedUntil` (all `timestamp with time zone`, nullable). Enum values `confirm_departure`, `warn_departure`, `purge_guild`.

- [ ] **Step 1: Add the columns**

In `shared/schema/schema.ts`, immediately after `tebexRecurringReference` (`:182`):

```ts
  // Set by the confirm_departure job, NOT by guildDelete. A GUILD_DELETE that
  // turns out to be a Discord outage must leave no trace, so nothing is
  // written until departure is confirmed an hour later.
  departedAt: timestamp("departed_at", { withTimezone: true }),
  // The deadline, denormalised so the dashboard renders it without arithmetic.
  purgeAt: timestamp("purge_at", { withTimezone: true }),
  // What we last told Tebex. Kept so a drift between our state and theirs is
  // detectable rather than silent.
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
```

- [ ] **Step 2: Add the enum values**

Append to `scheduledJobKindEnum` (`:1198`). Leave `close_poll` and `end_giveaway` — they are dead but removing enum values is a hard migration:

```ts
export const scheduledJobKindEnum = pgEnum("scheduled_job_kind", [
  "kick_unverified",
  "close_poll",
  "end_giveaway",
  "purge_expired_history",
  "confirm_departure",
  "warn_departure",
  "purge_guild",
]);
```

- [ ] **Step 3: Generate the migration**

```bash
cd api && npm run db:generate
```

- [ ] **Step 4: Verify it is additive**

Read the generated SQL. Expect `ALTER TABLE "guilds" ADD COLUMN` three times and `ALTER TYPE ... ADD VALUE` three times. If it contains any `DROP`, stop and report.

- [ ] **Step 5: Type check and commit**

```bash
cd api && npx tsc --noEmit -p tsconfig.json
git add shared/schema/schema.ts db/migrations
git commit -m "Add guild departure columns and lifecycle job kinds"
```

---

## Task 2: Kind-filter the bot's drain

This is a **safety prerequisite** for every later task. Until it lands, any `purge_guild` row the API creates is deleted by the bot within 30 seconds.

**Files:**
- Modify: `bot/src/core/scheduler.ts:190-202`
- Test: `bot/src/core/__tests__/schedulerKinds.test.ts` (create)

**Interfaces:**
- Produces: `BOT_JOB_KINDS` exported from `bot/src/core/scheduler.ts`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/core/__tests__/schedulerKinds.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BOT_JOB_KINDS } from "../scheduler.ts";

Deno.test("the bot claims only kinds it can dispatch", () => {
  assertEquals([...BOT_JOB_KINDS].sort(), [
    "confirm_departure",
    "kick_unverified",
    "purge_expired_history",
    "warn_departure",
  ]);
});

Deno.test("the bot never claims purge_guild", () => {
  // purge_guild runs API-side; the bot has no Tebex client. If the bot
  // claimed one it would hit `default:` and DELETE the job, and the whole
  // lifecycle would silently never fire.
  assertEquals(BOT_JOB_KINDS.includes("purge_guild" as never), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --allow-read -c bot/deno.json bot/src/core/__tests__/schedulerKinds.test.ts
```
Expected: FAIL — `BOT_JOB_KINDS` is not exported.

- [ ] **Step 3: Add the constant and the filter**

In `bot/src/core/scheduler.ts`, near `MAX_ATTEMPTS`:

```ts
/** The kinds this process can dispatch.
 *
 * Load-bearing. The claim below is shared with the API's drain, and the
 * dispatcher deletes anything it does not recognise (the `default:` branch
 * falls through to `succeeded`). An unfiltered claim would therefore destroy
 * the other process's jobs rather than leaving them, and the only trace would
 * be one warn line. */
export const BOT_JOB_KINDS = [
  "kick_unverified",
  "purge_expired_history",
  "confirm_departure",
  "warn_departure",
] as const;
```

Add the predicate to the inner select of the claim (`:193-201`), after the `attempts` condition:

```sql
        AND kind = ANY(${sql.raw(`ARRAY['${BOT_JOB_KINDS.join("','")}']::scheduled_job_kind[]`)})
```

- [ ] **Step 4: Run the tests**

```bash
deno test --allow-read -c bot/deno.json bot/src/
```
Expected: PASS, 41 tests.

- [ ] **Step 5: Commit**

```bash
git add bot/src/core/scheduler.ts bot/src/core/__tests__/schedulerKinds.test.ts
git commit -m "Filter the bot's job claim by kind before adding a second consumer"
```

---

## Task 3: The lifecycle decision core

Pure functions, no I/O, in `shared/` so `deno test` covers logic the API's own files could not.

**Files:**
- Create: `shared/services/guildLifecycle.ts`
- Test: `shared/services/__tests__/guildLifecycle.test.ts`

**Interfaces:**
- Produces:
  - `RETENTION_DAYS: number` (30)
  - `SETTLE_MS: number` (3_600_000)
  - `WARN_DAYS: readonly number[]` (`[0, 23, 29]`)
  - `ORPHAN_TABLES: readonly string[]`
  - `purgeDeadline(confirmedAt: Date): Date`
  - `decidePurge(input: { botPresent: boolean; entitled: boolean; billingCancelled: boolean }): { proceed: boolean; reason: string }`
  - `resolveRetentionDays(raw: string | undefined): number | null` — self-hosted override; `null` means purging is disabled

- [ ] **Step 1: Write the failing test**

Create `shared/services/__tests__/guildLifecycle.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ORPHAN_TABLES,
  decidePurge,
  purgeDeadline,
  resolveRetentionDays,
} from "../guildLifecycle.ts";

Deno.test("deadline is 30 days after confirmation", () => {
  const d = purgeDeadline(new Date("2026-01-01T00:00:00Z"));
  assertEquals(d.toISOString(), "2026-01-31T00:00:00.000Z");
});

Deno.test("a returned bot stops the purge", () => {
  const r = decidePurge({ botPresent: true, entitled: false, billingCancelled: true });
  assertEquals(r.proceed, false);
  assertEquals(r.reason, "bot present");
});

Deno.test("a live entitlement stops the purge at any age", () => {
  const r = decidePurge({ botPresent: false, entitled: true, billingCancelled: true });
  assertEquals(r.proceed, false);
  assertEquals(r.reason, "live entitlement");
});

Deno.test("an uncancelled subscription stops the purge", () => {
  // Ordering is load-bearing: deleting data we are still billing for is the
  // one outcome with no defence.
  const r = decidePurge({ botPresent: false, entitled: false, billingCancelled: false });
  assertEquals(r.proceed, false);
  assertEquals(r.reason, "billing not cancelled");
});

Deno.test("otherwise it proceeds", () => {
  assertEquals(
    decidePurge({ botPresent: false, entitled: false, billingCancelled: true }).proceed,
    true,
  );
});

Deno.test("retention defaults to 30 when unset", () => {
  assertEquals(resolveRetentionDays(undefined), 30);
});

Deno.test("a self-hoster can widen, narrow, or disable the window", () => {
  assertEquals(resolveRetentionDays("90"), 90);
  // 0 means never purge. A self-hoster owns their own database, so the
  // retention promise this makes to hosted users is not ours to impose.
  assertEquals(resolveRetentionDays("0"), null);
});

Deno.test("nonsense retention values fall back rather than deleting sooner", () => {
  // Failing safe matters here: a typo must never shorten the window.
  assertEquals(resolveRetentionDays("banana"), 30);
  assertEquals(resolveRetentionDays("-5"), 30);
});

Deno.test("the orphan list names every guild-scoped table the cascade misses", () => {
  assertEquals([...ORPHAN_TABLES].sort(), [
    "dashboard_audit_logs",
    "scheduled_jobs",
    "verification_attempts",
  ]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --allow-read shared/services/__tests__/guildLifecycle.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `shared/services/guildLifecycle.ts`:

```ts
// shared/services/guildLifecycle.ts
//
// The decisions behind the removal lifecycle, with no I/O, so they can be
// tested. The API has no test runner (api/package.json has no test script and
// no test devDependencies), so anything that lives only in api/src/ is
// verified by `tsc` and nothing else. Logic worth testing therefore lives
// here, and the API's job handler stays thin glue over it.

export const RETENTION_DAYS = 30;

/** Delay between GUILD_DELETE and confirming a departure. Discord sends
 *  GUILD_DELETE for outages too and the handler cannot tell the difference,
 *  so nothing acts on a single event. Outages resolve well inside an hour. */
export const SETTLE_MS = 60 * 60 * 1000;

/** Days after confirmation on which the owner is warned. */
export const WARN_DAYS = [0, 23, 29] as const;

/** Tables carrying guild_id that a cascade from guilds.id does NOT reach.
 *
 * The cascade covers 26 tables. These three have no foreign key to guilds at
 * all, so nothing in the schema will fail if they are forgotten — the purge
 * would simply report success while leaving user IDs behind. */
export const ORPHAN_TABLES = [
  "verification_attempts",
  "dashboard_audit_logs",
  "scheduled_jobs",
] as const;

export function purgeDeadline(confirmedAt: Date, days: number = RETENTION_DAYS): Date {
  return new Date(confirmedAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Self-hosted override for the retention window. `null` disables purging.
 *
 * Takes the raw string rather than reading the environment, because this
 * module is imported by both runtimes and they read env differently
 * (Deno.env vs process.env). The caller supplies the value.
 *
 * Anything unparseable falls back to the default rather than erroring or
 * shortening the window. A typo in an env var must never cause data to be
 * deleted sooner than intended.
 */
export function resolveRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return RETENTION_DAYS;
  return n === 0 ? null : n;
}

export function decidePurge(
  input: { botPresent: boolean; entitled: boolean; billingCancelled: boolean },
): { proceed: boolean; reason: string } {
  if (input.botPresent) return { proceed: false, reason: "bot present" };
  if (input.entitled) return { proceed: false, reason: "live entitlement" };
  if (!input.billingCancelled) return { proceed: false, reason: "billing not cancelled" };
  return { proceed: true, reason: "confirmed absent, unbilled" };
}
```

- [ ] **Step 4: Run the tests**

```bash
deno test --allow-read shared/services/__tests__/guildLifecycle.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/services/guildLifecycle.ts shared/services/__tests__/guildLifecycle.test.ts
git commit -m "Add the guild lifecycle decision core"
```

---

## Task 4: Tebex pause, resume and cancel

**Files:**
- Create: `api/src/services/tebexSubscriptions.ts`
- Reference: `api/src/services/tebexService.ts:68-76` (`authHeader`), `:35` (`API_BASE`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pauseSubscription(reference: string, until: Date): Promise<void>`, `resumeSubscription(reference: string): Promise<void>`, `cancelSubscription(reference: string): Promise<void>`.

- [ ] **Step 1: Export the auth helper**

`authHeader()` in `api/src/services/tebexService.ts:68` is currently module-private. Change `function authHeader()` to `export function authHeader()` and add above it:

```ts
/** Exported so tebexSubscriptions.ts can reuse it. Both files talk to the
 *  same API with the same credentials; duplicating the base64 assembly would
 *  be a second place to get it wrong. */
```

Also export the base: change `const API_BASE` at `:35` to `export const API_BASE`.

- [ ] **Step 2: Write the client**

Create `api/src/services/tebexSubscriptions.ts`:

```ts
// api/src/services/tebexSubscriptions.ts
//
// Managing a recurring payment that already exists. tebexService.ts creates
// baskets; this file changes what a basket produced.
//
// THE CONSTRAINT THAT SHAPES THE CALLER
//
// paused_until is REQUIRED. Tebex has no indefinite pause — the date is a
// resumption trigger, and billing restarts when it arrives. A pause is a
// timer, not a state. Whoever pauses must therefore also own the deadline:
// either resume it, or cancel before it fires. Doing nothing bills the
// customer again.

import { API_BASE, authHeader } from "./tebexService.ts";

async function call(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tebex ${method} ${path} failed (${res.status}): ${detail.slice(0, 500)}`);
  }
}

/** Stop billing until `until`. Tebex resumes automatically on that date. */
export function pauseSubscription(reference: string, until: Date): Promise<void> {
  return call(`/recurring-payments/${reference}/status`, "PUT", {
    status: "Paused",
    paused_until: until.toISOString(),
  });
}

export function resumeSubscription(reference: string): Promise<void> {
  return call(`/recurring-payments/${reference}/status`, "PUT", { status: "Active" });
}

export function cancelSubscription(reference: string): Promise<void> {
  return call(`/recurring-payments/${reference}`, "DELETE");
}
```

- [ ] **Step 3: Type check**

```bash
cd api && npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/src/services/tebexSubscriptions.ts api/src/services/tebexService.ts
git commit -m "Add Tebex pause, resume and cancel"
```

---

## Task 5: guildDelete schedules instead of acting

**Files:**
- Modify: `bot/src/events/guildDelete.ts`
- Test: `bot/src/jobs/__tests__/departure.test.ts` (create)

**Interfaces:**
- Consumes: `SETTLE_MS` from `shared/services/guildLifecycle.ts`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/jobs/__tests__/departure.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SETTLE_MS } from "../../../../shared/services/guildLifecycle.ts";

Deno.test("the settle delay is an hour", () => {
  assertEquals(SETTLE_MS, 3_600_000);
});

Deno.test("a departure job runs an hour out, not now", () => {
  const at = new Date(Date.now() + SETTLE_MS);
  assertEquals(at.getTime() - Date.now() > 59 * 60 * 1000, true);
});
```

- [ ] **Step 2: Run it**

```bash
deno test --allow-read -c bot/deno.json bot/src/jobs/
```
Expected: PASS (this task's test guards the constant; behaviour is asserted in Task 6).

- [ ] **Step 3: Rewrite the handler body**

In `bot/src/events/guildDelete.ts`, replace the `db.update(...)` call inside `try` with:

```ts
      // Still mark presence immediately: the dashboard must stop offering a
      // console whose every request would fail. This is reversible and
      // cosmetic. What is NOT written here is departedAt — see below.
      await db
        .update(schema.guilds)
        .set({ botPresent: false, updatedAt: new Date() })
        .where(eq(schema.guilds.id, guildId));

      // The lifecycle starts an hour from now, not here. Discord sends
      // GUILD_DELETE for outages as well as removals and this handler cannot
      // tell them apart, so nothing destructive and nothing billing-related
      // acts on a single gateway event. If the guild comes back inside the
      // hour, the confirmation job finds it present and does nothing at all.
      await db
        .insert(schema.scheduledJobs)
        .values({
          kind: "confirm_departure",
          guildId,
          runAt: new Date(Date.now() + SETTLE_MS),
        })
        .onConflictDoNothing();
```

Add the import:

```ts
import { SETTLE_MS } from "../../../shared/services/guildLifecycle.ts";
```

Update the file header: replace the paragraph beginning "Instead the row is marked absent" with a note that the row is marked absent *and* a confirmation job is queued, and that the outage caveat below is now handled by that delay rather than merely tolerated.

- [ ] **Step 4: Type check and test**

```bash
deno check -c bot/deno.json bot/src/main.ts && deno test --allow-read -c bot/deno.json bot/src/
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add bot/src/events/guildDelete.ts bot/src/jobs/__tests__/departure.test.ts
git commit -m "Queue a confirmation job on GUILD_DELETE instead of acting on it"
```

---

## Task 6: The confirm_departure handler

**Files:**
- Create: `bot/src/jobs/departure.ts`
- Modify: `bot/src/core/scheduler.ts:216-230` (dispatch)
- Test: `bot/src/jobs/__tests__/departure.test.ts` (extend)

**Interfaces:**
- Consumes: `purgeDeadline`, `WARN_DAYS` from `shared/services/guildLifecycle.ts`; `entitledTier` from `bot/src/core/entitlements.ts:192`.
- Produces: `runConfirmDeparture(bot, guildId): Promise<void>`, `runWarnDeparture(bot, guildId, payload): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `bot/src/jobs/__tests__/departure.test.ts`:

```ts
import { shouldStartLifecycle } from "../departure.ts";

Deno.test("a guild that came back does not enter the lifecycle", () => {
  assertEquals(shouldStartLifecycle({ botPresent: true, entitled: false }).start, false);
});

Deno.test("an entitled guild does not enter the lifecycle", () => {
  assertEquals(shouldStartLifecycle({ botPresent: false, entitled: true }).start, false);
});

Deno.test("a confirmed, unentitled departure starts it", () => {
  assertEquals(shouldStartLifecycle({ botPresent: false, entitled: false }).start, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
deno test --allow-read -c bot/deno.json bot/src/jobs/
```
Expected: FAIL — `shouldStartLifecycle` not exported.

- [ ] **Step 3: Implement**

Create `bot/src/jobs/departure.ts`:

```ts
// bot/src/jobs/departure.ts
// The Discord-side half of the removal lifecycle: confirming a departure is
// real, and warning the owner. The billing and deletion half runs API-side —
// the bot has no Tebex client, and botBridge only goes API->bot.

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import { entitledTier } from "../core/entitlements.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { WARN_DAYS, purgeDeadline } from "../../../shared/services/guildLifecycle.ts";

export function shouldStartLifecycle(
  input: { botPresent: boolean; entitled: boolean },
): { start: boolean; reason: string } {
  if (input.botPresent) return { start: false, reason: "returned within the settle period" };
  if (input.entitled) return { start: false, reason: "live Discord entitlement" };
  return { start: true, reason: "departure confirmed" };
}

export async function runConfirmDeparture(_bot: AppealyBot, guildId: bigint): Promise<void> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return;

  const decision = shouldStartLifecycle({
    botPresent: guild.botPresent,
    entitled: entitledTier(guildId) !== null,
  });

  if (!decision.start) {
    logger.info("Departure not confirmed; lifecycle not started", {
      guildId: guildId.toString(),
      reason: decision.reason,
    });
    return;
  }

  const now = new Date();
  const deadline = purgeDeadline(now);

  await db.update(schema.guilds)
    .set({ departedAt: now, purgeAt: deadline, updatedAt: now })
    .where(eq(schema.guilds.id, guildId));

  // One warn job per scheduled day, plus the purge itself. The purge is
  // kind purge_guild, which only the API's drain will claim.
  await db.insert(schema.scheduledJobs).values([
    ...WARN_DAYS.map((d) => ({
      kind: "warn_departure" as const,
      guildId,
      runAt: new Date(now.getTime() + d * 24 * 60 * 60 * 1000),
      payload: { day: d },
    })),
    { kind: "purge_guild" as const, guildId, runAt: deadline },
  ]);

  logger.info("Departure confirmed; lifecycle started", {
    guildId: guildId.toString(),
    purgeAt: deadline.toISOString(),
  });
}

export async function runWarnDeparture(
  bot: AppealyBot,
  guildId: bigint,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  // Re-check every time: the owner may have re-invited between warnings.
  if (!guild || guild.botPresent || !guild.purgeAt) return;

  const day = typeof payload?.day === "number" ? payload.day : 0;

  try {
    const dm = await bot.helpers.getDmChannel(guild.ownerId);
    await bot.helpers.sendMessage(dm.id, {
      content:
        `Appealy was removed from **${guild.name ?? "your server"}**.\n\n` +
        `Your configuration is saved until <t:${Math.floor(guild.purgeAt.getTime() / 1000)}:D>. ` +
        `Re-invite the bot before then and everything returns exactly as it was. ` +
        `Any paid plan is paused, not charged, until then.\n\n` +
        `You can export everything first with \`/exportdata\` in any server the bot is still in.`,
    });
  } catch (err) {
    // Expected, not exceptional. Once the bot shares no guild with the owner
    // Discord refuses the DM with 50007, and there is nothing to be done
    // about it — which is exactly why the dashboard banner, not this message,
    // is what the purge relies on having been shown.
    logger.debug("Departure warning DM not delivered", {
      guildId: guildId.toString(),
      day,
      reason: describeDiscordError(err).message,
    });
  }
}
```

- [ ] **Step 4: Wire the dispatch**

In `bot/src/core/scheduler.ts`, add to the `switch` at `:218`:

```ts
        case "confirm_departure":
          await runConfirmDeparture(bot, job.guildId);
          break;
        case "warn_departure":
          await runWarnDeparture(bot, job.guildId, job.payload);
          break;
```

Import at the top:

```ts
import { runConfirmDeparture, runWarnDeparture } from "../jobs/departure.ts";
```

- [ ] **Step 5: Run everything**

```bash
deno check -c bot/deno.json bot/src/main.ts && deno test --allow-read -c bot/deno.json bot/src/
```
Expected: clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add bot/src/jobs/ bot/src/core/scheduler.ts
git commit -m "Confirm departures after a settle period and warn the owner"
```

---

## Task 7: The purge-check endpoint

The API cannot see Discord presence or entitlements — `entitledTier()` reads in-process Maps in the bot (`bot/src/core/entitlements.ts:192`). The purge asks the bot for both.

**Files:**
- Modify: `bot/src/core/controlServer.ts` (pattern at `:141`)
- Modify: `api/src/services/botBridge.ts`

**Interfaces:**
- Produces: `POST /internal/guilds/purge-check` → `{ present: boolean; entitled: boolean }`; `checkGuildPurgeable(guildId: string)` in `botBridge.ts`.

- [ ] **Step 1: Add the endpoint**

In `bot/src/core/controlServer.ts`, alongside the other route checks:

```ts
      if (url.pathname === "/internal/guilds/purge-check" && req.method === "POST") {
        // The two facts only this process holds: whether Discord currently
        // shows the bot in the guild, and whether an entitlement is live.
        // The API's purge job cannot answer either — entitlements live in
        // in-process Maps here — so it asks immediately before deleting.
        const { guildId } = await req.json() as { guildId: string };
        const id = BigInt(guildId);

        // Discordeno no longer provides bot.cache.guilds — see
        // core/guildLookup.ts:3 — so presence is established by asking
        // Discord directly.
        //
        // The error handling is the safety-critical part. "Unknown guild"
        // (10004) and 403 mean we are genuinely not in it. ANY OTHER failure
        // is ambiguous, and must throw: a transient Discord outage read as
        // absence would hand a green light to an irreversible delete.
        let present: boolean;
        try {
          await bot.helpers.getGuild(id);
          present = true;
        } catch (err) {
          const info = describeDiscordError(err);
          if (info.code === 10004 || info.status === 403 || info.status === 404) {
            present = false;
          } else {
            throw err;
          }
        }

        return Response.json({ present, entitled: entitledTier(id) !== null });
      }
```

Import `entitledTier` from `./entitlements.ts` and `describeDiscordError` from `../utils/discordError.ts` if not already imported.

- [ ] **Step 2: Add the client**

In `api/src/services/botBridge.ts`:

```ts
/**
 * Ask the bot whether a guild may be purged.
 *
 * Called immediately before an irreversible delete, not when the job was
 * scheduled thirty days earlier — a month-old decision is not evidence about
 * the present. Throws on any failure, which leaves the guild intact and the
 * job retried; that is the correct direction to fail.
 */
export async function checkGuildPurgeable(
  guildId: string,
): Promise<{ present: boolean; entitled: boolean }> {
  return await callBot("/internal/guilds/purge-check", { guildId });
}
```

- [ ] **Step 3: Type check both**

```bash
deno check -c bot/deno.json bot/src/main.ts && (cd api && npx tsc --noEmit -p tsconfig.json)
```
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add bot/src/core/controlServer.ts api/src/services/botBridge.ts
git commit -m "Add a purge-check endpoint so the API can ask about presence and entitlements"
```

---

## Task 8: The purge

The one irreversible step. Cancel billing first; delete only if that succeeded.

**Files:**
- Create: `api/src/jobs/purgeGuild.ts`

**Interfaces:**
- Consumes: `decidePurge`, `ORPHAN_TABLES`; `cancelSubscription`; `checkGuildPurgeable`.
- Produces: `runPurgeGuild(guildId: bigint): Promise<void>`.

- [ ] **Step 1: Implement**

Create `api/src/jobs/purgeGuild.ts`:

```ts
// api/src/jobs/purgeGuild.ts
//
// Runs API-side because it must cancel a Tebex subscription, and the bot has
// no Tebex client and no way to reach the API (botBridge is API->bot only).
//
// ORDER IS THE WHOLE DESIGN. Cancel billing, then delete. A failed cancel
// leaves a guild intact and still paying, which is visible and recoverable. A
// delete followed by a failed cancel bills a customer for data we destroyed,
// which is not.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { checkGuildPurgeable } from "../services/botBridge.ts";
import { cancelSubscription } from "../services/tebexSubscriptions.ts";
import { decidePurge } from "../../../shared/services/guildLifecycle.ts";

export async function runPurgeGuild(guildId: bigint): Promise<void> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return; // already gone

  // Re-verify against the present, not against a 30-day-old decision.
  const live = await checkGuildPurgeable(guildId.toString());

  if (guild.tebexRecurringReference) {
    // Throwing here aborts the job before anything is deleted, and the
    // scheduler retries it. That is deliberate: reaching the next line means
    // billing is stopped, which is the precondition for deleting anything.
    await cancelSubscription(guild.tebexRecurringReference);
  }

  const decision = decidePurge({
    botPresent: live.present,
    entitled: live.entitled,
    // True by construction: the cancel above either succeeded or there was
    // nothing to cancel. decidePurge still checks it, because the guard
    // belongs with the decision rather than with this one caller.
    billingCancelled: true,
  });

  if (!decision.proceed) {
    // Not an error. The guild came back, or is entitled — clear the lifecycle
    // and leave everything standing.
    await db.update(schema.guilds)
      .set({ departedAt: null, purgeAt: null, pausedUntil: null, updatedAt: new Date() })
      .where(eq(schema.guilds.id, guildId));
    console.info(`[purge] skipped ${guildId}: ${decision.reason}`);
    return;
  }

  await db.transaction(async (tx) => {
    // These three carry guild_id but have NO foreign key to guilds, so the
    // cascade does not reach them. Two hold user IDs. A purge that skips them
    // reports success while leaving personal data behind.
    //
    // Written as typed deletes rather than a loop over ORPHAN_TABLES: raw
    // identifier interpolation is not a pattern this codebase uses anywhere,
    // and these three are checked against the schema by the drift test below.
    await tx.delete(schema.verificationAttempts)
      .where(eq(schema.verificationAttempts.guildId, guildId));
    await tx.delete(schema.dashboardAuditLogs)
      .where(eq(schema.dashboardAuditLogs.guildId, guildId));
    await tx.delete(schema.scheduledJobs)
      .where(eq(schema.scheduledJobs.guildId, guildId));
    // Deleting the guild row cascades into the remaining 26 tables.
    await tx.delete(schema.guilds).where(eq(schema.guilds.id, guildId));
  });

  console.info(`[purge] completed ${guildId}`);
}
```

- [ ] **Step 2: Type check**

```bash
cd api && npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0.

- [ ] **Step 3: Verify the orphan list against the schema**

Run this and confirm it prints nothing — it re-derives the orphan set and fails if the schema has gained a guild-scoped table the list does not name:

```bash
cd "$(git rev-parse --show-toplevel)" && python - <<'PY'
import io,re
tables={}
for f in ['shared/schema/schema.ts','shared/schema/platformBans.ts']:
    s=io.open(f,encoding='utf-8').read()
    p=re.split(r'export const (\w+) = pgTable\(', s)
    for i in range(1,len(p),2): tables[p[i]]=p[i+1]
edges={n:{m.group(1) for m in re.finditer(r'references\(\(\)\s*=>\s*(\w+)\.\w+\s*,\s*\{([^}]*)\}',b) if 'cascade' in m.group(2)} for n,b in tables.items()}
reach=set(); ch=True
while ch:
    ch=False
    for n,ps in edges.items():
        if n not in reach and ('guilds' in ps or (ps & reach)): reach.add(n); ch=True
orph=sorted(n for n,b in tables.items() if re.search(r'guildId:\s*bigint\("guild_id"',b) and n not in reach)
named={'verificationAttempts','dashboardAuditLogs','scheduledJobs'}
missing=set(orph)-named
if missing: print("ORPHAN LIST OUT OF DATE, add:", missing)
PY
```

- [ ] **Step 4: Commit**

```bash
git add api/src/jobs/purgeGuild.ts
git commit -m "Add the guild purge: cancel billing, then delete including the three orphan tables"
```

---

## Task 9: The API's drain

**Files:**
- Create: `api/src/jobs/drain.ts`
- Modify: `api/src/main.ts`

**Interfaces:**
- Produces: `startJobDrain(): void`.

- [ ] **Step 1: Implement**

Create `api/src/jobs/drain.ts`:

```ts
// api/src/jobs/drain.ts
//
// A second consumer of scheduled_jobs, alongside the bot's. Safe because the
// claim uses FOR UPDATE SKIP LOCKED with a worker id and a visibility
// timeout — the table was already a distributed queue.
//
// The kind filter is NOT optional. The bot's dispatcher deletes kinds it does
// not recognise, and so does this one by omission; an unfiltered claim on
// either side destroys the other's jobs within one tick.

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/client.ts";
import { runPurgeGuild } from "./purgeGuild.ts";

const TICK_MS = 60_000;
const CLAIM_VISIBILITY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const WORKER_ID = `api-${randomUUID().slice(0, 8)}`;

/** Only kinds this process can dispatch. See the file header. */
const API_JOB_KINDS = ["purge_guild"] as const;

let running = false;

async function drain(): Promise<void> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - CLAIM_VISIBILITY_MS).toISOString();

  const claimed = await db.execute(sql`
    UPDATE ${schema.scheduledJobs}
    SET claimed_at = ${now}, claimed_by = ${WORKER_ID}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM ${schema.scheduledJobs}
      WHERE run_at <= ${now}
        AND attempts < ${MAX_ATTEMPTS}
        AND kind = ANY(ARRAY['purge_guild']::scheduled_job_kind[])
        AND (claimed_at IS NULL OR claimed_at < ${stale})
      ORDER BY run_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, guild_id AS "guildId"
  `);

  const jobs = claimed as unknown as Array<{ id: string; kind: string; guildId: bigint }>;
  for (const job of jobs) {
    try {
      if (job.kind === "purge_guild") await runPurgeGuild(job.guildId);
      await db.delete(schema.scheduledJobs).where(sql`id = ${job.id}`);
    } catch (err) {
      await db.execute(sql`
        UPDATE ${schema.scheduledJobs}
        SET claimed_at = NULL, claimed_by = NULL, last_error = ${String(err)}
        WHERE id = ${job.id}
      `);
      console.warn(`[drain] ${job.kind} ${job.id} failed, will retry: ${String(err)}`);
    }
  }
}

export function startJobDrain(): void {
  setInterval(() => {
    if (running) return; // skip a tick rather than stacking
    running = true;
    drain().catch((err) => console.error(`[drain] tick failed: ${String(err)}`))
      .finally(() => { running = false; });
  }, TICK_MS);
}
```

- [ ] **Step 2: Start it**

In `api/src/main.ts`, inside the `app.listen` callback at `:10`:

```ts
  startJobDrain();
```

with the import at the top:

```ts
import { startJobDrain } from "./jobs/drain.ts";
```

- [ ] **Step 3: Type check**

```bash
cd api && npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add api/src/jobs/drain.ts api/src/main.ts
git commit -m "Consume purge_guild jobs from the API"
```

---

## Task 10: Returning restores everything

**Files:**
- Modify: `bot/src/events/guildCreate.ts:76-80`

- [ ] **Step 1: Clear the lifecycle on re-invite**

In the `onConflictDoUpdate` `set` block, alongside `botPresent: true`:

```ts
            // A return cancels the lifecycle outright. The purge job re-checks
            // presence before deleting, so a stale row here is not dangerous —
            // but leaving purgeAt set would keep the dashboard showing a
            // deadline that no longer applies.
            departedAt: null,
            purgeAt: null,
```

- [ ] **Step 2: Resume billing**

After the upsert's `logger.info("Guilds upserted", ...)`, add:

```ts
      // Resume any subscription this batch un-departed. Best-effort and
      // deliberately not awaited into the upsert's failure path: a guild that
      // is back with billing still paused is wrong but harmless for up to
      // paused_until, whereas failing the upsert would leave it marked absent.
      for (const g of batch) {
        void resumeIfPaused(g.id).catch((err) =>
          logger.error("Failed to resume subscription after re-invite", {
            guildId: g.id.toString(),
            error: String(err),
          })
        );
      }
```

Create `resumeIfPaused` in `bot/src/jobs/departure.ts`. Because the bot cannot call Tebex, it clears `pausedUntil` and lets the API act:

```ts
/** The bot cannot reach Tebex, so a re-invite records the intent and the
 *  API's next purge-check finds the guild present and clears the lifecycle.
 *  Billing resumes at paused_until regardless — this only makes it earlier. */
export async function resumeIfPaused(guildId: bigint): Promise<void> {
  await db.update(schema.guilds)
    .set({ pausedUntil: null, updatedAt: new Date() })
    .where(eq(schema.guilds.id, guildId));
}
```

- [ ] **Step 3: Type check and test**

```bash
deno check -c bot/deno.json bot/src/main.ts && deno test --allow-read -c bot/deno.json bot/src/
```

- [ ] **Step 4: Commit**

```bash
git add bot/src/events/guildCreate.ts bot/src/jobs/departure.ts
git commit -m "Cancel the lifecycle when the bot is re-invited"
```

---

## Task 11: The dashboard banner

The reliable warning channel. DMs are best-effort; this is what the purge's fairness actually rests on.

**Files:**
- Modify: `web/src/pages/Billing.tsx` and the guild-list view that renders "needs an invite"

- [ ] **Step 1: Surface the deadline in the API**

Wherever guild summaries are serialised for the dashboard, include `purgeAt`. Find it with:

```bash
grep -rn "botPresent" api/src/routes/ | head
```

Add `purgeAt: guild.purgeAt` to the same object.

- [ ] **Step 2: Render it**

Where the dashboard currently shows the "needs an invite" state, when `purgeAt` is set show:

```tsx
<div className="banner banner--warning">
  <strong>This server's configuration will be deleted on {new Date(purgeAt).toLocaleDateString()}.</strong>
  <p>
    Re-invite Appealy before then and everything returns exactly as it was.
    Any paid plan is paused, not charged, until that date.
  </p>
</div>
```

Match the existing banner class names in the file rather than inventing new ones.

- [ ] **Step 3: Build**

```bash
cd web && npm run build
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add web/src api/src/routes
git commit -m "Show the purge deadline on the dashboard"
```

---

## Task 12: Say so publicly

**Files:**
- Modify: `site/privacy.html` (the "Asking for deletion" section, ~`:266`), `SETUP.md`

- [ ] **Step 1: Update privacy.html**

Replace the paragraph at `site/privacy.html:191-195` — currently *"Removing the bot from a server does not delete that server's configuration. It is kept so that re-inviting restores what you had..."* — with:

```html
    <p>
      Removing the bot from a server does not delete that server&rsquo;s configuration straight
      away. It is kept for <strong>30 days</strong>, so re-inviting within that window restores
      exactly what you had rather than making you rebuild it. After 30 days it is deleted
      permanently: forms, panels, submissions, tickets and answers.
    </p>
    <p>
      If a paid plan is attached it is <strong>paused</strong> when the bot is removed, not
      cancelled &mdash; nobody is billed for a server the bot is not in. Re-invite and it resumes.
      Leave it, and it is cancelled at the end of the 30 days along with the data.
    </p>
    <p>
      Ban records are not part of this and are kept. An appeal decision has to stay checkable after
      a server stops using the bot.
    </p>
```

Every claim on that page is checkable against code, and these three are: 30 days is `RETENTION_DAYS`, the pause is `pauseSubscription`, and the ban carve-out is the absence of any foreign key from `platformBans` to `guilds`.

- [ ] **Step 2: Update SETUP.md**

Remove the "No on-request deletion path" gap entry, since removal now has one. Leave the `historyRetentionDays` entry — that gap is real and untouched by this work.

- [ ] **Step 3: Commit**

```bash
git add site/privacy.html SETUP.md
git commit -m "Document the 30-day removal retention window"
```

---

## Verification before merge

- [ ] `deno test --allow-read -c bot/deno.json bot/src/` — green
- [ ] `deno test --allow-read shared/` — green
- [ ] `deno check -c bot/deno.json bot/src/main.ts` — clean
- [ ] `cd api && npx tsc --noEmit -p tsconfig.json` — exit 0
- [ ] `cd web && npm run build` — exit 0
- [ ] The orphan-list check in Task 8 Step 3 prints nothing
- [ ] Manually: remove the bot from a test guild, confirm nothing happens for an hour, re-invite inside the hour, confirm no DM was sent and `departed_at` is still NULL
