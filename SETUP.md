# Setup checklist

Everything previously listed as missing is now written. What's left is
environment work only — three of these can't be done in code.

## 1. Migration (generated)

`db/migrations/0000_huge_machine_man.sql` — the first migration this repo has
ever had. `db/migrations` was empty, so this is the full initial schema, not an
increment.

```bash
cd api && npm install && npm run db:migrate
```

Both partial unique indexes generated correctly with their `WHERE` clauses —
verified, since drizzle's `.where()` on indexes has been inconsistent across
versions:

```sql
CREATE UNIQUE INDEX "platform_bans_active_uniq" ON "platform_bans" ("subject","subject_id") WHERE revoked_at is null;
CREATE UNIQUE INDEX "platform_ban_appeals_one_open" ON "platform_ban_appeals" ("ban_id") WHERE status = 'open';
```

These aren't cosmetic. The first stops two operators creating conflicting
active bans; the second is what caps the appeal queue when Redis is down.

**If your database already has tables**, this migration will collide — it's
written as a fresh create. Either baseline it (`drizzle-kit migrate` after
marking it applied) or diff it against your live schema first.

`drizzle.config.ts` now lists both schema files; `platformBans.ts` wouldn't be
picked up otherwise.

## 2. Rate limits in self mode (done)

Both `rateLimitService.ts` files now check `deployment.features.tieredRateLimits`
before reading the tier, and return flat `CAP_*` values when it's off. In self
mode `guild.rateLimitTier` is `"free"` on every row and means nothing —
honouring it would cap a self-hoster with someone else's price list.

Unmapped keys fall back to **tier2**, not free: a self-hoster shouldn't be more
restricted than a paying customer on their own hardware.

The bot and API versions must stay identical. The header of the bot's copy
warns that a cap differing by process is exactly the failure mode to avoid.

## 3. UI (done)

- `web/src/pages/AppealConfig.tsx` — guild ban-appeal settings, under
  **Ban appeals** in the server nav.
- `web/src/pages/OpsAppeals.tsx` — platform appeal review, under **Operator**,
  shown only when `/api/ops/appeals` doesn't 404.

`AppealConfig` warns about the two states the API accepts but that do nothing:
enabled with no form selected, and a form set with the ban-time DM off (no
entry point at all). Neither produces a server error, so an admin would
otherwise discover it months later when nobody has appealed.

`OpsAppeals` is the only place `notes` and `evidence` ever render, and it
refuses to record a decision without a written note — the appellant reads it.

## 4. Things only you can do

- [ ] **Enable `GuildModeration` in the Discord Developer Portal.** Code-side
      is done; the gateway won't send `guildBanAdd` until the portal agrees.
- [ ] **Set `OPS_USER_IDS`** to your own Discord user ID, or the operator
      surface stays off for everyone (it fails closed, deliberately).
- [ ] **Run `deno task sync-commands`** once. Command registration no longer
      happens on boot — see `STARTUP.md`.
- [ ] **Set `DEPLOYMENT_MODE=platform`** on the hosted deployment. It defaults
      to `self`.

## Raising caps for your own server

```
PRIVILEGED_GUILD_IDS=847123456789012345,226300000000000000
```

Those guilds skip tier resolution entirely and get `CUSTOM_CAP_MAXIMUMS`.
Override individual caps with `PRIVILEGED_CAP_*` (all listed in
`.env.example`) when the ceiling isn't enough.

Precedence, highest first: **privileged → self mode flat caps → custom tier →
preset tier.**

Two deliberate choices worth knowing:

**Not clamped to `CUSTOM_CAP_MAXIMUMS`.** `pricing.ts` calls that ceiling the
"deliberate no-unlimited backstop", and it stays exactly that for customers —
it stops someone self-serving unbounded throughput through the pricing slider,
where only a price stands between them and your database. You editing your own
`.env` is a different trust context; there's no purchase to bound and you're
the one who gets paged.

**Still finite.** `Infinity` is rejected at startup. Your server shares the
same `max: 10` Postgres pool as every other guild, so an uncapped runaway loop
in yours takes everyone down with it. Defaulting to the ceiling means "as high
as this was designed to go" rather than an invented number.

