# DNS

One zone file, for the one DNS change that is not obvious.

| File | Is |
|---|---|
| `creeperdiamonds.xyz.zone` | The eight apex records the Cloud Run domain mapping needs, in BIND format for Cloudflare's importer |

## Why a file rather than eight clicks

Because the eight records are not the hard part. The hard part is everything
around them, and a file is somewhere to write that down:

- The apex was on **registrar parking**, and Cloudflare's importer only adds.
  Import without deleting the six parking A records first and the apex has
  ten, resolving to the parking host for some visitors and Cloud Run for
  others. That is worse than the outright failure it replaced, because it
  works often enough to look fine.
- The zone already carries **Cloudflare Email Routing** (`route1/2/3.mx.
  cloudflare.net`) and the TXT records behind it. `contact@creeperdiamonds.xyz`
  is published on the apex page and on `site/privacy.html` as the address for
  data-deletion requests. Clearing the apex without care takes mail with it.
- The records must be **DNS-only**, not proxied. Proxying them puts
  Cloudflare's certificate in front of Google's issuance check, and the
  mapping sits at `CertificateProvisioned: Unknown` indefinitely with nothing
  saying why.

## Importing

Cloudflare dashboard → **DNS** → **Records** → **Import and Export** →
**Import DNS records**. Upload the file, and set proxy status to **DNS only**.

Then delete the parking records, which the import will not have touched.

## Verifying

```bash
nslookup creeperdiamonds.xyz          # expect only 216.239.x.x
gcloud beta run domain-mappings describe --domain=creeperdiamonds.xyz \
  --region=us-central1 --project=yahav-project-505809
```

`CertificateProvisioned` moves from `Unknown` to `True` roughly fifteen
minutes after the records propagate. HTTPS on the apex fails outright until
then rather than warning, which is normal during provisioning.

Once it answers, check *which* page it serves — a 200 alone does not prove
the `server_name` split works, only that something replied:

```bash
curl -s https://creeperdiamonds.xyz/ | grep -c "Minecraft"   # apex page -> 1
```

If that returns `0`, the request fell through to `default_server` and the
apex is serving the Appealy marketing site. See `web/nginx.conf`.

## What is not here

The `appealy` subdomain's `CNAME` to `ghs.googlehosted.com`, its mapping, the
MX records and the TXT records. All exist and all work. They are left out so
that importing this file cannot disturb them.
