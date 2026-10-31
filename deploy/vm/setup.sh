#!/bin/bash
# deploy/vm/setup.sh
#
# Prepares the VM that runs the API and the bot. Set as the instance's startup
# script, so it runs on every boot and has to be safe to run again. See README.md
# in this folder for how the VM was created.
#
# The VM holds no data: Postgres is Cloud SQL and Redis is Upstash. If it is ever
# lost, create another one, let this run, and deploy.

set -euo pipefail

# An e2-micro has 1 GiB of memory, and the containers' limits add up to more than
# what's left after the OS. Swap is there so a rare spike is slow, not an OOM kill.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show=NAME --noheadings | grep -q '^/swapfile$' || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-appealy.conf
sysctl -q -p /etc/sysctl.d/90-appealy.conf

if ! command -v docker > /dev/null || ! docker compose version > /dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends docker.io docker-cli docker-compose
fi

# Memory is the tight resource here, and nothing uses these: VM Manager isn't set
# up, and nothing on this VM sends mail.
systemctl disable --now google-osconfig-agent exim4 > /dev/null 2>&1 || true

# live-restore: a Docker upgrade or daemon restart must not restart the bot.
# mtu: Google's network is 1460, and Docker's default of 1500 can hang TLS
# connections in a way that looks like the remote end is broken.
desired='{ "live-restore": true, "mtu": 1460 }'
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$desired" ]; then
  mkdir -p /etc/docker
  echo "$desired" > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker > /dev/null

# Security updates still install by themselves, but not these. Upgrading them is
# the one update that can touch running containers, so it's done by hand. See
# README.md.
cat > /etc/apt/apt.conf.d/51appealy-docker <<'EOF'
Unattended-Upgrade::Package-Blacklist { "docker.io"; "docker-compose"; "containerd"; "runc"; };
EOF

# Docker brings the containers back after a reboot, but in no fixed order. One that
# shares the network of `net` fails if it gets there before `net` does, and Docker
# doesn't try again, which left the bot down in testing. A failed start leaves an
# error behind and a container stopped on purpose has none, so this can't bring back
# a bot someone stopped.
for name in net cloudsql-proxy api bot; do
  if [ -n "$(docker inspect --format '{{.State.Error}}' "appealy-$name-1" 2>/dev/null)" ]; then
    docker start "appealy-$name-1" > /dev/null || echo "Could not start appealy-$name-1." >&2
  fi
done
