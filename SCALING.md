# Scaling audit

Written against the codebase as uploaded. Every finding cites a real file
and line of reasoning; nothing here is generic advice.

The headline: **the bot's Postgres pool is `max: 10`, and three code paths
were issuing a query per Discord event against it.** Everything else in
this document is downstream of that.

---

## What breaks first, and how it looks when it does

The failure is not the one you'd expect. You don't get a slow dashboard or
a database alarm. You get **a bot that appears to randomly disconnect**.

Here's the chain. `messageCreate` did a `SELECT` on `sticky_messages` for
every message in every channel of every guild, plus an `UPDATE` on most of
them. Those queries queue behind a 10-connection pool. Deno's event loop
processes gateway events in order, so a queued query delays every event
behind it — including the gateway heartbeat. Discord drops a shard that
misses heartbeats. The bot reconnects, replays, and falls behind again.

Every symptom points at the gateway. The cause is the database.

---

## Findings

### 1. Per-message database queries — `bot/src/events/messageCreate.ts`

**Before:** every guild message → one `SELECT`, usually one `UPDATE`.

At 100 messages/sec across your fleet that's 200 queries/sec against 10
connections, for data that changes when an admin edits a sticky message.

There was also a correctness bug hiding inside it. `messagesSinceRepost`
was a read-modify-write with no lock, so two concurrent messages both read
`N` and both wrote `N+1`. The counter drifted low and stickies reposted
less often than configured — a bug that gets worse the busier the channel,
which is exactly backwards.

**After:** `stickyChannelHint()` answers "does this channel have a sticky?"
from an in-process `Map` with no I/O. That's `false` for ~99% of messages,
and those now cost a hash lookup. The counter moved to Redis `INCR`, which
is atomic, so the drift is gone too. Postgres is written once per repost
instead of once per message.

New: `bot/src/core/guildConfigCache.ts`, `bot/src/core/redis.ts`.

### 2. Four sequential queries per join — `bot/src/events/guildMemberAdd.ts`

**Before:** `antiRaidConfigs`, `raidLockdowns`, `verificationConfigs`,
`welcomerConfigs` — four separate awaited round-trips, serialized, per join.

The load profile is what makes this bad. Join rate is normally low and
spikes during a raid, so peak database load coincides exactly with the
event the anti-raid system exists to handle.

**After:** one cached bundle. Role grants run through `Promise.allSettled`
instead of a sequential `for` loop, so five auto-roles are five concurrent
REST calls rather than five serialized ones.

### 3. `setTimeout` for delayed kicks — same file

Three problems, one of them a straightforward bug:

- **Unbounded memory.** A 10,000-member raid created 10,000 live timers.
- **Lost on restart.** A deploy silently cancelled every pending kick.
- **Wrong query.** The lookup was
  `findFirst({ where: eq(verificationAttempts.userId, member.user.id) })`
  — **no `guildId` filter**. A user who verified in *any* guild counted as
  verified in *this* one and was never kicked. And since the table is
  indexed on `(guildId, userId)`, a `userId`-only filter can't use that
  index either. Wrong *and* slow.

**After:** a durable `scheduled_jobs` row, drained by the scheduler with a
properly guild-scoped check. Visible and cancellable on the Operations page.

### 4. Discord API call on every authenticated request — `api/src/middleware/guildAccess.ts`

This was the API's hard ceiling. `fetchUserGuilds()` — a live HTTPS request
to `discord.com/api/v10/users/@me/guilds` — ran on **every** request to
**every** `/api/guilds/:guildId/*` endpoint.

- 100–300ms added to every request, paid once per resource on a page load.
- `/users/@me/guilds` is rate-limited per user token. A dashboard firing
  parallel requests will 429 against Discord.
- **The 429 was swallowed by a bare `catch {}`**, which fell through to the
  delegation check. A rate-limited admin was silently demoted to "no
  access" and got a 403 on a server they own — an intermittent permissions
  bug with a caching gap as its root cause.

