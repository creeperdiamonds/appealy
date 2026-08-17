# Running on a Raspberry Pi 4

Works well. A Pi 4 comfortably runs this for a few hundred guilds — the
bottleneck is disk, not CPU.

```bash
git clone https://github.com/creeperdiamonds/appealy.git
cd appealy
./setup.sh
```

`setup.sh` detects the Pi and applies `docker-compose.pi.yml` automatically.
Nothing else to do differently.

## Before you start

**Use the 64-bit OS.** In Raspberry Pi Imager choose *Raspberry Pi OS (64-bit)*.
Every image in this stack — Postgres, Redis, Deno, Node, nginx — publishes
`arm64` and not `armhf`, so on a 32-bit OS `docker pull` fails with "no
matching manifest", which reads like a network problem and sends people down
the wrong path for an hour. `setup.sh` checks `uname -m` and stops early.

**Boot from a USB SSD, not an SD card.** This is the difference between a
deployment that runs for years and one that corrupts itself in six months.
Postgres write volume is what kills SD cards, and it fails as corruption
rather than as a warning. A cheap SATA SSD in a USB 3.0 enclosure is enough.

If you must use an SD card, `docker-compose.pi.yml` turns on `wal_compression`
to reduce write volume, but that's mitigation, not a fix.

**Raise swap to 2GB if you have a 4GB Pi.** Raspberry Pi OS ships 100MB, and
the web bundle build needs more. Without it the build dies with a bare
`Killed` that never mentions memory.

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

## What the Pi override changes

**Log rotation — the important one.** Docker's default `json-file` driver has
no size limit. A steadily-logging bot fills the disk over weeks; when it
fills, Postgres stops accepting writes and the symptom looks like a database
bug. Every service is capped at 10MB × 3 files. If you take one thing from
this file, take this.

**Memory limits.** 2.7GB total across five services, leaving ~1.4GB for the OS
on a 4GB Pi. The point isn't to save memory — it's that a leak in one service
gets *that* service OOM-killed and restarted, instead of the kernel picking a
victim, which on a Pi is usually Postgres.

**Postgres tuned for small and slow.** `shared_buffers=256MB`,
`max_connections=50` (the pool is 10 per process across two processes, so 50
is generous, and each slot reserves memory whether used or not), and
`random_page_cost=1.1` so the planner stops assuming a spinning disk.

**Redis persistence off.** It holds rate-limit counters, cache invalidation,
and pending form answers — all reconstructible. Writing an RDB snapshot to an
SD card every few minutes buys nothing and costs write cycles.

## Expected numbers

| | |
|---|---|
| First build | 10–25 min (Deno cache + two npm builds) |
| Later starts | seconds |
| Idle memory | ~600–900MB across all five services |
| Idle CPU | low single digits |

The first build is slow because it compiles on the Pi. If you rebuild often,
build the images on a faster machine with `docker buildx build --platform
linux/arm64` and push them to a registry instead.

## Sharding on a Pi

Shard count is worked out at every startup from your guild count
(`GUILDS_PER_SHARD`, default 1000). Below 1000 guilds that's one shard, which
is correct — extra shards would cost memory and Discord session starts for no
benefit.

Set `MAX_SHARDS=4` on a Pi. Each shard is roughly 40–60MB of heap on top of
the base process, so the 768MB limit in `docker-compose.pi.yml` covers about
four comfortably. Past that, raise the limit or move off the Pi.

When you outgrow the count, the bot logs "Time to reshard" and you restart at
a convenient moment. It never reshards itself — that drops every connection
for ~30 seconds, and doing it automatically means it happens at whatever
moment a guild happens to join, plausibly mid-event.

## Running it 24/7

Docker's `restart: unless-stopped` handles crashes and reboots already. Two
things it doesn't handle:

**Power.** Undervoltage is the most common cause of mysterious Pi corruption.
Use the official 5V/3A supply, not a phone charger. Check with
`vcgencmd get_throttled` — anything other than `0x0` means power problems.

**Unattended upgrades restarting Docker mid-write.** Fine in practice with
Postgres, but if you want to be careful, pin reboots to a time you're awake.

## Also worth knowing

`docker-compose.yml` now binds Postgres to `127.0.0.1` rather than all
interfaces. The password in it is literally `appealy`, and a Pi on a home
network with a permissive firewall would otherwise have that reachable from
the LAN. Change the password before you ever publish that port.

If you expose the dashboard beyond your LAN, put it behind a reverse proxy
with TLS (Caddy is the least work on a Pi) and set `DISCORD_REDIRECT_URI` to
the public HTTPS URL — Discord will reject a plain-HTTP redirect on a
non-localhost host.
