# landing/

One page for **creeperdiamonds.xyz**, the apex domain. It exists to say that
Appealy is up and to point at it.

This is deliberately *not* part of `site/`. That directory is the Appealy
marketing site and is served from the app's own deployment at
`appealy.creeperdiamonds.xyz`, under the same nginx that serves the console at
`/dashboard/` and the status page at `/status/`. The apex is a different host
with nothing on it, so a page there cannot reference `site/site.css` or
`/brand/icon.svg` — those paths resolve inside the Appealy deployment and
nowhere else.

Hence a single self-contained file: styles inline, the mark inline as SVG, the
favicon as a `data:` URI. No build step, no dependencies, nothing to 404.

## Deploying it

Any static host will do, because there is nothing to serve but one file.

**Cloudflare Pages / Netlify** — point a project at this repository, set the
build output directory to `landing` and leave the build command empty.

**GitHub Pages** — publish this directory, or copy `index.html` into whatever
branch Pages is configured to serve.

**Your own nginx** — copy `index.html` into the server root for the apex.

```nginx
server {
  server_name creeperdiamonds.xyz www.creeperdiamonds.xyz;
  root /var/www/creeperdiamonds;
  location / { try_files $uri $uri/ /index.html; }
}
```

## When the permanent domain arrives

Two things change, and it is worth doing both at once so they cannot drift:

1. **Here** — the three links in `index.html` and the `<code>` in the closing
   note, all pointing at `appealy.creeperdiamonds.xyz`.
2. **`site/`** — the absolute URLs in the `<head>` of each page: `canonical`,
   `og:url`, `og:image`, `twitter:image`, and the JSON-LD `url` fields. They
   are absolute because that is what those tags require, so they cannot be made
   relative and forgotten about.

```bash
grep -rl 'appealy\.creeperdiamonds\.xyz' site/ landing/ \
  | xargs sed -i 's|appealy\.creeperdiamonds\.xyz|<new-domain>|g'
```

A canonical URL naming a domain you do not control is worse than none at all —
it tells every crawler the real copy of the page lives somewhere else, and if
that domain is later registered by someone else, it keeps saying so. These
previously pointed at `appealy.gg`, which is not registered to this project.
