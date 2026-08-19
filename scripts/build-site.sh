#!/bin/sh
# scripts/build-site.sh
#
# Assembles the public marketing site into one directory that can be dropped
# on any static host — Cloudflare Pages, Netlify, GitHub Pages, an nginx root.
#
# WHY THIS EXISTS
#
# site/ is not self-contained and never was. Its pages reference /brand/*.svg
# and /status/, which live at the repository root, not inside site/. In
# production that works because web/Dockerfile copies all three into one nginx
# root; in development it works because web/vite.config.ts serves each from its
# own directory. A static host handed site/ alone gets neither, and every logo,
# the favicon and the status page 404 — which is exactly the bug that already
# happened once when these were written as ../brand/ and only tested by opening
# the file from disk.
#
# So the layout the HTML assumes is built here, once, rather than reproduced by
# hand in each new place the site gets deployed.
#
# USAGE
#
#   sh scripts/build-site.sh [output-dir]     (default: dist-site)
#
# Cloudflare Pages: build command `sh scripts/build-site.sh`, output `dist-site`.
#
# DISCORD_CLIENT_ID is optional. When set, "Add to Discord" is wired up via a
# redirect; without it that link 404s, because a static host cannot serve the
# /api/invite endpoint the API normally provides. See site/index.html.

set -eu

OUT="${1:-dist-site}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

cd "$ROOT"

rm -rf "$OUT"
mkdir -p "$OUT"

# The pages themselves. README.md is documentation for whoever edits them, not
# something to publish.
cp site/*.html site/*.css "$OUT"/

# The marks, at the absolute path every page references.
mkdir -p "$OUT/brand"
cp brand/*.svg "$OUT/brand"/

# The status page, kept at its own path and independent of the app so it still
# answers when the app does not.
if [ -d status ]; then
  mkdir -p "$OUT/status"
  cp -r status/* "$OUT/status"/
fi

# Redirects, for hosts that read a _redirects file (Cloudflare Pages, Netlify).
{
  if [ -n "${DISCORD_CLIENT_ID:-}" ]; then
    # 268528662 is INVITE_PERMISSION_BITS in api/src/routes/auth.ts. Duplicated
    # rather than imported because this is a shell script assembling static
    # files with no access to the API's TypeScript — if that constant changes,
    # this line has to change with it.
    printf '%s\n' "/api/invite https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&scope=bot+applications.commands&permissions=268528662 302"
  fi
} > "$OUT/_redirects"

# An empty _redirects is noise in a deploy log; drop it rather than ship it.
[ -s "$OUT/_redirects" ] || rm -f "$OUT/_redirects"

echo "Built $OUT:"
echo "  pages    $(ls -1 "$OUT"/*.html 2>/dev/null | wc -l | tr -d ' ')"
echo "  brand    $(ls -1 "$OUT/brand" 2>/dev/null | wc -l | tr -d ' ')"
echo "  status   $([ -d "$OUT/status" ] && echo present || echo absent)"
if [ -f "$OUT/_redirects" ]; then
  echo "  invite   wired via _redirects"
else
  echo "  invite   NOT wired — set DISCORD_CLIENT_ID to make /api/invite work"
fi
