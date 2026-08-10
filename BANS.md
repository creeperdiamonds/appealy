# Bans and appeals — wiring notes

Seven files added, one edited. Nothing existing was removed.

## Added
| File | Role |
|---|---|
| `shared/schema/bans.ts` | `bans` + `ban_appeals` tables, `toPublicBan()` serialization boundary, `APPEAL_RULES` |
| `bot/src/core/banCache.ts` | Full ban set in memory, pub/sub deltas, 5-min reload |
| `bot/src/core/banGate.ts` | Pre-dispatch gate + notify-once-per-hour |
| `api/src/middleware/banGate.ts` | Session gate, guild-list decoration, `publishBanChange()` |
| `api/src/routes/appeals.ts` | Submit / status / `acceptAppeal()` |
| `web/src/pages/Banned.tsx` | Account-ban takeover + shared `AppealForm` |
| `web/src/components/ServerBanned.tsx` | Crossed-out guild option + appeal sheet |

Edited: `bot/src/events/interactionCreate.ts` (gate as first statement).
Appended: `web/src/index.css` (ban styles, reuses existing `--act` / `--line` / `--panel`).

## Four things you have to do by hand

**1. Re-export the schema.** `shared/schema/bans.ts` isn't reachable until it's
in the barrel that `db.query` builds from — otherwise `schema.bans` is undefined
at runtime and the failure looks like a Drizzle bug.

```ts
// shared/schema/index.ts
export * from "./bans.ts";
```

**2. Start the cache in `ready.ts`,** next to `subscribeToInvalidations()`:

```ts
await startBanCache();
```

Without it `isBanned()` returns null forever and the gate is a no-op — it
fails open by design, and silently.

**3. Mount in order.** `banGate` needs `req.userId`, so it goes after
`requireSession`; `guildAccess` goes after it so a banned guild returns a
ban-shaped 403 rather than a generic one.

```ts
app.use("/appeals", appealsRouter);       // before banGate — banned users must reach it
app.use(requireSession, banGate);
```

**4. Handle 403 `banned` in the API client.** `web/src/lib/api.ts` currently
redirects to login on 401; a 403 with `{ error: "banned" }` needs to surface
the ban instead of throwing an `ApiError` that `App.tsx` renders as fatal.

```ts
if (res.status === 403) {
  const body = await res.json();
  if (body.error === "banned") throw new BannedError(body.ban);
}
```

Then in `App.tsx`, catch `BannedError` and render `<Banned />` instead of the
shell. Deliberately not a route — a banned account that can navigate to and
from `/banned` is one bad guard away from a redirect loop.

## Migration

`drizzle-kit generate` picks up both tables, but check the generated SQL for the
two partial indexes (`bans_active_uniq`, `ban_appeals_one_open`). Drizzle's
`.where()` on indexes has been inconsistent across versions; if they come out
unconditional, write them by hand:

```sql
create unique index bans_active_uniq on bans (subject, subject_id) where revoked_at is null;
create unique index ban_appeals_one_open on ban_appeals (ban_id) where status = 'open';
```

These aren't optional. The first stops two staff creating conflicting active
bans; the second is what actually caps the appeal queue when Redis is down.

## Not built

- **Staff review UI.** `acceptAppeal()` exists; there's no screen calling it.
  It belongs in Operations.tsx next to the audit log.
- **Ban creation.** No route writes a ban yet — deliberate. Decide who can
  issue them and how that's authenticated before exposing a write path.
- **Denial flow.** `acceptAppeal` has no `denyAppeal` twin. Same shape, sets
  status and `decidedAt` without touching the ban.
