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

## The console proxies the API, and that needs two runtime env vars

`web/nginx.conf` forwards `/auth/`, `/api/` and `/webhooks/` to the API rather
than letting the browser call it directly, so the console and the API are one
origin and the `SameSite=Lax` session cookie is first-party by construction.
The reasoning is written at the top of that file; the Docker-shaped part of it
is that the `web` service now reads two variables **at container start**, not
at build time:

| Variable | Compose | Cloud Run |
|---|---|---|
| `API_ORIGIN` | `http://api:3001` | the API service's `https://…` URL |
| `DNS_RESOLVER` | `127.0.0.11` (Docker's embedded DNS) | `169.254.169.254` (the metadata server) |

`DNS_RESOLVER` is not optional. `proxy_pass` built from a variable makes nginx
resolve the backend per request, and nginx will not use the system resolver for
that — without an explicit `resolver` directive the config fails to load at
all. The upside of paying that cost is that a backend which changes address
does not need an nginx restart to be noticed.

`VITE_API_URL` went the other way: it is now **empty** by default. It is baked
into the bundle at build time, so pointing it at an absolute URL puts the
console and the API back on separate origins — which works on localhost, where
the two differ only by port, and stops working the moment they are deployed to
real hostnames. Changing it means rebuilding the image; changing `API_ORIGIN`
means restarting the container. That asymmetry is why the proxy target is the
one that is runtime config.

**`/webhooks/` is proxied and `/health` is not**, deliberately. Tebex posts
payment callbacks to `/webhooks`, and before that location existed the request
fell through to the static `try_files` and got a 404 — checkout completed, the
customer was charged, and the plan never activated, with nothing visible
failing. `/health` stays off the console because it is Cloud Run's probe
against the API service itself and has no reason to be reachable from a
browser.

## Personal-site domain mapping — one-time, manual, not in the workflow

`www.creeperdiamonds.xyz` is served by the same `web` container as Appealy,
split by `server_name` in `web/nginx.conf`. Pointing the name at that service
is a one-time step outside CI:

```bash
gcloud beta run domain-mappings create \
  --service=appealy \
  --domain=www.creeperdiamonds.xyz \
  --region=us-central1 \
  --project=yahav-project-505809
```

It issues a single record: `www CNAME ghs.googlehosted.com`. In Cloudflare it
must be **DNS-only (grey cloud)**, not proxied — a proxied record puts
Cloudflare's certificate in front of Google's managed one and the mapping
never validates. See `deploy/dns/` for the record and the reasoning.

### The apex is a Minecraft address, and stays one

`creeperdiamonds.xyz` itself is NOT mapped, deliberately. It is a CNAME to a
NeoProtect shield with a matching `_minecraft._tcp` SRV record, and port 25565
answers on it. DNS resolves a name to one set of addresses and Cloud Run's do
not speak Minecraft, so mapping the apex would have traded a working server
address for a working web page.

A mapping for the bare apex was created and then deleted once that was
understood. If you recreate it, you are turning off the Minecraft server for
every player who saved the address with its port, and for every Bedrock
client — neither of which uses the SRV record that would otherwise save them.

This is created **once**, not per deploy. `deploy-merged.yml` builds and
deploys the `web` service, but it does not touch domain mappings, and
re-running it is not how DNS or the mapping get updated.

**Nothing deploys on a merge.** Both `deploy-merged.yml` and
`deploy-cloudrun.yml` are `workflow_dispatch` only; the sole workflow that runs
on a push to `main` is `ci.yml`. So a green tick on a commit means the tests
passed, not that the change is live — pushing a fix to `site/`, `web/nginx.conf`
or anything else in the image changes nothing that is being served until someone
runs the deploy by hand:

```bash
gh workflow run deploy-merged.yml -f migrations=skip
```

`migrations` defaults to `apply` in the workflow's own input, which is right for
a normal deploy and wrong for one that only changes static files. Pass `skip`
when the commit touches nothing under `db/migrations/`.

### Verifying

```bash
gcloud beta run domain-mappings describe --domain=www.creeperdiamonds.xyz \
  --region=us-central1 --project=yahav-project-505809

curl -s -o /dev/null -w "www       %{http_code}\n" https://www.creeperdiamonds.xyz/
curl -s -o /dev/null -w "appealy   %{http_code}\n" https://appealy.creeperdiamonds.xyz/
curl -s -o /dev/null -w "dashboard %{http_code}\n" https://appealy.creeperdiamonds.xyz/dashboard/
```

The certificate takes roughly fifteen minutes after DNS propagates, and until
it exists HTTPS fails outright rather than warning — normal during
provisioning, not a misconfiguration.

**Check which page is served, not just that one is.** If `www` returns the
Appealy marketing site, `server_name` did not match and the request fell
through to `default_server`. A 200 alone does not prove the split works:

```bash
curl -s https://www.creeperdiamonds.xyz/ | grep -c "Minecraft"   # personal page -> 1
```

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

curl -s -o /dev/null -w "site      %{http_code}
" http://localhost:5173/
curl -s -o /dev/null -w "dashboard %{http_code}
" http://localhost:5173/dashboard/
curl -s -o /dev/null -w "proxy     %{http_code}
" http://localhost:5173/api/invite
```

Check all three, not just the first. A 200 on `/` only proves nginx started —
the marketing site is static and would answer even with the proxy misconfigured
and `API_ORIGIN` pointing at nothing. `/api/invite` is the cheapest request
that has to travel the whole path to the API and back. **302 is the pass** —
it is a redirect to Discord built from `DISCORD_CLIENT_ID`. A 404 means the
proxy locations did not load and the request was answered by the static
`try_files` instead; a 502 means they did load but `API_ORIGIN` or
`DNS_RESOLVER` is wrong.
