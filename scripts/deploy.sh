#!/bin/bash
# scripts/deploy.sh
#
# The rollout, run by .github/workflows/deploy-merged.yml once the images are
# pushed. The API and the bot go to the VM (deploy/vm/), and nginx to Cloud Run
# (deploy/service.yaml).
#
# There are two paths. A normal deploy replaces what's on the VM and then nginx.
# The other runs once, while Cloud Run still holds the bot, and moves it. That
# order matters, see move_to_vm below.

set -euo pipefail

service_args=(--region "$GCP_REGION" --project "$GCP_PROJECT_ID")
vm_args=("$VM_NAME" --zone "$VM_ZONE" --project "$GCP_PROJECT_ID" --tunnel-through-iap --ssh-key-expire-after=1h --quiet)

# A trailing slash would end up inside the sign-in redirect address, which has to
# match Discord's list exactly.
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"

# Goes to deploy/vm/deploy.sh on stdin, see there. Base64 so that no value can
# break a line, and stdin so that none appears in a command line or a log.
vm_env="$(mktemp)"
trap 'rm -f "$vm_env"' EXIT
for var in ARTIFACT_REGISTRY SHA CLOUDSQL_CONNECTION_NAME PUBLIC_ORIGIN \
  PADDLE_API_KEY PADDLE_WEBHOOK_SECRET PADDLE_ENV PADDLE_CHECKOUT_URL PADDLE_CLIENT_TOKEN \
  TOPGG_WEBHOOK_SECRET STATUS_HEARTBEAT_SECRET; do
  printf '%s=%s\n' "$var" "$(printf %s "${!var-}" | base64 -w0)" >> "$vm_env"
done

vm() {
  gcloud compute ssh "${vm_args[@]}" --command "sudo bash /opt/appealy/deploy.sh $1" < "$vm_env"
}

# One sudo, because sudo reads stdin on behalf of its command. A separate `sudo mkdir`
# could eat the start of the archive.
install_vm_files() {
  tar -C deploy/vm --exclude=.gitattributes -cz . \
    | gcloud compute ssh "${vm_args[@]}" --command "sudo sh -c 'mkdir -p /opt/appealy && tar -xz --no-same-owner -C /opt/appealy'"
}

deploy_web() {
  python3 scripts/render-service.py > rendered-service.yaml
  gcloud run services replace rendered-service.yaml "${service_args[@]}"

  # replace does not manage the invoker policy, and a service nobody may call is
  # not obviously different from one that is broken. Non-fatal on purpose. The
  # deploy account holds run.developer, which cannot set an IAM policy, and the
  # binding persists across revisions, so failing after the first application
  # means nothing.
  if ! gcloud run services add-iam-policy-binding appealy "${service_args[@]}" \
    --member=allUsers --role=roles/run.invoker --quiet 2>/dev/null; then
    echo "::warning::Could not set the public invoker binding, which is expected if it is already set."
  fi
}

# expect <status> <url>. Retries because a new revision's private link can take a
# while to come up (deploy/service.yaml), and nginx answers 502 until it has.
expect() {
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --retry 9 --retry-delay 10 "$2")"
  if [ "$got" != "$1" ]; then
    echo "::error::$2 answered $got, expected $1."
    return 1
  fi
  echo "$got $2"
}

# Includes a path that has to reach the API. A 200 on / only proves nginx started.
# 302 is the pass on /api/invite: it is a redirect to Discord built by the API.
check_site() {
  expect 200 "$1/" \
    && expect 200 "$1/dashboard/" \
    && expect 200 "$1/review/server-members" \
    && expect 302 "$1/api/invite"
}

service_json() {
  gcloud run services describe appealy "${service_args[@]}" --format=json
}

serving_revision() {
  service_json | python3 -c '
import json, sys
traffic = json.load(sys.stdin)["status"]["traffic"]
print(max(traffic, key=lambda t: t.get("percent", 0))["revisionName"])
'
}

# Creates the new nginx with no traffic and tests the whole path through its tag,
# so a bad one never serves anybody.
test_new_web() {
  local next_url
  PIN_TO_REVISION="$1" deploy_web
  next_url="$(service_json | python3 -c '
import json, sys
print(next(t["url"] for t in json.load(sys.stdin)["status"]["traffic"] if t.get("tag") == "next"))
')"
  echo "Testing the new revision, which has no traffic yet: $next_url"
  check_site "$next_url"
}

