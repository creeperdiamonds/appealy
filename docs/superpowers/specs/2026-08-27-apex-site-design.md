# The apex site, and a front door for Tebex

**Date:** 2026-08-27
**Status:** design, awaiting review

---

## Why this document exists

`creeperdiamonds.xyz` serves nothing. `curl` returns `000` — no connection at
all. The only Cloud Run domain mapping in the project is
`appealy.creeperdiamonds.xyz` → the `appealy` service.

There is already a page written for that apex — `landing/index.html`, 8.5KB,
fully self-contained, titled *"creeperdiamonds — Appealy is up"*. It was
built to drop onto any static host and never deployed to one.

Two things follow from that, and they are the whole of this document.

**The apex should be a personal site, not a signpost.** One project, presented
as the worked example of what its author builds, plus who they are and how to
reach them. A project grid holding a single card advertises the single card.

**The Tebex reviewer note is on the wrong page.** `landing/index.html:165`
reads *"Reviewing this domain for Tebex? You want appealy.creeperdiamonds.xyz,
not this page"* — correct, and currently reachable by nobody, because the page
it lives on is not served. Meanwhile Appealy itself, the site a reviewer is
actually sent to, has no reviewer entry point at all.

---

## Goal

`creeperdiamonds.xyz` serves a personal site with Appealy on it, and a Tebex
reviewer landing anywhere in the estate reaches everything a review needs in
one hop.

## Non-goals

- **A second Cloud Run service.** One service already serves static files
  through nginx; a second one is another image, another deploy path and
  another thing to forget to update.
- **A CMS, a build step, or a framework.** `site/` is static HTML with no
  JavaScript for a reason its own header gives: a marketing page that renders
  blank while a bundle downloads is a marketing page that loses the visitor.
  The apex has less to say than the marketing site and needs less machinery.
- **A project grid.** Revisit when there is a second project.
- **Personal identifying detail beyond what was asked for.** Handle, a contact
  alias, and GitHub. No real name, no biography invented on the author's
  behalf.

---

## 1. Routing

This is the part that touches production, so it comes first.

`web/nginx.conf` is an envsubst template (`/etc/nginx/templates/`), with
`${PORT}`, `${API_ORIGIN}` and `${DNS_RESOLVER}` substituted at container
start. It contains **one** `server` block, and that block has **no
`server_name`** — so it answers on every Host the container receives:
`appealy.creeperdiamonds.xyz`, the `run.app` URL, and Cloud Run's own health
probe.

Adding a second block for the apex therefore has a trap. In nginx, when no
`server_name` matches, the request goes to the block marked `default_server`
— and if none is marked, to the **first block in the file**. Adding an apex
block above the existing one, or adding `server_name` to the existing one
without a default, silently changes which block answers the `run.app` URL and
the health probe.

**Design:**

```nginx
# The existing block, unchanged except for this line. default_server is
# load-bearing: it keeps every Host that is NOT the apex — the Appealy
# subdomain, the run.app URL, and Cloud Run's health probe, which arrives
# with no Host worth matching — answering exactly as it does today.
server {
  listen ${PORT} default_server;
  root /usr/share/nginx/html;
  ...
}

# The apex. Static only: no /api/ or /auth/ proxying, no /dashboard/. A
# personal page has no reason to reach the API, and not proxying it means a
# misconfigured apex cannot become a second, unintended door to the console.
server {
  listen ${PORT};
  server_name creeperdiamonds.xyz;
  root /usr/share/nginx/html/home;
  index index.html;
  # Same security headers as the main block. Copied rather than shared
  # because nginx has no include-with-scope here and an `include` file would
  # split a twelve-line policy across two files to save nine lines.
}
```

**Verification before deploy** is not optional for this change. `/dashboard/`,
`/api/`, `/auth/` and `/status` must still resolve on the Appealy subdomain
and on the `run.app` URL after the edit. A broken `default_server` takes down
the live dashboard, and it fails in the way that is hardest to notice: the
apex works, so the change looks successful.

## 2. The domain mapping

One new Cloud Run domain mapping, `creeperdiamonds.xyz` → the `appealy`
service, in `us-central1` alongside the existing subdomain mapping.

An apex cannot use a CNAME, so this needs **A and AAAA records** rather than
the CNAME the subdomain uses. Google issues the record values when the mapping
is created; Cloudflare holds the zone. The certificate is Google-managed and
takes up to roughly fifteen minutes to go live after DNS propagates, the same
as the subdomain did.

**This is the one manual step.** `deploy-merged.yml` deploys the service; it
does not create domain mappings, and it should not — a mapping is created once
and a deploy runs many times.

## 3. The site

`home/index.html`, one page, no JavaScript, no build step.

**Built from `landing/index.html`**, which already exists, already carries the
console palette copied from `web/src/index.css`, and is already self-contained.

**It stays self-contained**, and that is a deliberate re-affirmation rather
than an oversight. `landing/README.md` argued for inlining the styles and the
mark so the page drops onto any host unchanged. Serving it from the same nginx
root now makes `/brand/icon.svg` resolvable — but a personal site is precisely
the artifact most likely to move to GitHub Pages one day, and the duplication
being avoided is one small SVG. The original reasoning still holds.

**Structure**, in order:

