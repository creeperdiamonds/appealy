# What happens when the bot is removed

**Date:** 2026-08-28
**Status:** design, awaiting review

---

## Why this document exists

Removing the bot from a guild currently does two things: sets `botPresent = false`
(`bot/src/events/guildDelete.ts:32-38`) and drops the name/roles cache. It deletes
nothing, ever. Adding the bot back flips the flag and everything returns exactly as
it was (`bot/src/events/guildCreate.ts:76-80`).

That was the right call and its header says why: a removal is often an accident, a
permissions cleanup, or five minutes long, and deleting that row cascades into 26
tables — "the single most destructive line in the codebase", in the existing
comment's words.

But "never delete" has a cost that has now come due in two places.

**Data is kept forever.** `SETUP.md` records that there is no on-request deletion
path, and `site/privacy.html` accepts deletion requests with no mechanism behind
them. A server that removed the bot in 2025 still has every submission, answer and
ticket it ever created.

**A paid plan keeps billing for a server the bot has left.** Tebex charges annually.
Remove the bot in month one and Tebex bills for eleven more months of a product that
is not running anywhere.

This design closes both, and the second one turns out to solve the first.

## Goal

A removal pauses the money, warns the owner, and — if nobody comes back — deletes the
configuration on a bounded, published schedule. A return at any point before the
deadline restores everything and resumes billing.

## Non-goals

- **Deleting the ban ledger.** A guild's configuration is disposable; the record of
  who was banned and what they appealed is not, and it is the one thing a purge must
  leave standing. `platformBans` lives in `shared/schema/platformBans.ts` and
  references `guilds` nowhere — its only foreign key is
  `platformBanAppeals.banId → platformBans.id`. That must not change.
- **Reworking the Tebex integration.** It grows three calls. It does not become a
  billing abstraction.
- **A grace period on the dashboard.** A departed guild's console stays as it is today
  — "needs an invite" — because every request it makes would fail.

---

## 1. The trigger, and the settle period

`GUILD_DELETE` is not trustworthy on its own, and this is the single most important
constraint in the design.

Discord sends it both when the bot is removed and when a guild goes temporarily
unavailable during an outage, distinguished by an `unavailable` flag on the raw
payload. Discordeno hands the handler the guild id and shard id only, so
`guildDelete.ts:15-21` documents that it cannot tell the two apart. Today that costs a
misleading banner for a few minutes and self-corrects.

Under this design, that same event would pause a subscription and start a deletion
countdown. **An outage would become a billing incident.**

**Nothing destructive hangs off one gateway event.** `GUILD_DELETE` schedules a
`confirm_departure` job for one hour out and changes nothing else. It deliberately
does not write `departedAt`, so an outage leaves no provisional state to clean up.
That job re-checks presence:

- **Bot present again** — an outage, or a fast re-invite. Drop the job. Nothing was
  written, nothing was sent, and the guild never entered the lifecycle at all.
- **Still absent** — a real removal. `departedAt` and `purgeAt` are written *now*, at
  confirmation, and the lifecycle starts. The extra hour is immaterial against thirty
  days, and it buys the guarantee that the clock only ever starts on a confirmed fact.

Outages resolve in minutes and become a no-op. Real removals are still real an hour
later. Reading the raw `unavailable` flag is worth doing as a second belt, but the
settle period is what makes the design safe, because it does not depend on getting
the flag plumbing right.

**The purge re-verifies again immediately before deleting.** Absence must hold at the
moment of deletion, not merely when the job was scheduled thirty days earlier. A
30-day-old decision is not evidence about the present.

## 2. Where the work runs

This is the architectural problem the design has to solve, and it is not obvious from
the feature description.

The scheduler lives in the bot (`bot/src/core/scheduler.ts`). The Tebex client lives
in the API (`api/src/services/tebexService.ts`). **The bridge between them is
one-directional:** `api/src/services/botBridge.ts` gives the API a `callBot`, and the
bot never calls the API — there is no `API_ORIGIN` anywhere in `bot/src`.

So a scheduler job in the bot cannot pause a subscription, and the work genuinely
spans both runtimes: confirming presence and sending DMs are Discord-side, while
Tebex calls are API-side.

**Both processes consume the same queue.** `scheduled_jobs` is already a correct
distributed queue — the claim at `scheduler.ts:190-202` uses `FOR UPDATE SKIP LOCKED`
with a worker id and a five-minute visibility timeout, which is precisely the
mechanism that makes multiple consumers safe. The API gets a small drain loop over the
same table.