A malformed guild ID throws at startup rather than silently never matching —
otherwise you'd raise your own caps, see nothing change, and have no idea why.

## Sharding

Automatic. The count is `ceil(guilds / GUILDS_PER_SHARD)`, floored at Discord's
own recommendation, capped at `MAX_SHARDS`, and decided at each startup.

**Why it can't change while running.** Discord assigns guilds with
`(guild_id >> 22) % total_shards`. The total is in the denominator, so going
from 2 shards to 3 remaps *every* guild — there's no appending. Growing means
tearing down all connections and re-identifying, so the count is fixed for the
life of the process and a watcher tells you when to restart.

**The guard that matters.** Every shard connecting spends a Discord "session
start", and you get a limited number per day (1000 by default) with no override
when they run out. A 4-shard bot crash-looping every 30 seconds burns the whole
day's budget in about two hours and then cannot start at all until the window
resets — a far worse outage than whatever caused the loop.

So the bot refuses to start when the remaining budget is below a reserve, and
says so, instead of spending the last of it. If you see that message, something
has been restarting in a loop; read the logs before trying again.

## Billing via Discord subscriptions

```
DISCORD_SKU_TIERS=1234567890123456789:tier1,2345678901234567890:tier2
```

Create the SKUs in the Developer Portal under Monetization, map them here, and
guilds with a live entitlement get that tier automatically. No Tebex account.

**Why this alongside Tebex.** Both are merchant of record — no payment
processor to onboard, no PCI surface, no VAT handling, no payouts of your own.
Discord's advantage is that purchase happens inside Discord rather than via a
redirect, and its Monetization Requirements policy expects paid apps to offer
Premium Apps pricing no higher than elsewhere, so a web-checkout-only setup was
never really on the table. Its limit is that SKUs are a fixed catalogue, which
the custom-caps tier cannot be expressed as — that case goes through Tebex.

The costs are real: a platform fee of 15% below $1M cumulative sales and 30%
after, and eligibility limited to US/UK/EU-based developers.

**The mechanic that catches people out.** Renewals emit *no event at all*.
`ENTITLEMENT_UPDATE` fires only when a subscription *ends*, carrying `ends_at`.
So six months of silence is a healthy subscription, not a dropped webhook —
code that treats silence as expiry cancels every paying customer. Active is
the default state here; an entitlement is live until a past `ends_at` says
otherwise.

**Three sources, so a missed event self-heals.** Gateway events are instant but
missable across a reconnect. Every interaction payload carries the caller's
entitlements — free, and it repairs the cache on the next command. An hourly
reconcile against `GET /applications/{id}/entitlements` rebuilds from scratch,
which is the only way to notice a subscription that ended while disconnected,
since that produces no event to process.

**Precedence:** privileged guilds → Discord entitlement → self-mode caps →
stored tier. The entitlement outranks the database column because the column is
our bookkeeping and the entitlement is what Discord says the customer is
currently paying for.

If entitlements haven't loaded yet, the resolver returns null and the guild
falls back to its stored tier. A paying customer briefly on the wrong tier is
recoverable; one downgraded to free by a slow fetch generates a support ticket.

**Self-hosters need do nothing.** Entitlements belong to the application that
sold them, so a self-hosted bot with its own token has none by construction.

## Known gaps, deliberately

- No ban-creation UI. `POST /api/ops/bans` exists; decide who can issue bans
  before putting a button on it.
- The ops console in `ops-console/` targets Discordeno v21 while `bot/` is v20,
  and isn't wired to anything.
- **`historyRetentionDays` is charged for but never enforced.** `runHistoryPurge`
  (`bot/src/core/scheduler.ts:276`) implements it correctly and the dispatcher
  handles a `purge_expired_history` job — but nothing anywhere creates one. The
  only insert into `scheduled_jobs` in the whole codebase is `kick_unverified`
  at `guildMemberAdd.ts:142`. So the retention tiers the pricing page meters
  and bills for do not apply, and `apiRateLimit.ts:16-17` claims the opposite.
  Submission history grows without bound.
- No on-request deletion path. `privacy.html` accepts deletion requests at
  `contact@creeperdiamonds.xyz`, and honouring one is entirely manual today.
  The shape it should take: scrub the appeal text, keep the ban row.
