# Public status page

A Cloudflare Worker at **https://status.appealy.app**, on the Workers Free plan.

This branch holds only the status page — no app code. Two pieces live with the
app instead, because they are part of it: the bot's heartbeat sender
(`bot/src/core/statusPublisher.ts`) and the deploy wiring that hands it the
shared secret (`deploy/service.yaml`, `scripts/render-service.py`).

- `public/index.html` — the page. A static asset: served before the Worker
  runs, free, and unlimited.
- `src/index.ts` — `/status.json`, `/api/heartbeat`, and the checks.
- `src/model.ts` — every decision, with no I/O. Tested in `test/`.
- `migrations/` — the D1 schema.

## Why it's on Cloudflare

A status page must survive the outage it reports. Appealy is one Cloud Run
instance: a route in the app, a static file in the web image, or a shared
volume all go down with it. This shares nothing with the app — not the host,
not the database, not the DNS record.

## Where the data comes from

| Component | Checked by |
|---|---|
| Dashboard | Each check fetches `https://appealy.app/dashboard/` from outside |
| API | Each check fetches `https://appealy.app/api/config` (no database involved) |
| Discord bot | Heartbeat from the bot every 30s, per shard up/degraded/down |
| Database | The same heartbeat: the bot's `select 1` |

**Silence is the signal.** Nothing ever reports "the bot is down" — a dead
process can't. A heartbeat older than 90s makes the bot down, which is also
what a crash, a failed deploy, or a Google Cloud outage looks like. When the
bot is silent the database is shown as unknown, not down: the heartbeat was
the only view of it.

A probe that fails is retried once, so one dropped connection doesn't paint a
red minute. A probe slower than 2.5s is degraded.

## When a check runs

Either of two things starts one:

- **The Cron Trigger**, every minute.
- **A request for `/status.json`** that finds the summary a minute old or more.
  The very first request, when nothing has been checked yet, waits for the
  check; after that the request is answered straight away and the check runs
  behind it.

The second is there because **the cron alone was not enough**. On a new Workers
Free account, Cloudflare registered the trigger, showed its next run in the
dashboard, and then never fired it — no scheduled events, no errors, for as
long as anyone watched. Cloudflare's community forum has the same report from
other new accounts. A page that depended on the cron showed "no data" the
whole time.

Both paths claim the minute first, by inserting it into `ticks`. The first
insert wins and does the work; any other check for that minute sees its insert
do nothing and stops. So a crowd of stale requests produces one check, and if
the cron starts firing it simply becomes one more claimant — no minute is ever
counted twice.

**The cost of the fallback:** with the cron not firing, minutes are only checked
while something is requesting the page. A minute nobody asked about is a gap in
the history, not downtime. An uptime pinger that fetches `/status.json` once a
minute (cron-job.org, for example) closes those gaps, and is also just a
visitor.

## History

Each check adds one minute to a per-component, per-UTC-day row in `daily`:
minutes up, degraded, and down. The page shows 90 days. Slow counts as
available in the uptime percentage; a minute with no reading — the bot silent,
for the database, or nobody checking at all — is left out rather than counted
either way.

A day is amber for any downtime under 30 minutes and red from 30. A redeploy
costs the bot a minute or two, and painting that red would make routine
restarts look like bad days.

## Free-plan budget

| | Per day | Free limit |
|---|---|---|
| D1 rows written | ~17k at most (one check per minute: 4 upserts, a minute claim and the summary; heartbeat every 30s) | 100k |
| D1 rows read | ~520k at most (90 days × 4 components per check) | 5M |
| Worker requests | ~2.9k heartbeats + 1 per viewer per minute | 100k |

A check runs at most once a minute however many requests arrive, so traffic
does not multiply D1 usage. `/status.json` reads one prebuilt row and is
edge-cached for 30 seconds. The one thing that scales with traffic is Worker
requests from open pages: 100k a day is about 70 people with the page open
around the clock. Beyond that, requests get 429 until the day resets.

## Setting it up

```bash
npm ci
npx wrangler login
npx wrangler d1 create appealy-status        # paste database_id into wrangler.jsonc
npm run db:migrate
openssl rand -hex 32                          # the heartbeat secret
npx wrangler secret put HEARTBEAT_SECRET      # paste it
npx wrangler deploy
```

Then give the bot the same secret, and deploy it:

```bash
gh secret set STATUS_HEARTBEAT_SECRET -R creeperdiamonds/appealy
gh workflow run deploy-merged.yml -f migrations=skip
```

`scripts/render-service.py` refuses to render without that secret, so a deploy
can't silently ship a bot that never reports in.

## Two things to watch

**Don't add operator data.** Per shard: an id and a state. No latency figures,
host ids, worker ids or guild counts. Together they're a map of the
infrastructure and a way to tell which shard is weakest.

**One heartbeat row.** Right while every shard runs in one process. If shards
are ever split across processes, each overwrites the others' report — that
needs a per-process key first.
