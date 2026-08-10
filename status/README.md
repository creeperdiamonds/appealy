# Public status page

Two files. No build step, no framework, no API call.

- `bot/src/core/statusPublisher.ts` writes `status.json` every 10s.
- `status/index.html` fetches it and renders.

## Wiring

**1. `ready.ts`:** `startStatusPublisher(bot);`

**2. Shared volume** — the gateway writes, nginx reads:

```yaml
# docker-compose.yml
bot:
  volumes: [status:/srv/status]
  environment: [STATUS_OUT_DIR=/srv/status]
web:
  volumes: [status:/usr/share/nginx/html/status:ro]
volumes:
  status:
```

**3. nginx** — serve `status/` but never cache the JSON:

```nginx
location /status/status.json {
  add_header Cache-Control "no-store";
}
location /status/ { }
```

The `no-store` is load-bearing. A cached snapshot during an outage tells people
everything is fine, which is worse than no status page at all.

## Why it's built this way

**Separate from `web/`.** The status page must survive the outage it reports.
If it were a route in the SPA it would need the API, which needs the same
Postgres pool that will most likely be what broke.

**Staleness is the outage signal.** Nothing publishes "I am down" — a dead
gateway can't. The file stops being rewritten, and after 60s the page says so.

**The lookup runs client-side.** `(guild_id >> 22) % total_shards` is
arithmetic. Doing it in the browser means it still works when the servers are
struggling, and there's no server-id traffic to log or leak.

**Write-then-rename.** A visitor loading mid-write would get truncated JSON and
the page would render an outage it invented.

## Two things to watch

**Resharding changes every guild's answer.** `totalShards` is in the snapshot,
so the page recomputes automatically — but only if the JSON isn't cached. See
the nginx block above.

**Don't add operator data.** No host ids, no worker ids, no per-shard RTT, no
guild counts. Together they're a map of your infrastructure and a way to tell
which shard is weakest. That's the internal console's job.

## Worth adding later

Incident history. "Is it down right now" is the smaller half of what people
want — "has this been happening all week" is the question behind most support
tickets. A daily uptime bar per shard, from the same snapshots, would answer it.