**This requires filtering claims by `kind`, and that is not optional.** The existing
claim takes *any* due job, `LIMIT 100`, with no `kind` predicate — and the dispatcher
is worse than a plain failure would be. `scheduler.ts:216-230` runs its `switch`
inside the `try`, with `succeeded.push(job.id)` *after* it, so the `default:` branch
logs "Unknown scheduled job kind, discarding" and then falls straight through to the
success path. Unknown kinds are **deleted on first claim**, not retried.

So an unfiltered bot drain would silently destroy every `purge_guild` job the API
scheduled, on the next 30-second tick, and the lifecycle would simply never fire —
with a warn-level log line as the only trace. Both drains must filter to their own
kinds, and the bot's filter must land in the same change that introduces the API's
consumer, not after it.

| Job | Runs in | Does |
|---|---|---|
| `confirm_departure` | bot | Re-check presence; start or abort the lifecycle |
| `warn_departure` | bot | Dashboard flag, best-effort owner DM |
| `purge_guild` | api | Cancel the subscription, then delete |

## 3. The subscription

Verified against Tebex's Checkout API documentation rather than assumed:

- `PUT /recurring-payments/{reference}/status` — `{"status":"Paused","paused_until":"<ISO8601>"}`, resume with `{"status":"Active"}`
- `DELETE /recurring-payments/{reference}` — cancel
- Basic auth, the same `authHeader()` already used for `POST /checkout`

The handle is already stored: `shared/schema/schema.ts:182` `tebexRecurringReference`,
persisted because lifecycle webhooks identify themselves by reference and cannot
otherwise be matched to a guild.

**`paused_until` is required. There is no indefinite pause.** Tebex treats the date as
a resumption trigger and starts billing again when it arrives. A pause is a timer, not
a state — which means doing nothing at the deadline is the one outcome that must never
happen: billing would resume on day 31 against a guild whose configuration we deleted
on day 30.

On confirmed departure, if `tebexRecurringReference` is set, pause until
`departedAt + 30 days`. Then:

- **Re-invited** — `status: Active`, cancel the purge. They lost nothing and paid for nothing.
- **Plan moved to another guild** — the binding is ours; rebind and resume against the new guild.
- **Day 30, still absent** — `DELETE` the recurring payment, *then* purge.

**Ordering is load-bearing.** Cancel billing first and purge only if the cancel
succeeded. `MAX_ATTEMPTS = 3` means a job that keeps throwing is eventually abandoned,
and this is the safe direction: a failed cancel leaves the guild intact and still
paying, which is recoverable. Purging first and then failing to cancel bills a
customer for data we destroyed, which is not.

## 4. Discord entitlements

Discord owns that billing outright. We cannot pause it, cannot move it, cannot cancel
it. The money keeps flowing regardless of what we do.

**A guild with a live Discord entitlement is never purged.** It is notified and warned,
and the clock starts only once the entitlement actually ends. Deleting configuration
that a customer is actively and unstoppably being charged for is the one outcome with
no defence.

`DISCORD_SKU_TIERS` is currently unset, so this branch is dormant. It is specified now
because the cost of writing it down today is a paragraph, and the cost of discovering
it after switching SKUs on is a customer incident.

## 5. Warnings

**The dashboard banner is the reliable channel** and carries the weight. It states the
deadline and what re-inviting does.

