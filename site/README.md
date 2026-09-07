# Public site

Seventeen pages, one stylesheet, one image, and two files for crawlers. No
build step, no framework, no bundler, and no JavaScript at all.

| File | Is |
|---|---|
| `index.html` | Landing page |
| `pricing.html` | Pricing in full, including the custom per-unit rates |
| `appy-alternative.html` | The one page targeting a query people type: "Appy alternative". Dated comparison table, migration steps, FAQPage schema |
| `privacy.html` | What is stored, for how long, who sees it |
| `terms.html` | Hosted-service terms |
| `tebex.html` | Front door for a Tebex review — links to what is sold, what it costs, the terms, the privacy policy and refunds rather than restating them |
| `site.css` | Shared styles |
| `robots.txt` | Allows everything, names the answer-engine crawlers explicitly, points at the sitemap |
| `discord-ban-appeal-bot.html` | | 
| `discord-ticket-bot.html` | |
| `discord-verification-bot.html` | The five query-targeted feature pages — see below |
| `discord-anti-raid-bot.html` | |
| `discord-giveaway-bot.html` | |
| `appeal-gg-alternative.html` | The second comparison page. Deliberately has no migration section — see below |
| `og.png` | The 1200×630 Open Graph card. The one committed raster; `brand/README.md` says why |
| `docs/` | Five documentation pages — see below |
| `sitemap.xml` | The ten canonical URLs, with no `lastmod` — see the comment in the file |

## The URLs are extensionless, and the sitemap has to match

Every page's `<link rel="canonical">` points at `/pricing`, not
`/pricing.html`, and both forms return 200 in production. So the sitemap lists
the extensionless form: listing the other would ask Google to index one URL
while every page's canonical names a different one.

If you change how the host maps URLs to files, `sitemap.xml` and the canonical
tags have to move together.

`/docs` is the one directory, and it resolves through the same `try_files`
chain in `web/nginx.conf` — `$uri` misses, `$uri.html` misses, `$uri/` hits the
directory and nginx serves its `index.html`. So the canonical is the bare
`/docs`, with no trailing slash and no `/index.html`, and the sitemap says the
same.

## `docs/` — the documentation section

| File | Is |
|---|---|
| `docs/index.html` | The hub. Four cards, plus an explicit list of what is *not* published and why |
| `docs/getting-started.html` | Invite, intents, command registration, first form, first panel, all seventeen commands |
| `docs/ban-appeals.html` | The two things called "appeal", and the rules the platform ban system holds itself to |
| `docs/outcomes.html` | "Accept, as X", and the two guards that stop it becoming a privilege-escalation path |
| `docs/self-hosting.html` | Running it yourself, including the SameSite mistake that silently breaks login |

**Assets are root-relative here** (`/site.css`, `/brand/…`), like every other
page on this site. The top-level pages link `site.css` relatively, which is the
one inconsistency left; both resolve identically from a web root, and only the
root-relative form resolves from a subdirectory. Preview these through the
container rather than by opening the file, which is where the extensionless
URLs come from anyway.

## The query-targeted pages

Six pages that exist for one reason: the site was discoverable for two things
while the product does nine. `index.html` itself carries the heading *"It is not
only an application bot"* and then lists tickets, verification, giveaways, polls,
role menus, welcomer and anti-raid — none of which had a page anyone could land
on.

Each one owns one query and links to the others. They are real pages about real
features, written from the commands and schema columns that back them; the
generator that produced them lists the file behind every section. **They are not
doorway pages**, and if one ever stops describing something the code does, it
should be deleted rather than softened.

### Two things about them that are easy to undo by accident

**`index.html` must not target "ban appeal bot".** It used to be titled *Discord
Application & Ban Appeal Bot*. Shipping `/discord-ban-appeal-bot` beside that put
two pages of one site in competition for one term, which is how both lose — so
home was retitled to own *application bot* broadly. If you retitle home, check
that page.

**The FAQ markup and the visible questions are the same text.** Google treats a
mismatch as a structured-data violation, and marking up an answer the visitor
cannot read is doing it for the crawler rather than the person. Edit both or
neither.

## `appeal-gg-alternative.html` has no migration section, and that is a finding

`appy-alternative.html` has one because Appy ships `/export_applications` and
`/import-appy` consumes the file the user hands over. **Appeal.gg has no data
export at all** — verified from inside a logged-in account, September 2026 — so
there is nothing for an importer to read, and Appealy does not scrape
competitors.

The page also states plainly, above the comparison table, that **Appealy does not
do mute or warn appeals.** Discord has no API for either, so Appeal.gg must track
those punishments in its own database and Appealy structurally cannot. No export
would change that. Burying it would be selling someone a switch that breaks half
of what they rely on.

### The repository has two kinds of markdown, and only one kind belongs here

`APPEALS.md`, `OUTCOMES.md` and `SELF_HOSTING.md` argue a design to whoever is
*running* the thing. `SCALING.md`, `STARTUP.md`, `DOCKER.md`, `SETUP.md`,
`PI.md`, `POC.md` and `CHANGES.md` are notes to whoever is *changing* it —
audits, port logs, checklists, a scaling report written against real line
numbers.

Only the first group is on the site. `docs/index.html` names the second group
in a table and links it at GitHub, so nothing is hidden; what it does not do is
present an internal audit as product documentation. **If you add a document to
the repository, decide which group it is in before deciding whether it gets a
page.**

### These pages restate constants, and nothing checks them

Same hazard as `pricing.html`. The appeal numbers on `docs/ban-appeals.html` —
three attempts, five, thirty days, a hundred and eighty, two apologies — are
read out of `APPEAL_RULES` in `shared/schema/platformBans.ts`, and the
twenty-character denial note is enforced in `api/src/routes/opsAppeals.ts`.
The command table on `docs/getting-started.html` is the seventeen files in
`bot/src/commands/`, with each description copied from its definition.

Nothing generates any of it. **Change a constant, change the page in the same
commit** — a published promise the code does not keep is worse than no page.

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

**It's a folder of documents.** A framework would earn its place if there were
state to manage. There is none.

## Serving it

`site/` is the document root; `brand/` sits beside it at `/brand/`:

```
/            -> site/index.html
/pricing.html
/privacy.html
/terms.html
/tebex.html
/appy-alternative.html
/discord-ban-appeal-bot.html
/discord-ticket-bot.html
/discord-verification-bot.html
/discord-anti-raid-bot.html
/discord-giveaway-bot.html
/appeal-gg-alternative.html
/og.png
/docs         -> site/docs/index.html   (via try_files $uri/)
/docs/getting-started.html
/docs/ban-appeals.html
/docs/outcomes.html
/docs/self-hosting.html
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

- ~~**A raster Open Graph image.**~~ **Done.** `site/og.png` is a composed
  1200×630 card and every page points at it, with `twitter:card` raised from
  `summary` to `summary_large_image` to match. It went from "highest-value change
  left" to first in the batch when the site owner mentioned that crawlers found
  Appealy through a Reddit reply: the traffic that exists arrives through links
  people click in a feed, and Reddit and Discord both render a card and neither
  renders SVG. Every share until now was a bare link.

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
