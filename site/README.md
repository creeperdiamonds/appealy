# Public site

Five pages, one stylesheet. No build step, no framework, no bundler, and no
JavaScript at all.

| File | Is |
|---|---|
| `index.html` | Landing page |
| `pricing.html` | Pricing in full, including the custom per-unit rates |
| `privacy.html` | What is stored, for how long, who sees it |
| `terms.html` | Hosted-service terms |
| `tebex.html` | Front door for a Tebex review — links to what is sold, what it costs, the terms, the privacy policy and refunds rather than restating them |
| `site.css` | Shared styles |

## Why it's static

Same reason `status/` is, plus one more.

**The console can't be the front door.** An unauthenticated visitor to the
dashboard gets the app shell, which 401s and bounces them to Discord OAuth.
Until this directory existed there was no way to find out what the product was
without signing into it, which is a strange thing to ask of someone deciding
whether to sign in.

**It has to survive the outage.** A marketing page that goes down with the API
is a marketing page that is missing at the exact moment someone is searching
for "is Appealy down".

**Search.** A Discord bot lives or dies on being findable. Server-rendered
markup with a real `<title>`, a description, Open Graph tags and JSON-LD costs
nothing here and is a fight with a client-side router anywhere else.

**It's five documents.** A framework would earn its place if there were state
to manage. There is none.

## Serving it

`site/` is the document root; `brand/` sits beside it at `/brand/`:

```
/            -> site/index.html
/pricing.html
/privacy.html
/terms.html
/tebex.html
/site.css
/brand/      -> brand/            (wordmark.svg, icon.svg, favicon.svg)
/dashboard   -> the console (web/)
/status/     -> status/index.html
```

**One thing to reconcile before launch.** Every "Open dashboard" link on this
site is `/dashboard`, same-origin. The bot's `/dashboard` slash command builds
its link from `DASHBOARD_BASE_URL`, which defaults to
`https://dashboard.appealy.app` (`bot/src/commands/dashboard.ts`) — a different
host. Whichever is right, make them agree: either serve the console at
`/dashboard` on this origin, or repoint all eleven of those links at the host
the bot already sends people to. Two front doors to the same console is how a support
ticket gets opened.

Every image reference is `../brand/…`. That resolves correctly both from disk
(`site/index.html` → `brand/`) and from a web root (browsers clamp `..` at `/`,
so `../brand/icon.svg` from `/pricing.html` is `/brand/icon.svg`). Don't
"fix" it to `/brand/…` — the relative form is what makes the pages openable
straight from a checkout, which is how you'll preview them.

## The one substitution before deploy

**Add to Discord** links point at `/api/invite`, a 302 the API serves from
`DISCORD_CLIENT_ID`. There is nothing to substitute at deploy: the site is
static and cannot know the client id, the API can, and a redirect is always
correct for whichever deployment is serving it.

If you host this site somewhere the API is not reachable at the same origin,
that link is the one thing that needs changing.

The permission bits in that URL are `268528662` — the sum of the nine
permissions in `INVITE_PERMISSIONS` (`api/src/routes/auth.ts`). **If that array
changes, change this number.** Nothing checks. An invite missing a permission
produces a feature that silently does nothing, which is the failure the
dashboard's whole invite flow exists to prevent.

The site's invite link has no `guild_id`, unlike the dashboard's — a visitor
here hasn't picked a server yet, so Discord should show them the picker.

## Changing it

**Numbers come from `shared/schema/pricing.ts`.** Every price, cap and ceiling
on `pricing.html` was read out of that file. Nothing generates the page, so if
you change a constant there, change it here in the same commit. A pricing page
that disagrees with the calculator is worse than no pricing page.

### One contradiction found while writing this, and how it was resolved

`CUSTOM_CAP_UNIT_PRICE_CENTS_PER_YEAR` in `pricing.ts` holds integer cents.
Three of its seven entries carry comments in dollars a hundred times larger
than the value beside them:

```ts
formsPerGuild: 12,      // $1/mo -> $12/yr flat, not per-day
panelsPerGuild: 12,
rolesPerRuleType: 6,    // $0.50/mo -> $6/yr
```

The other four agree with their comments (`submissionsPerDay: 12` → $0.12/yr),
so this reads as three comments written in dollars against constants stored in
cents rather than a deliberately different rate.

`pricing.html` states **what `quoteCustomCaps()` actually charges** — $0.12,
$0.12 and $0.06 a year — because a public price that the checkout won't honour
is the worse of the two errors. **If $12 and $6 were the intent, that is a bug
in `pricing.ts`, not in this page.** Fix the constants first, then the table.

**Colours come from `web/src/index.css`.** The tokens at the top of `site.css`
are copied verbatim so the page someone reads before signing up and the console
they land in afterwards are the same product. One addition: `--accent-text`, a
lightened blurple, because `--accent` on `--ink` is 4.09:1 and that's under AA
for body text. Fine on a button, not fine in a paragraph.

**Don't put a claim here that isn't true of the repository.** No user counts,
no testimonials, no "trusted by N servers". If you want a number, count
something that exists — the seventeen slash commands and the eight metered caps
on these pages are both real counts.

**Fonts are the only external request.** Space Grotesk and Inter, from Google
Fonts, matching the console. Everything else is local. Keep it that way.

## What was deliberately left out

- **A raster Open Graph image.** `brand/` ships SVG only, and `brand/README.md`
  says raster exports are generated rather than committed. The `og:image` tags
  point at `brand/icon.svg`; several social platforms won't render an SVG card.
  Generating a 1200×630 PNG and repointing those four tags is the single
  highest-value change left on this site.

  ```bash
  npx svgexport brand/icon.svg og.png 1200:630
  ```

- **Screenshots.** The dashboard exists, but a screenshot committed today is a
  screenshot that's wrong in a month and nothing will catch it.

- **A cookie banner.** There is one cookie, it's the session, and it's
  strictly necessary.

- **Uptime or user-count figures.** Nothing in this repository counts them.

## Checked before this shipped

- Every internal link resolves to a file in this directory or to a path the
  deployment actually serves (`/dashboard`, `/status/`).
- Every `src` and `href` to an asset resolves: `../brand/wordmark.svg`,
  `../brand/icon.svg`, `../brand/favicon.svg`, `site.css`.
- One `<h1>` per page. Landmarks are real elements (`header`, `nav`, `main`,
  `footer`), each `nav` labelled, skip link first in the tab order.
- Every `<img>` has an `alt`; the two decorative ones have `alt=""` because the
  wordmark beside them already carries the name.
- No duplicate `id` attributes; no unclosed tags.
- Layout reasoning at 360px (single column, tables scroll inside their own
  boxes, nothing fixed-width), 768px (two columns, three steps), 1440px (three
  and four columns, `.wrap` capped at 1120px).
