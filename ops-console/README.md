# Ops console (not wired in)

Internal shard-fleet dashboard, kept separate from `web/` because it has a
different audience and must never sit behind Discord OAuth — put it behind
your own SSO.

**Read this before using it:** these were written against **Discordeno v21**
(`createGatewayManager`, `tellWorkerToIdentify`, `shard.heart.rtt`). `bot/`
is on **v18**, where several of those differ or don't exist. Treat the
architecture as sound and the API calls as needing a pass.

They also assume a multi-host sharded topology. Per SCALING.md, the current
bottleneck is a `max: 10` Postgres pool, not shard count — so this is for
when you actually get there, not now.

- `gateway-control-plane.ts` — Redis telemetry push, packed SSE, identify-budget
  governor, control API.
- `shard-fleet-console.jsx` — 5,000-shard heatmap on simulated telemetry.
