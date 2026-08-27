# home/

One page for **creeperdiamonds.xyz**, the apex domain. It is creeperdiamonds'
personal site: a handle, a short line on what they build, Appealy as the one
worked example, an about paragraph, and contact.

This is deliberately *not* part of `site/`. That directory is the Appealy
marketing site and is served from the app's own deployment at
`appealy.creeperdiamonds.xyz`, under the same nginx that serves the console at
`/dashboard/` and the status page at `/status/`. The apex is a different host
with nothing else on it, so a page there cannot reference `site/site.css` or
`/brand/icon.svg` — those paths resolve inside the Appealy deployment and
nowhere else.

Hence a single self-contained file: styles inline, the mark inline as SVG, the
favicon as a `data:` URI. No build step, no dependencies, nothing to 404. A
personal site is also the artifact most likely to move hosts later — off
whatever serves it today, onto GitHub Pages or somewhere else entirely — so
keeping it dependency-free now means that move is a file copy, not a rewrite.

This replaces `landing/index.html`, which was a signpost ("Appealy is up")
for a domain that, until now, served nothing. That file's palette, its
inline mark, and its self-contained approach all carry over here unchanged;
only the content and structure are new.

## Serving it

`web/Dockerfile:83` copies this directory to `/usr/share/nginx/html/home`,
and the `server` block at `web/nginx.conf:181` serves it on the apex `Host`
only — `creeperdiamonds.xyz`, not `appealy.creeperdiamonds.xyz`. It does not
run anywhere else. See those two files for the actual configuration rather
than a copy here that can drift from it.

`www.creeperdiamonds.xyz` is **not** handled by that block — its
`server_name` is `creeperdiamonds.xyz` alone, so a request for the `www` host
falls through to the main server's `default_server` and gets the Appealy
marketing site instead of this page. Serving `www` from here would need both
a `server_name` entry for it and its own Cloud Run domain mapping.

## The About paragraph is not written yet

`index.html` marks it with an `AUTHOR:` comment on purpose:

```html
<!-- AUTHOR: replace this paragraph before deploying. Nothing here
     should claim anything about you that you did not write. -->
<p class="placeholder">[About text goes here.]</p>
```

That paragraph is the author's to write, not this plan's — a biography
invented here would put words in creeperdiamonds' mouth on their own
personal site. `grep -n "AUTHOR:" home/index.html` is a hard gate before the
domain goes live: it must return no hits. Do not remove the marker until real
text replaces the placeholder.

## When links change

If Appealy moves off `appealy.creeperdiamonds.xyz` to a permanent domain, the
links in the Appealy section here need to move with it:

```bash
grep -rl 'appealy\.creeperdiamonds\.xyz' home/ site/ \
  | xargs sed -i 's|appealy\.creeperdiamonds\.xyz|<new-domain>|g'
```