switch_to_new_web() {
  gcloud run services update-traffic appealy "${service_args[@]}" --to-revisions "$REVISION=100" --remove-tags next
}

# Getting this wrong starts a second bot, so a failed lookup stops the deploy rather
# than reading as "no bot here".
revision_holds_bot() {
  local names
  names="$(gcloud run revisions describe "$1" "${service_args[@]}" --format='value(spec.containers[].name)')" || exit 1
  [ -n "$names" ] || exit 1
  case ";$names;" in
    *";bot;"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Cloud Run logs this as it takes the old instance down, after its traffic has gone,
# and until then that bot is still connected to Discord. The log line comes with
# SIGTERM, and whatever is left gets SIGKILL 10 seconds later. The bot exits on
# SIGTERM, and in any case reading this log, SSH and starting the new bot take longer
# than those 10 seconds. The new bot can't connect before the old one has gone.
wait_for_instance_to_stop() {
  local filter="resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$1\" AND textPayload:\"Shutting down user disabled instance\" AND timestamp>=\"$2\""
  for _ in $(seq 1 60); do
    if [ -n "$(gcloud logging read "$filter" --project "$GCP_PROJECT_ID" --limit 1 --format='value(timestamp)')" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Succeeds if the VM answered and has no bot, whether or not it had one before. Tries
# more than once because the usual reason to be here is a connection that just failed.
remove_vm_bot() {
  for _ in 1 2 3; do
    if gcloud compute ssh "${vm_args[@]}" \
      --command 'sudo docker rm -f appealy-bot-1 2>/dev/null; ! sudo docker inspect appealy-bot-1 > /dev/null 2>&1'; then
      return 0
    fi
    sleep 10
  done
  return 1
}

# Two bots on one token handle every event twice, so the old one has to be gone
# before the new one starts. That leaves a few seconds with neither, which is
# the better side to be wrong on: a click in that gap fails visibly and can be
# repeated, where a double-handled event can't be undone. See the comment at the
# top of deploy/vm/compose.yaml.
#
# Everything up to moving the traffic changes nothing anyone can see, and a failure
# there leaves Cloud Run as it was.
move_to_vm() {
  local old="$1" since

  # wait_for_instance_to_stop needs this. Better to find out it's missing now than
  # after the traffic has moved.
  gcloud logging read 'resource.type="cloud_run_revision"' --project "$GCP_PROJECT_ID" --limit 1 > /dev/null

  vm api
  test_new_web "$old"

  if [ "$REHEARSE" = "true" ]; then
    echo "Rehearsal passed. Traffic and the bot have not moved."
    return 0
  fi

  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  switch_to_new_web

  if wait_for_instance_to_stop "$old" "$since" && vm bot && check_site "$PUBLIC_ORIGIN"; then
    echo "Moved. Going back is in deploy/vm/README.md; the old revision is $old."
    return 0
  fi

  # The old revision starts its bot as soon as it has traffic again, so if there may
  # still be one on the VM, the old one stays off. Having no bot can be fixed by hand.
  # Events handled twice can't be undone.
  echo "::error::The move failed."
  if ! remove_vm_bot; then
    echo "::error::Could not confirm that the VM has no bot, so the old bot stays off and traffic stays on $REVISION. Going back is in deploy/vm/README.md; the old revision is $old."
    return 1
  fi
  echo "The VM has no bot, so traffic and the bot are going back to $old."
  gcloud run services update-traffic appealy "${service_args[@]}" --to-revisions "$old=100"
  return 1
}

serving="$(serving_revision)"

if [ "$REHEARSE" = "true" ] && ! revision_holds_bot "$serving"; then
  echo "::error::A rehearsal is for moving the bot, and $serving doesn't hold it."
  exit 1
fi

install_vm_files
vm pull

if revision_holds_bot "$serving"; then
  move_to_vm "$serving"
else
  vm api
  vm bot
  test_new_web "$serving"
  switch_to_new_web
  check_site "$PUBLIC_ORIGIN"
fi
