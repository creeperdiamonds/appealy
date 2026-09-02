# DNS

One zone file, for one record — and a constraint worth writing down so nobody
undoes it later.

| File | Is |
|---|---|
| `creeperdiamonds.xyz.zone` | The single `www` CNAME the personal site needs, in BIND format for Cloudflare's importer |

## The apex belongs to Minecraft

`creeperdiamonds.xyz` is a Minecraft server address and was one first:

```
creeperdiamonds.xyz   CNAME  a9ed93c7-…-shield.neoprotect.ovh
_minecraft._tcp       SRV    0 5 25565 a9ed93c7-…-shield.neoprotect.ovh
```

Port 25565 answers on it. DNS resolves a name to one set of addresses and
Cloud Run's do not speak Minecraft, so the apex can be the server or the
website, never both. The website took `www` and the apex was left untouched —
nothing about the server changed, and no SRV edit was needed.

**If you are ever tempted to move the site to the apex**, understand what
breaks. Java clients look up `_minecraft._tcp` first, so players typing the
bare domain would still connect. Players who saved `creeperdiamonds.xyz:25565`
with the port skip SRV entirely, and Bedrock ignores SRV altogether. Both
would break silently, and you would hear about it from players rather than
from a monitor.

`web/nginx.conf` lists both names in `server_name` regardless. The bare one
costs nothing while its DNS points at NeoProtect, and it means a future move
needs no second discovery of this file.

## Adding the record

Cloudflare → **DNS** → **Records** → **Add record**:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `www` |
| Target | `ghs.googlehosted.com` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

Same shape and same settings as the `appealy` CNAME already in the zone —
copy that row if in doubt.

**DNS-only is the one that fails silently.** Proxied, Cloudflare's certificate
sits in front of Google's issuance check and the mapping stays at
`CertificateProvisioned: Unknown` indefinitely with no error explaining why.

Nothing needs deleting. The zone's MX records, TXT records, the `appealy`
CNAME and the apex CNAME all stay exactly as they are.

## Verifying

```bash
nslookup -type=CNAME www.creeperdiamonds.xyz     # -> ghs.googlehosted.com
gcloud beta run domain-mappings describe --domain=www.creeperdiamonds.xyz \
  --region=us-central1 --project=yahav-project-505809
```

`CertificateProvisioned` moves from `Unknown` to `True` roughly fifteen
minutes after the record propagates. HTTPS fails outright until then rather
than warning, which is normal during provisioning.

Then check *which* page it serves — a 200 alone only proves something
replied, not that the `server_name` split worked. A fall-through to
`default_server` returns a perfectly healthy 200 of the Appealy marketing
site:

```bash
curl -s https://www.creeperdiamonds.xyz/ | grep -c "Minecraft"   # personal page -> 1
```

And confirm the server is untouched, which is the whole point of this layout:

```bash
nslookup -type=SRV _minecraft._tcp.creeperdiamonds.xyz
```
