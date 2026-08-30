# Platform bans and appeals

Platform-level bans: an operator bars an account (or a guild) from Appealy
itself, and the banned party can appeal. This is distinct from the per-server
ban appeals that guilds run for their own members — those live in
`APPEALS.md`.

This document describes what is built. It was previously a wiring checklist
for work that has since shipped; if you are looking for the steps, they are
done.

## Where it lives

| File | Role |
|---|---|
| `shared/schema/platformBans.ts` | `platform_bans` + `platform_ban_appeals`, `toPublicBan()` serialization boundary, `APPEAL_RULES` |
| `bot/src/core/banCache.ts` | Full ban set in memory, pub/sub deltas, 5-minute reload |
| `bot/src/core/banGate.ts` | Pre-dispatch gate, notify-once-per-hour |
| `api/src/middleware/banGate.ts` | Session gate, guild-list decoration, `publishBanChange()` |
| `api/src/routes/platformAppeals.ts` | Submitting an appeal, reading its status |
| `api/src/routes/ops.ts` | Operator side: list, accept, deny, create, revoke |
| `web/src/pages/Banned.tsx` | Account-ban takeover, shared `AppealForm` |
| `web/src/components/ServerBanned.tsx` | Crossed-out guild option, appeal sheet |
| `web/src/pages/OpsAppeals.tsx` | Operator review queue |

The gate is wired at `bot/src/events/interactionCreate.ts:35` and the cache is
started at `bot/src/events/ready.ts:33`.

## The routes

Appellant-facing, mounted at `/api/platform-appeals` (`app.ts:174`):

- `POST /` — submit an appeal
- `GET /:banId` — read its status

Operator-facing, mounted at `/api/ops` behind `requireSession` and
`requireOpsUser` (`app.ts:178`):

- `GET /appeals` — the review queue
- `POST /appeals/:id/accept` and `POST /appeals/:id/deny`
- `POST /bans` — issue a ban
- `DELETE /bans/:id` — revoke one

## Two things that look like mistakes and are not

**Platform appeals mount before the ban gate.** They are the only endpoints a
banned user must still reach — a ban that also blocks the appeal form is a ban
with no way out. `app.ts:171` carries the same note, because the ordering is
easy to "tidy" into a bug.

**The bot's gate fails open.** If `isBanned()` cannot answer — the cache has
not loaded, Redis is down — the interaction proceeds. A ban system that bricks
the bot when its cache is cold is worse than one that occasionally lets a
banned user through for a few seconds, given the cache reloads every five
minutes and takes pub/sub deltas in between.

## The two partial indexes

`platform_bans_active_uniq` and `platform_ban_appeals_one_open` are partial
unique indexes, and they are load-bearing rather than cosmetic:

```sql
CREATE UNIQUE INDEX "platform_bans_active_uniq" ON "platform_bans" ("subject","subject_id") WHERE revoked_at is null;
CREATE UNIQUE INDEX "platform_ban_appeals_one_open" ON "platform_ban_appeals" ("ban_id") WHERE status = 'open';
```

The first stops two operators creating conflicting active bans for the same
subject. The second is what caps the appeal queue when Redis is down — without
it, a banned user can submit unboundedly many open appeals.

Drizzle's `.where()` on indexes has been inconsistent across versions, so if
you ever regenerate the initial migration, check that both keep their `WHERE`
clause rather than coming out unconditional. `SETUP.md` records that the
current generated SQL is correct.

## Not built, deliberately

- **A ban-creation UI.** `POST /api/ops/bans` exists and works; nothing in the
  dashboard calls it. Deciding who may issue a platform ban, and how that is
  authorised, should come before putting a button on it.

## What a purge does not touch

`platform_bans` has no foreign key to `guilds` — its only relationship is
`platform_ban_appeals.ban_id → platform_bans.id`. A guild being deleted, for
any reason including the 30-day removal purge, leaves the ban ledger standing.
That is deliberate: an appeal decision has to remain checkable after a server
stops using the bot.
