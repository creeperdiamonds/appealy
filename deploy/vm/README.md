# The VM

`appealy-vm` runs the bot, the API and the Cloud SQL proxy. nginx, the domains and
their certificates stay on Cloud Run, and `deploy/service.yaml` says why. The VM
holds no data: Postgres is Cloud SQL and Redis is Upstash.

| File | What it is |
|---|---|
| `compose.yaml` | The containers and their settings |
| `deploy.sh` | Runs on the VM during a deploy |
| `setup.sh` | The VM's startup script: Docker, swap and memory settings |

## Deploying

The same as ever. The workflow and `scripts/deploy.sh` do the rest.

```bash
gh workflow run deploy-merged.yml --ref main -f migrations=skip
```

A deploy takes the dashboard's requests away for about 6 seconds while the API
restarts, and nginx answers them with "not answering right now". The bot is stopped
before the new one starts, because two bots on one token would handle every event
twice, so there are a few seconds when clicks in Discord fail. The website, docs and
review pages don't notice.

## Looking at it

```bash
gcloud compute ssh appealy-vm --zone us-central1-c --project yahav-project-505809 --tunnel-through-iap
sudo docker ps
sudo docker stats --no-stream
free -m
```

SSH only works through IAP, and port 22 is closed to everyone else. Logs go to Cloud
Logging, or use `sudo docker logs appealy-bot-1` on the VM:

```bash
gcloud logging read 'logName="projects/yahav-project-505809/logs/gcplogs-docker-driver" AND jsonPayload.container.name="/appealy-bot-1"' \
  --project yahav-project-505809 --limit 50 --format='value(timestamp,jsonPayload.message)'
```

## Going back to Cloud Run

The revision from before the move still holds the bot and the API. **Stop this bot
first**, or two bots run at once. Removing the container, not just stopping it, means
nothing can bring it back.

```bash
gcloud compute ssh appealy-vm --zone us-central1-c --project yahav-project-505809 --tunnel-through-iap \
  --command 'sudo docker rm -f appealy-bot-1'
gcloud run services update-traffic appealy --region us-central1 --project yahav-project-505809 \
  --to-revisions=appealy-00117-x2q=100
```

This stops working when the Artifact Registry cleanup rule removes that revision's
images, which happens after about 10 more builds and 30 days.

## If it needs more room

Move up when available memory in `free -m` stays under about 150 MiB, or when the
bot's busiest minutes regularly use more than about 0.2 vCPU. An e2-small has twice
the memory and CPU, costs about $12 a month, and the bot is offline for about a
minute while it restarts:

```bash
gcloud compute instances stop appealy-vm --zone us-central1-c --project yahav-project-505809
gcloud compute instances set-machine-type appealy-vm --machine-type e2-small --zone us-central1-c --project yahav-project-505809
gcloud compute instances start appealy-vm --zone us-central1-c --project yahav-project-505809
```

## Keeping it patched

Security updates install by themselves, except Docker's, and nothing reboots by
itself. About once a month, on the VM, at a quiet time (19:00-21:00 UTC is the busiest):

```bash
sudo apt-get update && sudo apt-get upgrade -y && sudo reboot
```

The containers start by themselves, and the bot is back about a minute later.

## If the VM is lost

Create it again, wait a few minutes for `setup.sh` to finish, and deploy. Nothing on
it needs restoring.

```bash
gcloud compute instances create appealy-vm --project yahav-project-505809 --zone us-central1-c \
  --machine-type e2-micro --image-family debian-13 --image-project debian-cloud \
  --boot-disk-size 20GB --boot-disk-type pd-standard \
  --service-account appealy-runtime@yahav-project-505809.iam.gserviceaccount.com --scopes cloud-platform \
  --private-network-ip appealy-vm-internal --tags appealy-vm \
  --metadata enable-oslogin=TRUE --metadata-from-file startup-script=deploy/vm/setup.sh \
  --maintenance-policy MIGRATE --restart-on-failure --deletion-protection \
  --labels project=appealy,purpose=bot --shielded-vtpm --shielded-integrity-monitoring
```

The deploy account also needs these on the new VM. It must be in `us-central1`,
because that's where e2-micro falls within the free tier and where the fixed private
address `10.128.0.10` is reserved.

```bash
gcloud compute instances add-iam-policy-binding appealy-vm --zone us-central1-c --project yahav-project-505809 \
  --member serviceAccount:github-deployer@yahav-project-505809.iam.gserviceaccount.com --role roles/compute.osAdminLogin
```