1. **What this is** — the author's handle and one line on what they build.
2. **Appealy** — the worked example. What it does, who it is for, and links to
   the site, the dashboard and the source. Its own support Discord belongs
   here, because that link is the product's rather than the author's.
3. **About** — a short paragraph. Written by the author, not invented here;
   the spec supplies structure and the page ships with the author's words.
4. **Contact** — `contact@creeperdiamonds.xyz` and `github.com/creeperdiamonds`.

**`contact@` must be routed before this ships.** Only `real@creeperdiamonds.xyz`
is confirmed to receive mail, and that address is deliberately not published.
A contact address that bounces is worse than no contact address, because the
sender believes they have reached someone.

## 4. Tebex, both directions

A reviewer needs five things: what is sold, what it costs, the terms, the
privacy policy, and how refunds work. Today those are spread across four pages
and a reviewer has to assemble them.

**On Appealy — a dedicated page, `site/tebex.html`.** One page collecting all
five with direct links, stating plainly that Tebex is merchant of record, that
refunds are within 14 days and go through Tebex, that there are two annual
plans and a per-unit builder, and that the plans are **annual subscriptions**
with no consumables and no loot boxes.

An earlier draft of this section said "no subscriptions", which was false and
is corrected here rather than quietly edited. `api/src/services/tebexService.ts:108`
and `:122` create Tebex packages with `type: "subscription"` and a one-year
period; `api/src/routes/tebexWebhook.ts:133` handles `recurring-payment.ended`;
and `site/pricing.html` already states that paid plans are created as annual
subscriptions. Describing the billing model to a compliance reviewer as the
opposite of what the integration implements is the specific mistake this page
exists to prevent, so the error is recorded rather than erased.

All four existing pages — `site/index.html`, `site/pricing.html`,
`site/terms.html` and `site/privacy.html` — get the same small footer link:
*"Tebex reviewer? Start here."* All four, not just the landing page, because a
reviewer following a link from a Tebex submission form arrives wherever that
link pointed, which is as likely to be the pricing page as the front one.

The content is not new — it is written already, across `site/pricing.html`,
`site/terms.html` and `site/privacy.html`. This page assembles it and links
out rather than restating it, so there is one copy of each claim and no second
version to drift.

**On the apex — keep what is written.** `landing/index.html:165`'s note
carries over to `home/index.html` unchanged in substance: a reviewer who
starts at the apex is pointed to `appealy.creeperdiamonds.xyz/tebex`, now that
such a page exists.

## 5. Deployment

`web/Dockerfile` copies static roots at lines 76–80 — `site`, `brand`,
`status`, and the built dashboard. One line is added:

```dockerfile
COPY home /usr/share/nginx/html/home
```

Nothing else in the pipeline changes. `deploy-merged.yml` builds the web image
and replaces the service; the apex is served by the same container that is
already deployed on every release.

`scripts/build-site.sh` is **not** extended to the apex. It exists to assemble
`site/` for a static host, and `home/` is self-contained by design — it needs
no assembly, and adding it would imply the two are deployed together when they
are not.

## Error handling

- **An unmatched Host** falls to `default_server`, which serves Appealy. That
  is the correct fallback: the `run.app` URL and the health probe both depend
  on it, and a stranger arriving on an unmapped hostname sees the product
  rather than an error.
- **`home/index.html` missing from the image** produces a 404 on the apex and
  leaves everything else working, because the roots are separate. It would
  survive a deploy unnoticed, which is why the Dockerfile line and the nginx
  block land in the same change.
- **The mapping created before DNS** leaves the apex unreachable until records
  propagate, with the Appealy subdomain unaffected throughout.

## Testing

There is nothing here a unit test reaches — it is static files and a routing
config. What replaces tests:

- **Local nginx check** before deploy: build the web image and confirm, with
  an explicit `Host:` header, that the apex Host serves `home/index.html`,
  that any other Host serves `site/index.html`, and that `/dashboard/`,
  `/api/`, `/auth/` and `/status` still resolve on the non-apex Host.
- **Post-deploy**, on the live service: the same four Appealy paths, then the
  apex once its certificate is live.
- **Link check** on `site/tebex.html`: every link it makes resolves. A
  reviewer following a 404 is the specific failure this page exists to
  prevent.

## Risks

- **The `default_server` change is the whole risk of this design.** Get it
  wrong and the live dashboard stops answering on its own domain, while the
  apex — the thing being added — works perfectly. The verification step above
  exists for this and should not be skipped because the change is three
  words long.
- **Portfolio uptime is now Appealy's uptime.** A bad deploy takes both down.
  Accepted deliberately: one service, no marginal cost, one pipeline. The
  alternative is a second Cloud Run service, which is the right answer only
  when the apex has traffic worth insulating.
- **`contact@` may not exist.** Publishing it before confirming routing sends
  every enquiry into a void with no bounce visible to the author.
- **`landing/` becomes dead code** once `home/` exists. It should be deleted
  in the same change, not left as a second apex page for someone to edit by
  mistake.

## Open questions

- **The About paragraph is the author's to write.** The page ships with
  structure and styling; the words are not invented here.
- **Whether the apex should link the dashboard at all.** Currently proposed
  yes, via Appealy's section. An argument exists for keeping the personal site
  entirely marketing-side and letting Appealy own its own login path.
