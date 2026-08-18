# What's in this drop

Built on `main` as of the last fetch. Every file from `main` is present; nothing
of yours was dropped. Review on a branch before merging.

## New files (19)

**Multi-outcome review** — your idea, the biggest feature here.
`shared/schema/outcomes.ts`, `api/src/routes/outcomes.ts`,
`bot/src/interactions/outcomeConfirm.ts`, `web/src/pages/OutcomeEditor.tsx`,
`web/src/components/RolePicker.tsx`, `OUTCOMES.md`

**Sharding + billing**
`bot/src/core/sharding.ts` (auto shard count, session-budget guard),
`bot/src/core/entitlements.ts` (Discord App Subscriptions)

**Migrations** — `0001` (form_outcomes), `0002` (denial outcomes)

**Deployment** — `docker-compose.pi.yml`, `PI.md`, `.env.production.example`

**Brand** — `brand/` (door icon, wordmark, favicon)

## Modified

Ban system wiring, startup order, guild-upsert batching, self/platform mode,
rate-limit branches, Cloud Run workflow. Full reasoning is in the file headers.

## Two things I changed about the repo itself

**`appealy-complete.zip` removed and gitignored.** It was committed into the
repo. Every version stays in git history permanently, so a 400KB archive pushed
a few times becomes megabytes of clone weight for something nobody reads from
git. Use GitHub Releases for distributables instead.

**`docker-compose.yml` binds Postgres to `127.0.0.1`.** It was on all
interfaces with the password `appealy`.

## Before you merge

1. `git checkout -b claude-changes` — don't push straight to main.
2. Run the three migrations against a scratch database first. `0000` is a full
   initial create and will collide with an existing schema.
3. Read `.github/workflows/deploy-cloudrun.yml` — the bot needs
   `--min-instances=1 --no-cpu-throttling --max-instances=1` or Cloud Run will
   crash-loop it through your daily Discord session budget. Secrets moved from
   `env_vars` to Secret Manager.
4. `git status` before committing — confirm no `.env`.

## Still not done

- Outcome CRUD has no nav entry in `App.tsx` (page exists, unreachable).
- `dataExportService` doesn't include user-level platform appeals by design.
- The ops console in `ops-console/` targets Discordeno v21; `bot/` is v20.
