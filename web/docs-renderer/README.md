# Docs renderer

Turns the `docs` branch into the pages served at **https://docs.appealy.app**.

The documentation is its own branch: Markdown only — `README.md`, `SUMMARY.md`
and a folder per section — with no app code beside it, so it reads properly on
GitHub and can be edited and reviewed on its own. This directory is the only
place that knows how it becomes a website.

## How it gets built

1. The deploy (`.github/workflows/deploy-merged.yml`) checks out the `docs`
   branch into `docs-content/`.
2. `web/Dockerfile` has a `docs` stage that runs `render.mjs` over it and copies
   the output into the nginx image at `docs-site/`.
3. `web/nginx.conf` serves that directory on `docs.appealy.app`.

**Pushing to `docs` publishes nothing by itself.** The pages are built into the
image, so a docs change goes live on the next deploy.

## URLs follow the files

| File on the `docs` branch | URL |
|---|---|
| `README.md` | `/` |
| `getting-started/README.md` | `/getting-started/` |
| `getting-started/ban-appeals.md` | `/getting-started/ban-appeals` |

Write links between pages as relative `.md` paths — that is what works on
GitHub — and the renderer rewrites them to these URLs. `SUMMARY.md`'s links, in
order, are the navigation. Every page is linked from it; a page that isn't
still renders, but nothing leads to it.

A quote block (`>`) renders as the site's callout box, and tables scroll inside
their own box on narrow screens.

## Building it locally

```bash
git worktree add docs-content docs        # from the repository root
cd web/docs-renderer
npm ci
npm run render                            # writes dist/
```

`docs-content/` and `dist/` are gitignored. A web image built without
`docs-content/` gets a single placeholder page instead of failing; the deploy
passes `REQUIRE_DOCS=1`, which turns that into a build failure.

## Two things the documentation must not drift from

**The pages restate constants, and nothing checks them.** The appeal numbers on
`getting-started/ban-appeals.md` — three attempts, five, thirty days, a hundred
and eighty, two apologies — are read out of `APPEAL_RULES` in
`shared/schema/platformBans.ts`, and the twenty-character denial note is
enforced in `api/src/routes/opsAppeals.ts`. The command table on
`getting-started/README.md` is the seventeen files in `bot/src/commands/`.
**Change a constant, change the page in the same change** — a published promise
the code does not keep is worse than no page.

**Only one kind of markdown is published.** `APPEALS.md`, `OUTCOMES.md` and
`SELF_HOSTING.md` argue a design to whoever is *running* the thing and belong in
the docs. `SCALING.md`, `STARTUP.md`, `DOCKER.md`, `SETUP.md`, `PI.md` and
`POC.md` are notes to whoever is *changing* it; the docs home names them and
links them on GitHub, but does not present internal notes as documentation.