**After:** cached per session for 60s. And critically, a Discord failure now
returns **503, not 403** — "we couldn't check" and "you don't have access"
are different answers and must not produce the same response.

The cache key is the **session id**, deliberately. Keying on user id would
let a lower-privileged session read an entry populated by a higher-privileged
one. Keying on guild id would share one user's permissions with every other
user of that guild. Both are privilege-escalation shapes.

### 5. In-memory OAuth state — `api/src/routes/auth.ts`

The original comment said "for multi-instance API deployments, back this
with Redis instead." The consequences are worse than that suggests:

- **Login breaks behind a load balancer.** The README calls the API
  "stateless, horizontally scalable"; `--scale api=3` disproves it. State
  is written to replica A; Discord redirects to whichever replica the
  balancer picks. Login fails ~(N-1)/N of the time, *randomly*.
- **It leaks.** Entries are deleted only on successful callback. Every
  abandoned login leaves a permanent entry. Nothing sweeps expired ones.
- **A restart invalidates in-flight logins.**

**After:** Redis with a native TTL, consumed atomically via `GETDEL` so a
replayed callback finds nothing. If Redis is down, **login is refused** —
the state nonce is CSRF protection, and skipping it during an outage means
an availability blip silently disables a security control.

### 6. Scheduler races itself — `bot/src/core/scheduler.ts`

The README notes it "assumes a single bot instance." It doesn't hold up for
one instance either:

`setInterval(async () => ...)` does not wait for the previous callback. Once
a tick exceeds 30s — which it will, since polls and giveaways were processed
sequentially — a second tick starts on top of it. Neither "select due" nor
"mark published" was atomic, so both publish the same poll. **The problem
compounds:** more work per tick → more overlap → more duplicates.

It also affects single-replica deploys, since rolling deploys run old and
new concurrently for a few seconds.

**After:** Redis locks per task, an `isRunning` guard, atomic
`UPDATE ... RETURNING` claims, `SKIP LOCKED` for the job queue, bounded
concurrency on Discord calls, and each task isolated so one failure doesn't
cancel the others.

If Redis is unavailable the tick is **skipped rather than run unlocked**.
A poll 30 seconds late is recoverable; two sets of giveaway winners is not.

### 7. Three caps were billed for and never enforced

This one is worth reading carefully.

`shared/schema/pricing.ts` prices eight caps. Grepping for each identifier:

| Cap | Enforced? |
|---|---|
| `submissionsPerDay` | yes |
| `ticketsPerDay` | yes |
| `giveawayEntriesPerDay` | yes |
| `formsPerGuild` | yes |
| `panelsPerGuild` | yes |
| **`apiRequestsPerMinute`** | **no — pricing.ts and billing.ts only** |
| **`historyRetentionDays`** | **no — pricing.ts and billing.ts only** |
| **`rolesPerRuleType`** | **no — pricing.ts and billing.ts only** |

A guild admin can move those three sliders, watch the price rise, and pay
for numbers that nothing in the codebase reads. `historyRetentionDays` is
the most consequential: without enforcement, `submissions` and `answers`
grow without bound and become the largest tables in the database, while the
paid retention tiers mean nothing.

**After:** `apiRequestsPerMinute` is enforced by new middleware
(`api/src/middleware/apiRateLimit.ts`). The other two are still unenforced,
and both are still billed for:

- `historyRetentionDays` has a purge implemented (`runHistoryPurge`,
  `bot/src/core/scheduler.ts:276`) and dispatched, but nothing ever schedules
  a `purge_expired_history` job — the only insert into `scheduled_jobs` is
  `kick_unverified` at `guildMemberAdd.ts:142`. Writing the function was not
  the same as running it.
- `rolesPerRuleType` still needs validation in `api/src/routes/forms.ts` —
  see "Not done" below.

### 8. Uncached picker endpoints — `bot/src/core/controlServer.ts`