**Owner DMs are best-effort.** Once the bot shares no guild with the owner, opening a
DM channel fails; `getDmChannel` will return 50007 ("Cannot send messages to this
user"), which `bot/src/services/ticketRatingService.ts:52-55` already detects and can
be copied from. Sent at departure, day 23 and day 29.

**The purge does not require that any warning was delivered.** It cannot: an owner
with closed DMs would otherwise be undeletable, which is the opposite of the retention
guarantee this design exists to make.

**Every warning offers an export**, reusing `buildFullDataExport` from
`shared/services/dataExport.ts`. `privacy.html` already advises exporting before asking
for deletion; this is what makes that advice actionable rather than decorative.

## 6. Self-hosted deployments

The purge runs in self mode too, but the window is configurable via environment and
can be switched off entirely.

In platform mode the retention limit is a promise we make to people whose data we
hold. A self-hoster holds their own data in their own database, so the same reasoning
does not apply and the decision is theirs.

## 7. Schema

Three columns on `guilds`:

- `departedAt` — when the departure was *confirmed*, not when `GUILD_DELETE` arrived
- `purgeAt` — the deadline, denormalised so the dashboard can render it without arithmetic
- `pausedUntil` — what we told Tebex, so a drifted state is detectable

Three new `scheduledJobKindEnum` values — `confirm_departure`, `warn_departure`,
`purge_guild` — which is an enum migration, not a table change. Note that
`close_poll` and `end_giveaway` already exist in that enum and are dead: nothing
schedules them and the dispatcher has no case for them. Leave them alone; removing
enum values is a harder migration than it looks and they are harmless.

## 8. What the purge actually deletes

The cascade from `guilds.id` reaches **26 tables** — 15 by direct foreign key and 11
more through them, since `submissions` hangs off `forms`, `answers` off
`submissions`, `tickets` off `ticketConfigs`, and so on. All of those are handled by
Postgres and need no code.

**Three tables carry `guild_id` but are not reachable by the cascade, and must be
deleted explicitly:**

| Table | Why it matters |
|---|---|
| `verificationAttempts` | Holds user IDs. Surviving a purge defeats its purpose. |
| `dashboardAuditLogs` | Holds user IDs and actions. Same. |
| `scheduledJobs` | Pending jobs for a guild that no longer exists; they would fire and fail forever. |

None has a foreign key to `guilds`, so nothing in the schema will catch this being
forgotten. A purge that skips them is not a purge — it leaves personal data behind
while reporting success, which is the worst of both outcomes.

`platformBans` and `platformBanAppeals` are deliberately outside all of this.

## Error handling

- **Tebex unreachable at pause time** — retry via the existing attempts mechanism. A failed pause leaves billing running, which is wrong but recoverable and visible. Log loudly.
- **Tebex unreachable at cancel time** — do not purge. Retry. After `MAX_ATTEMPTS` the guild survives with billing intact; that is the correct failure direction.
- **DM fails** — expected, not an error. Log at debug and continue.
- **Guild re-appears mid-lifecycle** — any job that finds the bot present aborts, clears `departedAt`/`purgeAt`, and resumes billing if paused.
- **Purge job claimed twice** — the second run finds the row gone. Deletion is idempotent by construction.
- **A purge exceeding the 5-minute visibility window** could be re-claimed while running. Fifteen cascading deletes on one guild should be far inside that, but the purge should be a single transaction so a re-claim cannot interleave.

## Testing

- **The settle period is the highest-value test.** Simulate `GUILD_DELETE` followed by `GUILD_CREATE` within the hour and assert that no notification was sent, no subscription was paused, and no purge was scheduled.
- **The `kind` filter**, asserted from both sides: the API drain must not claim `close_poll`, and the bot drain must not claim `purge_guild`. This is the regression that would silently break polls.
- **Ordering**, by making the Tebex cancel fail and asserting the guild still exists afterwards.
- **The entitlement branch**, asserting a guild with a live entitlement is never scheduled for purge.
- **Orphan coverage is the test that matters most.** Seed a guild with rows in `verificationAttempts`, `dashboardAuditLogs` and `scheduledJobs`, purge it, and assert all three are empty. The cascade is Postgres's job and will not regress; these three have no foreign key to catch a mistake, so only a test stands between a purge and silently leaving user IDs behind.
- **Cascade coverage**, asserting the purge empties the 26 reachable tables — including `submissions`, `answers` and `tickets`, which are reached through `forms` and `ticketConfigs` rather than directly.
- **Ban survival**, asserting `platformBans` and `platformBanAppeals` still exist after a purge. They reference `guilds` nowhere, so this holds by construction — the test exists to keep it that way.

## Risks

- **This adds the destructive line the codebase deliberately did not have.** Every safety here — settle period, re-verification, cancel-before-purge, fail-closed retries — exists because the blast radius is 26 tables and there is no undo.
- **The second queue consumer can break existing jobs.** Covered by the `kind` filter, but it is the change most likely to be got wrong, and its failure is silent: polls simply stop closing.
- **Thirty days is the shorter end of defensible.** It is a familiar, publishable number, but a permissions cleanup plus a holiday can exceed it. The warnings and the export offer are what make it fair.
- **`site/privacy.html` and `SETUP.md` must be updated in the same change.** Both currently describe the old behaviour, and this design makes them wrong in the direction that matters — a privacy page understating what is deleted is worse than one that says nothing.

## Open questions

- **Subscription portability deserves its own plan.** Moving a plan between guilds is a
  dashboard surface, an ownership check, and a rebinding flow. It is referenced here
  because it is what makes the pause worth having, but it should not be smuggled into
  this plan's scope.
- **Whether the free-tier window should be configurable in platform mode too.** Fixed
  at 30 days here for a publishable, uniform promise.
