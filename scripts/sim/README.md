# Load simulator

Runs the real bot and the real API against a fake Discord on your own machine,
and reports what they use and how fast they answer. It exists to answer "can
this run on less?" with a measurement.

Nothing leaves the machine. The bot runs with `--allow-net` limited to this
computer, so Deno itself refuses any connection to Discord. The API's `fetch` is
wrapped to do the same. The token is fake, and the database and Redis are
throwaway copies that `run.ts` creates and deletes.

Windows only for now, because of `sampler.ps1` and `limit-daemon.ps1`.

## What it needs

- Deno and Node, the versions the Dockerfiles use.
- A Postgres 16 `bin` folder, such as the EDB "binaries" zip. Needs `pg_stat_statements`.
- A Redis 6.2+ folder with `redis-server` and `redis-cli`.
- The API built and laid out like its image, with no `package.json` above it:

  ```
  cd api && npm ci && npm run build
  mkdir ../../api-image
  cp -r dist node_modules ../../api-image/ && cp -r ../shared ../../api-image/
  ```

## Running it

```
deno run --no-lock --allow-net=127.0.0.1 --allow-env --allow-read \
  --allow-write=<out> --allow-run=<deno,node,powershell,and the Postgres and Redis binaries> \
  -c bot/deno.json scripts/sim/run.ts \
  --label before --guilds 50 --api-dir <api-image> \
  --pg-bin <postgres bin> --redis-bin <redis folder> --out <out>
```

A run takes about 15 minutes. `--scale 0.1` shortens every phase for a quick check.

| Option | What it does |
|---|---|
| `--repo <path>` | Which checkout's bot to run. Compare two commits with a git worktree. |
| `--guilds <n>` | How many servers. Traffic scales with it. |
| `--bot-v8=<flags>`, `--api-node=<flags>` | V8 flags for each process, comma-separated for the bot and space-separated for the API. The `=` matters: without it the flags are read as options of `run.ts` and silently do nothing. |
| `--limits=bot=0.25:512,api=0.15:320` | Hold a process to a share of one logical CPU and a memory ceiling, like a container limit. |
| `--phases normal,busy` | Run only some phases. |
| `--spike-factor 0.5` | Scale the spike phase, to find where things start to bend. |

Then compare two runs:

```
deno run --allow-read scripts/sim/compare.ts <out>/before.json <out>/after.json
```

## The phases

| Phase | Length | Why |
|---|---|---|
| boot | until up, plus 20s | Every server arrives at once. Sets the memory peak. |
| normal | 6 min | Production's real rate, scaled to the server count. This is what almost every hour looks like, so it is what the idle bill pays for. |
| busy | 5 min | About 10x production's messages and hundreds of times its clicks, so there are enough samples to compare latency. |
| spike | 1 min | 100x, plus a raid on one server. Where things start to bend. |
| recovery | 3 min | Back to normal. Does memory come back down? |

The normal rates come from production metrics at 188 servers: about 3 KB/s of
internet traffic, about 31 applications a day, 0.08 HTTP requests a second. The
feature mix in `world.ts` is a guess that errs high.

## Reading the numbers

Compare runs with each other. Don't read them as production's numbers: this
machine's CPU is roughly twice as fast per core as a Cloud Run vCPU, and Postgres
on Windows starts a whole process per connection, so its CPU figures are far
higher than Linux's. Use `--limits` with half the real share to allow for the
slower CPU.

Anything else running on the machine shows up as the app needing more CPU, and
under `--limits` as the app falling behind. One run came out 1.7x worse than an
identical earlier one for that reason alone. Check two numbers before believing a
bad result: "whole machine CPU", and Postgres CPU per query, which nothing here
changes.

Not simulated: nginx and the Cloud SQL proxy, which production's own metrics
cover. Real network latency to Postgres and Redis is also missing: both are local
here, while production's Redis is across the internet.
