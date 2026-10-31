#!/bin/bash
# deploy/vm/deploy.sh <pull|api|bot>
#
# Runs on the VM as root, called by scripts/deploy.sh.
#
#   pull  fetch the images, changing nothing that's running
#   api   start or replace the API and the database proxy
#   bot   start or replace the bot
#
# Values that live on GitHub arrive on stdin, one KEY=<base64 of value> per line,
# so they never appear in a process list or a log. Everything else is read from
# Secret Manager with the VM's own identity, the same `latest` versions Cloud Run
# read before.

set -euo pipefail
cd "$(dirname "$0")"

step="${1:?usage: deploy.sh <pull|api|bot>}"

while IFS= read -r line; do
  [ -n "$line" ] || continue
  value="$(printf %s "${line#*=}" | base64 -d)"
  export "${line%%=*}=$value"
done

metadata() {
  curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"
}

token="$(metadata instance/service-accounts/default/token | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')"
project="$(metadata project/project-id)"
VM_INTERNAL_IP="$(metadata instance/network-interfaces/0/ip)"
export VM_INTERNAL_IP

read_secret() {
  curl -fsS -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$1/versions/latest:access" \
    | python3 -c 'import base64, json, sys; sys.stdout.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())'
}

# Assigned before exporting, because `export X="$(...)"` hides a failed read and a
# container would start with an empty token.
for name in DATABASE_URL REDIS_URL DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY   DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET SESSION_SECRET TOKEN_ENCRYPTION_KEY OPS_USER_IDS; do
  secret="appealy-$(printf %s "$name" | tr 'A-Z_' 'a-z-')"
  value="$(read_secret "$secret")"
  export "$name=$value"
done

# Only has to agree between the API and the bot, which both run here, so it's made
# here once. A new one for each deploy would leave them disagreeing until the second
# was replaced, or for good if that step failed.
rpc_secret_file=/opt/appealy/internal-rpc-secret
if [ ! -s "$rpc_secret_file" ]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_hex(32))' > "$rpc_secret_file")
fi
INTERNAL_RPC_SECRET="$(cat "$rpc_secret_file")"
export INTERNAL_RPC_SECRET

# The commit a container is running, or nothing if there's no such container. Taken
# before replacing it, so a new version that won't start can go back to it. Cloud Run
# did that by itself, by not sending traffic to a revision until it was healthy.
running_sha() {
  local image
  image="$(docker inspect --format '{{.Config.Image}}' "appealy-$1-1" 2>/dev/null)" || return 0
  printf %s "${image##*:}"
}

pull() {
  printf %s "$token" | docker login -u oauth2accesstoken --password-stdin "${ARTIFACT_REGISTRY%%/*}" > /dev/null
  docker compose pull --quiet net cloudsql-proxy api bot
}

start_api() {
  local previous
  previous="$(running_sha api)"
  docker compose up -d --pull never net cloudsql-proxy api
  # /health only proves the process is up and checks Redis, so the database gets
  # its own check, over the connection the API itself will use.
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 3 "http://$VM_INTERNAL_IP:3001/health" \
      && docker compose exec -T api node -e '
        const sql = require("postgres")(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
        sql`select 1`.then(() => process.exit(0), () => process.exit(1));
      '; then
      echo "API is answering and can reach the database."
      return 0
    fi
    sleep 1
  done
  echo "API did not become ready within 60 seconds. Its logs are in Cloud Logging, see README.md." >&2
  if [ -n "$previous" ]; then
    echo "Going back to $previous." >&2
    SHA="$previous" docker compose up -d --pull never api
  fi
  return 1
}

start_bot() {
  local since previous
  previous="$(running_sha bot)"
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker compose up -d --pull never bot
  for _ in $(seq 1 120); do
    # Not grep -q. That stops reading at the first match, which can kill `docker
    # compose logs` as it writes the next line, and pipefail reads that as no match.
    if docker compose logs --since "$since" bot 2>/dev/null | grep 'Shard ready' > /dev/null; then
      echo "Bot is connected to Discord."
      return 0
    fi
    sleep 1
  done
  echo "Bot did not connect within 120 seconds. Its logs are in Cloud Logging, see README.md." >&2
  # No bot here before means nothing to go back to, and while moving, the other bot
  # is on Cloud Run, so starting one here would be wrong anyway.
  if [ -n "$previous" ]; then
    echo "Going back to $previous." >&2
    SHA="$previous" docker compose up -d --pull never api bot
  fi
  return 1
}

# Keep a few days of images for going back, but don't let them fill the disk.
# Only once everything is running: `until` goes by when an image was built, not
# when it was pulled, so this deletes anything just pulled that no container uses
# yet.
prune() {
  docker image prune -af --filter until=72h > /dev/null
}

case "$step" in
  pull) pull ;;
  api) start_api ;;
  bot)
    start_bot
    prune
    ;;
  *)
    echo "unknown step: $step" >&2
    exit 2
    ;;
esac

docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'
free -m
