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

## Known gaps, deliberately

- No ban-creation UI. `POST /api/ops/bans` exists; decide who can issue bans
  before putting a button on it.
- The ops console in `ops-console/` targets Discordeno v21 while `bot/` is v18,
  and isn't wired to anything.
- `dataExportService.ts` doesn't yet include appeal bodies or ban evidence.
  Both are personal data. A deletion request should scrub the appeal text but
  keep the ban row.
