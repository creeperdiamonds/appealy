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

## Apex domain mapping — one-time, manual, not in the workflow

`creeperdiamonds.xyz` is served by the same `web` container as Appealy,
split by `server_name` in `web/nginx.conf`. Getting the domain itself
pointed at that service is a separate, one-time step outside CI:

```bash
gcloud beta run domain-mappings create \
  --service=appealy \
  --domain=creeperdiamonds.xyz \
  --region=us-central1 \
  --project=yahav-project-505809
```

The apex is a bare domain, so it needs **A and AAAA records**, not a CNAME —
a CNAME cannot coexist with other records at the zone apex, and Google
issues the A/AAAA values as part of running the command above.

In Cloudflare, both records must be **DNS-only (grey cloud)**, not proxied.
A proxied record puts Cloudflare's certificate in front of Google's own
managed certificate for the mapping, and the mapping never validates.

This is created **once**, not per deploy. `deploy-merged.yml` builds and
deploys the `web` service on every merge; it does not touch domain
mappings, and re-running it is not how DNS or the mapping get updated.

### What the mapping issued, and what had to be removed

Created 2026-09-02. `deploy/dns/creeperdiamonds.xyz.zone` holds these eight
records in BIND format for Cloudflare's importer, with the deletion and
proxy-status warnings alongside them — see `deploy/dns/README.md`.

These are Google's standard Cloud Run anycast addresses, but take them from
the command's own output rather than from here — a document is not the system
of record for DNS:

```
A     216.239.32.21    216.239.34.21    216.239.36.21    216.239.38.21
AAAA  2001:4860:4802:32::15  ...:34::15  ...:36::15  ...:38::15
```

**The apex was on registrar parking and had to be cleared first.** It held six
A records (`82.22.5.17`, `.20`, `.22`, `.24`, `.25` and `104.167.24.195`).
Leaving any of them alongside Google's would resolve unpredictably — a
visitor would reach the parking host or Cloud Run depending on which record
their resolver picked.

That parking also explains the symptom: `http://creeperdiamonds.xyz` answered
**301 to `http://www.creeperdiamonds.xyz`**, and `www` did not exist, so the
apex redirected to NXDOMAIN while HTTPS had no listener at all. Deleting the
parking records removes the redirect with them; there is no `www` record to
add unless you want one.

### Verifying

```bash
gcloud beta run domain-mappings describe --domain=creeperdiamonds.xyz \
  --region=us-central1 --project=yahav-project-505809

curl -s -o /dev/null -w "apex      %{http_code}\n" https://creeperdiamonds.xyz/
curl -s -o /dev/null -w "appealy   %{http_code}\n" https://appealy.creeperdiamonds.xyz/
curl -s -o /dev/null -w "dashboard %{http_code}\n" https://appealy.creeperdiamonds.xyz/dashboard/
```

The certificate takes roughly fifteen minutes after DNS propagates, and until
it exists HTTPS on the apex fails outright rather than warning — that is
normal during provisioning and not a misconfiguration.

**Check which page the apex serves, not just that it answers.** If it returns
the Appealy marketing site, `server_name creeperdiamonds.xyz` did not match
and the request fell through to `default_server`. A 200 alone does not prove
the split is working:

```bash
curl -s https://creeperdiamonds.xyz/ | grep -c "Minecraft"   # apex page -> 1
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
curl -I http://localhost:5173
```