`/internal/guilds/:id/channels` and `/roles` hit Discord REST on every
request, and back every dropdown in the form and panel builders. These
share the bot's **global** REST budget with live user actions — an admin
idly reopening the form builder competes with a member's application being
accepted. Now cached 60s.

### 9. Two Redis connections opened at import time

`rateLimitService.ts` and `antiRaidService.ts` each did a module-level
`await connect(...)`. Top-level `await` makes every importer an async
module, so a Redis outage at boot surfaced as an unhandled rejection with
no stack pointing at the cause. Consolidated into one lazily-connected
singleton with a `pipeline()` helper.

### 10. Broken avatar URL — `guildMemberAdd.ts`

`https://cdn.discordapp.com/avatars/${id}/icon.png` is not a real CDN path
and 404s for every user. Fixed to the default-avatar endpoint.

---

## Fail-open vs fail-closed

Each cache-miss path chooses deliberately, and the choices differ:

| Path | On Redis failure | Why |
|---|---|---|
| Bot billing caps | **closed** | Failing open means caps you charge for stop existing |
| API request limit | **open** | Protects our capacity, already degraded; don't lock customers out too |
| OAuth state | **closed** | Never weaken CSRF protection for availability |
| Scheduler locks | **skip** | Delay is recoverable; duplicate winners aren't |
| Config cache | **open** | Postgres is the system of record; serve slightly stale |
| Sticky counter | **skip** | A missed repost is cosmetic |

The point is that a shared "fail open" default would have made three of
these wrong, and the wrongness would have been invisible until an outage.

---

## Rough expected effect

| Path | Before (per event) | After |
|---|---|---|
| Guild message, no sticky | 1 SELECT + 1 UPDATE | 0 I/O |
| Member join | 4 SELECT (serial) | 0 (cached) |
| Form submit | 1 SELECT + 2 Redis | 0 SELECT + 1 Redis |
| Dashboard request | 1 Discord HTTPS + 1 SELECT | 1 Redis (cached 60s) |
| Overview page load | ~9 requests × permission check | 1 request |

Order-of-magnitude, not benchmarked. Measure on your own traffic.

---

## Not done — what's still ahead of you

Being explicit rather than leaving you to find these.

**Sharding.** `bot/src/core/client.ts` uses `bot.start()`, single process.
Discord requires sharding past ~2,500 guilds. The file's own comment points
at `createShardManager`. Nothing here changes that, but the config cache and
scheduler locks are now multi-replica-safe, which was the blocker.

**Migration not generated.** `scheduled_jobs` is defined in
`shared/schema/schema.ts` but you need to run:

```bash
cd api && npm run db:generate && npm run db:migrate
```

**`rolesPerRuleType` still unenforced.** Needs a check in the zod schema in
`api/src/routes/forms.ts` against the resolved cap. Small, but it's a cap
you charge for.

**`purge_expired_history` is never scheduled.** The handler exists in the
scheduler; nothing enqueues it. Add a daily job per guild, or a periodic
sweep.

**Audit log writes.** `dashboardAuditLogs` is queried by the console and
written by nothing. The routes need to log their mutations — the table and
the UI are both ready.

**ReDoS timeout.** `shared/schema/regexValidation.ts` documents this
honestly already: the static rejection list is the *only* defense, with no
runtime timeout. A worker thread would fix it. Unchanged here — the file's
own assessment is accurate and I'd rather not paper over it.

**The pipeline helper is version-defensive.** `pipeline()` in
`bot/src/core/redis.ts` probes for `tx()`/`pipeline()` and falls back to
sequential execution. Verify it against your installed Deno Redis version —
if it silently falls back, you keep correctness but lose the round-trip
saving, which is most of the anti-raid gain.

**Untested against a live bot token.** Same caveat the README already gives
for `importAppy.ts`. The shard-status reader in `controlServer.ts` is
written defensively for exactly this reason, but verify before relying on it.
