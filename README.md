# Public status page

A Cloudflare Worker at **https://status.appealy.app**, on the Workers Free plan.

This branch holds only the status page — no app code. Two pieces live with the
app instead, because they are part of it: the bot's heartbeat sender
(`bot/src/core/statusPublisher.ts`) and the deploy wiring that hands it the
shared secret (`deploy/service.yaml`, `scripts/render-service.py`).

- `public/index.html` — the page. A static asset: served before the Worker
  runs, free, and unlimited.
- `src/index.ts` — `/status.json`, `/api/heartbeat`, and a cron every minute.
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
| Dashboard | The cron fetches `https://appealy.app/dashboard/` from outside |
| API | The cron fetches `https://appealy.app/api/config` (no database involved) |
| Discord bot | Heartbeat from the bot every 30s, per shard up/degraded/down |
| Database | The same heartbeat: the bot's `select 1` |

**Silence is the signal.** Nothing ever reports "the bot is down" — a dead
process can't. A heartbeat older than 90s makes the bot down, which is also
what a crash, a failed deploy, or a Google Cloud outage looks like. When the
bot is silent the database is shown as unknown, not down: the heartbeat was
the only view of it.

A probe that fails is retried once, so one dropped connection doesn't paint a
red minute. A probe slower than 2.5s is degraded.

## History

Each cron adds one minute to a per-component, per-UTC-day row in `daily`:
minutes up, degraded, and down. The page shows 90 days. Slow counts as
available in the uptime percentage; a minute with no reading (the bot silent,
for the database) is left out rather than counted either way.

A day is amber for any downtime under 30 minutes and red from 30. A redeploy
costs the bot a minute or two, and painting that red would make routine
restarts look like bad days.

## Free-plan budget

| | Per day | Free limit |
|---|---|---|
| D1 rows written | ~17k (4 upserts + summary per minute, heartbeat every 30s) | 100k |
| D1 rows read | ~520k (90 days × 4 components per minute) | 5M |
| Worker requests | ~2.9k heartbeats + 1 per viewer per minute | 100k |

`/status.json` reads one prebuilt row and is edge-cached for 30 seconds. The
page polls once a minute. The one thing that scales with traffic is Worker
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
