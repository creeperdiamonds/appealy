# Startup path

## Changed

**1. Command registration is a deploy step, not a boot step.**
`deno task sync-commands` (add a guild ID for instant dev iteration).

The latency argument for this is weak — `upsertGlobalApplicationCommands` is
one HTTP PUT, a few hundred ms. The "up to an hour" in `commands/index.ts` is
Discord's *propagation* delay after the call returns, and it happens whether
or not you block on it.

The strong argument is the rate limit: **Discord allows 200 global command
creates per day per application.** Registering on boot spends that budget on
restarts. A crash-loop, a rolling deploy, or several replicas can exhaust it,
and then you can't ship a command change until the window resets — on the day
you most need to. `SYNC_COMMANDS_ON_BOOT=true` exists for single-container
dev; don't set it anywhere with replicas or auto-restart.

**2. `pendingAnswers.ts` no longer connects at import time.**
It was the last module-level `await connect(...)`, and worse than the ones
`core/redis.ts` replaced, because it opened a *second* connection alongside
the singleton. `panelOpen.ts`, `formSubmit.ts` and `formSelectStep.ts` all
import it, so the entire interaction path pulled a Redis round trip into
module evaluation. Now uses `getRedis()`.

**3. `subscribeToInvalidations()` runs behind the gateway.**

This one has a real tradeoff the original ordering was deliberate about, so
it's worth stating rather than silently flipping. The old comment said the
subscriber started first "so the cache is already listening when the first
events arrive." Backgrounding it opens a window where the gateway is handling
events but invalidations aren't being received — a config write in that window
leaves a stale entry.

It's acceptable because the staleness is **bounded and self-healing**: the key
expires on its own TTL, which is the fallback `guildConfigCache` was already
designed around. Blocking Discord on Redis is the worse trade. If you ever
remove those TTLs, revisit this.

## Considered and rejected

**Lazy command imports.** Deno caches compiled modules; 66 of them is
single-digit milliseconds. Real cost is near zero and the correctness cost of
a dynamic registry isn't.

**Reordering `startScheduler` / `startControlServer`.** Neither was awaited.
No effect either way — reordered for readability only.

**Dropping `condition: service_healthy` on postgres in compose.** Don't. It
only affects a cold `docker compose up`, not container restarts and not
production — a restarting container doesn't re-evaluate `depends_on`. And
`db/client.ts` connects eagerly with no retry, so removing the health gate
trades a one-time local wait for a crash-loop against a database that isn't
accepting connections yet. Wrong direction.

## Not addressed

The dominant cost in a real boot isn't in this file. It's `READY` plus the
`GUILD_CREATE` burst — Discord sends one per guild before the bot is usable,
and that scales with guild count, not with code. If startup feels slow in
production, measure the gap between "gateway connected" and the last
`GUILD_CREATE` before optimizing anything above.

---

# The GUILD_CREATE burst

Two changes: measure it, and fix the thing measurement was going to point at.

## Measuring — `bot/src/core/startupProfile.ts`

Wall-clock time alone can't tell you whether Discord was slow or you were, and
those need opposite responses. So it tracks both:

```
Startup: guild burst complete
  guildsExpected 4812  guildsReceived 4812
  readyToLastGuildMs 18420
  timeInOurHandlersMs 14100
  handlerSharePercent 76      <- the number that matters
  avgHandlerMs 2  slowestGuild { guildId: "...", ms: 340 }
```

- `handlerSharePercent` high → your handlers are the bottleneck. Batch or defer.
- `handlerSharePercent` low → you're waiting on Discord's delivery rate. Nothing
  to fix; stop looking.

**Knowing when the burst ends.** Discord doesn't announce it. The READY payload
carries unavailable guild stubs, and that array's length is how many
GUILD_CREATEs to expect — so the profiler counts down. Some never arrive (a
guild in an outage stays unavailable), so there's a 10s quiet-period fallback
that reports anyway and logs the shortfall. Without it, one unavailable guild
means you get no numbers at all, in precisely the situation you wanted them.

## Fixing — batched guild upserts

`onGuildCreate` did one `INSERT ... ON CONFLICT DO UPDATE` per guild. On every
reconnect that's N round trips against `max: 10` connections, starving every
other query in the process for the duration. This was visible statically;
instrumentation will tell you the magnitude, not whether it's real.

Now buffered and flushed as multi-row upserts — N queries becomes
`ceil(N / 500)`. Flush is size- *and* time-triggered, because neither works
alone: size alone means a 40-guild bot never flushes, time alone means a
40,000-guild bot builds a huge array before its first write. A genuine new
join is a single event with nothing behind it, so the 250ms timer catches it.

Also gone: the per-guild `logger.info`. N log lines per reconnect is its own
measurable cost and it buried everything else in the startup window.

`flushGuildBuffer()` runs on SIGINT/SIGTERM so a restart mid-burst doesn't
drop buffered rows.

## What to look at next, in order

1. Run it. Read `handlerSharePercent`.
2. If still high, the remaining per-guild work is in `guildConfigCache` warming
   and any `guildMemberAdd` backlog — not this file.
3. If low, you're done. The burst is Discord's pace and no amount of local
   optimization changes it.
