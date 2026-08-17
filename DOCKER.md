# Docker fixes

Four things wrong, one of which meant the `web` image could not build at all.

## 1. `web` build was broken — my fault

`web/src` imports types from `../../../shared/schema/platformBans` (the ban
screen and the API client). `web/Dockerfile` never copied `shared/`, so the
build failed at module resolution, pointing at a path the Dockerfile never
created.

This broke when I added the ban screen. Compose hid it locally if an old image
was cached; a clean build in CI would not have.

Fixed: `COPY shared ./shared` before the web build.

## 2. `web` listened on port 80; Cloud Run assigns the port

Cloud Run injects `PORT` and expects the container to listen on it. nginx
can't read an env var from a config file, so `web/nginx.conf` is now an
envsubst template (`/etc/nginx/templates/`, which `nginx:1.27-alpine` handles
on startup) with `listen ${PORT}` and a default of 8080.

A container listening on the wrong port fails its Cloud Run health check with
no error that says so — it just reports the revision as unhealthy.

Compose unchanged from the outside: `5173:8080` instead of `5173:80`, so
`http://localhost:5173` still works.

The bot's control server now reads `PORT` too, after `BOT_INTERNAL_PORT` so a
self-hosted deployment can still pin it. The API already read `PORT`.

## 3. No `.dockerignore` anywhere

Two consequences, one serious.

**Secrets.** `api/Dockerfile` and `web/Dockerfile` both do a broad
`COPY api ./` / `COPY web ./`. Without a `.dockerignore`, a local `.env` in
either directory gets baked into an image layer — and an image in Artifact
Registry is readable by anyone with pull access, permanently, even if a later
layer deletes the file. Deleting a file in a subsequent layer does not remove
it from the one before.

**Speed.** The context included `node_modules` and `.git`, which on this repo
is most of what gets uploaded on every build.

## 4. Workflow: bot on Cloud Run

Unchanged advice — `api` and `web` fit Cloud Run well. The bot needs a
gateway WebSocket open 24/7, and Cloud Run throttles CPU between requests and
scales to zero. Without `--min-instances=1 --no-cpu-throttling
--max-instances=1` it connects, goes quiet, misses heartbeats, gets
disconnected, and reconnects — spending a Discord session start each time
until the daily budget is gone and the bot cannot start at all.

Those flags are in the workflow now. With them, Cloud Run bills CPU
continuously, which is roughly e2-micro pricing with more moving parts — a
small Compute Engine VM is cheaper and simpler for the bot specifically.

## Yaakov's three commits

All kept. One fix worth mentioning: `steps.deploy.outputs.url` in the
`Print Deployed URL` step needs the deploy step to carry `id: deploy`, which
it didn't — so the echo printed an empty string. Added.

`DATABASE_URL` and `REDIS_URL` moved from `env_vars` to `secrets:`. They were
correctly stored as GitHub secrets; the issue is on the other end — anything
passed through Cloud Run's `env_vars` is written into the service config,
where `gcloud run services describe` and anyone with `roles/viewer` can read
it. Secret Manager keeps them out of the service definition and gives you
access logs and rotation without redeploying.

## Test before deploying

```bash
docker compose build --no-cache web    # this is the one that was broken
docker compose up -d
curl -I http://localhost:5173
```
