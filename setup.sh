#!/usr/bin/env bash
#
# setup.sh — first-run setup for Appealy.
#
# Safe to run more than once. It never overwrites an existing .env, never
# re-runs a migration that's already applied, and stops at the first thing it
# can't do for you rather than half-finishing.
#
#   ./setup.sh              full guided setup
#   ./setup.sh --check      preflight only, changes nothing
#
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ $(tput colors 2>/dev/null || echo 0) -ge 8 ]]; then
  B=$(tput bold); DIM=$(tput dim); R=$(tput sgr0)
  RED=$(tput setaf 1); YEL=$(tput setaf 3); GRN=$(tput setaf 2); BLU=$(tput setaf 4)
else
  B=""; DIM=""; R=""; RED=""; YEL=""; GRN=""; BLU=""
fi

STEP=0
step()  { STEP=$((STEP+1)); printf '\n%s[%d/%d] %s%s\n' "$B$BLU" "$STEP" "$TOTAL_STEPS" "$1" "$R"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$R" "$1"; }
info()  { printf '  %s·%s %s\n' "$DIM" "$R" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YEL" "$R" "$1"; }
die()   { printf '\n%s✗ %s%s\n\n' "$B$RED" "$1" "$R" >&2; exit 1; }

TOTAL_STEPS=7
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && { CHECK_ONLY=1; TOTAL_STEPS=1; }

trap 'printf "\n%s✗ Stopped at step %d. Nothing after this point ran.%s\n\n" "$RED" "$STEP" "$R"' ERR

printf '%s\n' "${B}Appealy setup${R}"
printf '%s\n' "${DIM}Ctrl-C at any point is safe.${R}"

# ---------------------------------------------------------------------------
step "Checking what's installed"
# ---------------------------------------------------------------------------
MISSING=0
need() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 — $($2 2>/dev/null | head -1)"
  else
    warn "$1 is missing — $3"
    MISSING=1
  fi
}

need docker  "docker --version"  "install Docker Desktop: https://docs.docker.com/get-docker/"
need deno    "deno --version"    "install Deno: https://docs.deno.com/runtime/getting_started/installation/"
need node    "node --version"    "install Node 20+: https://nodejs.org"
need openssl "openssl version"   "usually preinstalled; on Debian/Ubuntu: sudo apt install openssl"

# Only meaningful if docker itself exists — otherwise these produce two more
# confusing failures about a thing the user already knows is missing.
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose — $(docker compose version | head -1)"
  else
    warn "'docker compose' not available (the old standalone 'docker-compose' won't work here)"
    MISSING=1
  fi

  if docker info >/dev/null 2>&1; then
    ok "Docker daemon is running"
  else
    warn "Docker is installed but not running — start Docker Desktop and try again"
    MISSING=1
  fi
fi

[[ $MISSING -eq 1 ]] && die "Install the things above, then run this again."
[[ $CHECK_ONLY -eq 1 ]] && { printf '\n%sAll good.%s\n\n' "$GRN" "$R"; exit 0; }

# ---------------------------------------------------------------------------
step "Setting up .env"
# ---------------------------------------------------------------------------
# Never clobber. Someone re-running this after filling in real credentials
# should not lose them, and a backup they have to find later is worse than
# just refusing to touch the file.
# If .env ever got committed, everything this script is about to write goes
# straight to a public repo on the next push. Cheap to check, expensive to miss.
if [[ -d .git ]] && git ls-files --error-unmatch .env >/dev/null 2>&1; then
  die ".env is tracked by git. Run: git rm --cached .env && git commit -m 'stop tracking .env'
     Then rotate anything already pushed — bot token, client secret, SESSION_SECRET,
     TOKEN_ENCRYPTION_KEY. Refusing to write secrets into a tracked file."
fi

if [[ -f .env ]]; then
  ok ".env already exists — leaving it alone"
else
  cp .env.example .env
  ok "Created .env from .env.example"
fi

# read/write a KEY=value in .env, portable across GNU and BSD sed
get_env() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_env() {
  local key=$1 val=$2 tmp
  tmp=$(mktemp)
  if grep -qE "^${key}=" .env; then
    # awk avoids sed's escaping problems with / and & in tokens
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp"
  else
    cp .env "$tmp"; printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  mv "$tmp" .env
}

ask() {
  local key=$1 prompt=$2 current secret=${3:-0} val
  current=$(get_env "$key")
  if [[ -n "$current" ]]; then
    ok "$key is already set"
    return
  fi
  printf '\n  %s%s%s\n' "$B" "$prompt" "$R"
  if [[ $secret -eq 1 ]]; then
    read -r -s -p "  > " val < /dev/tty; echo
  else
    read -r -p "  > " val < /dev/tty
  fi
  [[ -z "$val" ]] && die "$key can't be empty. Run the script again when you have it."
  set_env "$key" "$val"
  ok "$key saved"
}

# ---------------------------------------------------------------------------
step "Generating secrets"
# ---------------------------------------------------------------------------
# These are the two nobody should be typing by hand. TOKEN_ENCRYPTION_KEY in
# particular must decode to exactly 32 bytes or api/src/utils/crypto.ts throws
# at startup with an error most people would read as a bug.
for pair in "SESSION_SECRET:48" "TOKEN_ENCRYPTION_KEY:32"; do
  key=${pair%%:*}; bytes=${pair##*:}
  if [[ -n "$(get_env "$key")" ]]; then
    ok "$key already set"
  else
    set_env "$key" "$(openssl rand -hex "$bytes")"
    ok "$key generated ($bytes bytes)"
  fi
done

# ---------------------------------------------------------------------------
step "Discord credentials"
# ---------------------------------------------------------------------------
cat <<EOF

  ${DIM}All of these come from https://discord.com/developers/applications
  Open your application (or create one), then:${R}

    ${B}General Information${R}  → Application ID, Public Key
    ${B}Bot${R}                  → Token  (click Reset Token if you never copied it)
    ${B}OAuth2${R}               → Client ID, Client Secret

EOF
ask DISCORD_APPLICATION_ID "Application ID  (General Information → Application ID)"
ask DISCORD_PUBLIC_KEY     "Public Key  (General Information → Public Key)"
ask DISCORD_BOT_TOKEN      "Bot Token  (Bot → Token) — input hidden" 1
ask DISCORD_CLIENT_ID      "Client ID  (OAuth2 → Client ID)"
ask DISCORD_CLIENT_SECRET  "Client Secret  (OAuth2 → Client Secret) — input hidden" 1

# .env.example pins DEPLOYMENT_MODE=self. Re-assert it if someone blanked it,
# because this script only ever sets up a self-hosted instance — the hosted
# deployment is configured by hand, not by this.
if [[ -z "$(get_env DEPLOYMENT_MODE)" ]]; then
  set_env DEPLOYMENT_MODE "self"
  ok "DEPLOYMENT_MODE set to self"
fi

if [[ -z "$(get_env DISCORD_REDIRECT_URI)" ]]; then
  set_env DISCORD_REDIRECT_URI "http://localhost:3000/auth/discord/callback"
  ok "DISCORD_REDIRECT_URI defaulted to localhost"
fi

cat <<EOF

  ${YEL}!${R} Two things this script ${B}cannot${R} do for you, in the same portal:

    1. ${B}Bot → Privileged Gateway Intents${R}
       Turn on ${B}Server Members Intent${R} and ${B}Message Content Intent${R}.

    2. ${B}OAuth2 → Redirects${R}
       Add exactly:  ${B}$(get_env DISCORD_REDIRECT_URI)${R}

  ${DIM}Ban appeals also need the Moderation intent, which is not privileged —
  no portal toggle, it just works once the bot restarts.${R}

EOF
read -r -p "  Press Enter once both are done... " _ < /dev/tty

# ---------------------------------------------------------------------------
step "Operator access"
# ---------------------------------------------------------------------------
if [[ -n "$(get_env OPS_USER_IDS)" ]]; then
  ok "OPS_USER_IDS already set"
else
  cat <<EOF

  ${DIM}Your own Discord user ID. This is who can review ban appeals and issue
  platform bans. It is not a password — user IDs are public. Leaving it empty
  turns the operator surface off entirely, which is safe but means nobody can
  review anything.

  To get it: Discord → Settings → Advanced → Developer Mode ON,
  then right-click your own name → Copy User ID.${R}

EOF
  read -r -p "  > " ops < /dev/tty
  if [[ -z "$ops" ]]; then
    warn "Left empty — operator surface stays off. Set OPS_USER_IDS in .env later."
  elif [[ ! "$ops" =~ ^[0-9]{15,25}(,[0-9]{15,25})*$ ]]; then
    die "That doesn't look like a Discord user ID (15-25 digits). Nothing was saved."
  else
    set_env OPS_USER_IDS "$ops"
    ok "OPS_USER_IDS saved"
  fi
fi

# A placeholder here doesn't break anything — the app treats it as blank and
# stays in self mode — but saying so now beats wondering later why billing
# never appeared.
# With DEPLOYMENT_MODE pinned to self, a Stripe key here does nothing at all.
# Worth saying out loud — otherwise someone pastes one in, waits for billing to
# appear, and has no idea why it never does.
if [[ "$(get_env DEPLOYMENT_MODE)" == "self" ]]; then
  info "Running in self mode: billing off, caps from CAP_* in .env."
  if [[ -n "$(get_env STRIPE_SECRET_KEY)" ]]; then
    warn "STRIPE_SECRET_KEY is set but self mode ignores it. Remove it, or set DEPLOYMENT_MODE=platform if you really meant to run billing."
  fi
fi

if [[ -z "$(get_env PRIVILEGED_GUILD_IDS)" ]]; then
  cat <<EOF

  ${DIM}Optional: a server of your own that should skip the normal limits
  (your main server, or a support server). Right-click the server icon in
  Discord → Copy Server ID. Press Enter to skip.${R}

EOF
  read -r -p "  > " priv < /dev/tty
  if [[ -n "$priv" ]]; then
    if [[ "$priv" =~ ^[0-9]{15,25}(,[0-9]{15,25})*$ ]]; then
      set_env PRIVILEGED_GUILD_IDS "$priv"
      ok "PRIVILEGED_GUILD_IDS saved — those servers get the highest caps available"
    else
      warn "That doesn't look like a server ID; skipping. Set PRIVILEGED_GUILD_IDS in .env later."
    fi
  else
    info "Skipped — every server uses the normal caps."
  fi
fi

# ---------------------------------------------------------------------------
step "Starting the database and running migrations"
# ---------------------------------------------------------------------------
info "Starting postgres and redis..."
docker compose up -d postgres redis >/dev/null
ok "Containers up"

printf '  '
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -q 2>/dev/null; then
    printf '\n'; ok "Postgres is accepting connections"; break
  fi
  printf '.'
  [[ $i -eq 60 ]] && { printf '\n'; die "Postgres didn't come up in 60s. Try: docker compose logs postgres"; }
  sleep 1
done

# The migration in db/migrations is a full initial create, because this repo
# had no migration history. Running it against a database that already has
# tables will fail partway and leave things in an unclear state — so check
# first rather than find out from a stack trace.
EXISTING=$(docker compose exec -T postgres psql -U appealy -d appealy -tAc \
  "select count(*) from information_schema.tables where table_schema='public' and table_name not like 'drizzle%';" 2>/dev/null || echo 0)
EXISTING=$(printf '%s' "$EXISTING" | tr -d '[:space:]')

if [[ "${EXISTING:-0}" -gt 0 ]]; then
  warn "Database already has $EXISTING tables."
  cat <<EOF

  ${DIM}The migration is a fresh full-schema create (this repo had no migration
  history before), so applying it to a populated database will fail partway.
  Skipping it. Diff it against your live schema by hand:

    db/migrations/0000_*.sql${R}

EOF
else
  info "Installing API dependencies (first run takes a minute)..."
  ( cd api && npm install --no-audit --no-fund --silent )
  ok "Dependencies installed"

  info "Applying migration..."
  ( cd api && npm run db:migrate --silent )
  ok "Schema created"
fi

# ---------------------------------------------------------------------------
step "Starting everything and registering commands"
# ---------------------------------------------------------------------------
info "Building and starting bot, api, and web..."
docker compose up -d --build >/dev/null
ok "All services started"

# Deliberately not part of boot — Discord allows only 200 global command
# creates per day, so registering on every restart burns that budget.
info "Registering slash commands with Discord (once, not on every restart)..."
if ( cd bot && deno task sync-commands >/dev/null 2>&1 ); then
  ok "Commands registered"
  info "Global commands can take up to an hour to appear. That's Discord, not you."
else
  warn "Command sync failed. Check your bot token, then: cd bot && deno task sync-commands"
fi

# ---------------------------------------------------------------------------
cat <<EOF

${B}${GRN}Done.${R}

  Dashboard   ${B}http://localhost:5173${R}
  API         ${B}http://localhost:3000${R}

${B}Invite the bot to a server${R}
  https://discord.com/oauth2/authorize?client_id=$(get_env DISCORD_APPLICATION_ID)&permissions=1374389715462&scope=bot%20applications.commands

${B}Useful commands${R}
  docker compose logs -f bot      watch the bot
  docker compose logs -f api      watch the API
  docker compose down             stop everything
  docker compose up -d --build    restart after code changes
  ./setup.sh --check              re-check your tools

${B}If something looks wrong${R}
  Bot offline?           docker compose logs bot
  Commands missing?      cd bot && deno task sync-commands
  Can't log in?          check OAuth2 → Redirects matches DISCORD_REDIRECT_URI
  "Missing Access"?      re-invite with the link above

${DIM}Read SETUP.md for what's deliberately not automated, and SELF_HOSTING.md
for how self mode differs from the hosted deployment.${R}

EOF
