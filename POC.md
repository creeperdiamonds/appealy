# Proof of concept — minimum to run

Two containers. No Redis, no cloud account, no cost.

```bash
cp .env.example .env
# fill in: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY
#          SESSION_SECRET, TOKEN_ENCRYPTION_KEY, OPS_USER_IDS

docker compose -f docker-compose.poc.yml up -d
docker compose -f docker-compose.poc.yml exec -T postgres \
  psql -U appealy -d appealy < db/migrations/0000_*.sql

cd bot && deno task sync-commands
```

Add the dashboard when you want it:

```bash
docker compose -f docker-compose.poc.yml --profile dashboard up -d
```

## What was removed

**Redis.** Replaced by an in-process substitute
(`shared/lib/memoryRedis.ts`), used automatically when `REDIS_URL` is empty.
It implements the seven commands this codebase calls plus pub/sub — not a
general emulator, and anything unimplemented throws by name rather than
silently returning undefined.

Safe because nothing in Redis here is a source of truth: guild config cache
(rebuilt from Postgres), rate-limit counters (reset to zero, which is
generous not dangerous), pending form answers (an in-progress application is
lost, the user restarts), cache invalidation.

**The web dashboard**, behind a compose profile. Every core flow happens
inside Discord — apply, review, pick an outcome, roles applied, ban appeal.
The dashboard is for configuration, and you can configure by inserting rows
while proving the concept.

## Where this stops being enough

The shim lives inside one process, so **it breaks with more than one**:

- Bot and API each hold their own copy. A settings change in the dashboard
  publishes an invalidation the bot never receives, so the bot serves stale
  config until its own TTL expires. "I changed a setting and nothing
  happened" is expected for up to a minute.
- Two bot replicas rate-limit independently, so the effective limit is double
  what's configured.

Both are fine for a POC. Neither is acceptable in production. The startup log
says so every time.

Set `REDIS_URL` to a real instance and everything switches back with no other
change.

## What to prove

In order, because each depends on the last:

1. Bot comes online and `/apply` responds.
2. A submission posts to the review channel.
3. Accept applies roles.
4. Multi-outcome menu appears and grants the right roles per outcome.
5. Ban a test account → they get the appeal DM → accepting unbans them.

Step 5 is the product. If that works, the concept is proven and everything
else is deployment.

## Then what

Once it works, `SETUP.md` covers the full local setup and `terraform/` covers
GCP. Prove it here first — debugging the app and the infrastructure at the
same time, without knowing which is broken, is the trap.
