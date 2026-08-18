<p align="center">
  <img src="brand/wordmark.svg" alt="Appealy" width="360">
</p>

# Appealy

Discord application/form management bot with a web dashboard. Two processes
share one Postgres database and one schema definition:

- **`bot/`** — Discordeno v20 (Deno) gateway bot. Owns the live Discord
  connection: publishing panels, showing modals, posting review embeds,
  managing roles, sending DMs, running scheduled poll publish/close.
- **`api/`** — Express (Node) REST API. Stateless, horizontally scalable.
  Serves the dashboard: OAuth2 login, form/panel/poll CRUD, submission
  history, DM template editor, manager delegation.
- **`shared/`** — Drizzle ORM schema and TypeScript types imported by both.
  This is the single source of truth for the data model and wire format;
  never duplicate a type or table definition in `bot/` or `api/`.

**Stack:** TypeScript · Deno · Node · React · PostgreSQL · Redis · Drizzle ORM
· Docker · Terraform · Google Cloud Platform (Cloud Run, Cloud SQL,
Memorystore, Secret Manager, Artifact Registry) · GitHub Actions

## Deployment

Runs on **Google Cloud Platform** — Cloud Run for the API and dashboard,
Cloud SQL for Postgres, Memorystore for Redis, Secret Manager for
credentials, and Artifact Registry for images. Infrastructure is defined in
Terraform (`terraform/`) and deploys through GitHub Actions using Workload
Identity Federation, so no service account keys are stored anywhere.

It also runs anywhere Docker does — a VPS, a Raspberry Pi, or a laptop. See
`PI.md` and `SETUP.md`.

| Guide | For |
|---|---|
| `POC.md` | Two containers, no Redis, no cloud account — start here |
| `SETUP.md` | Full local setup and the manual steps |
| `terraform/README.md` | GCP infrastructure as code, with costs |
| `DOCKER.md` | Container and Cloud Run specifics |
| `PI.md` | Raspberry Pi |
| `SELF_HOSTING.md` | Running it for your own server |

## Quick start

```bash
git clone https://github.com/creeperdiamonds/appealy.git
cd appealy
./setup.sh
```

The script checks your tools, generates the secrets you shouldn't be typing by
hand, walks you through the Discord portal, starts the containers, runs the
migration, and registers slash commands. It's safe to re-run — it never
overwrites an existing `.env` and skips the migration if your database already
has tables.

`./setup.sh --check` verifies your tools and changes nothing.

Running on a Raspberry Pi? See `PI.md` — `setup.sh` detects it and tunes
itself, but there are two things to get right before you start.

Then read `SETUP.md` for what's deliberately left manual.

### Proving it works first

`POC.md` gets you running on two containers with no Redis and no cloud
account. Worth doing before touching GCP — deploying to the cloud first means
debugging the application and the infrastructure at the same time, without
knowing which one is broken.

### Deploying to GCP

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars    # set project_id
terraform init && terraform plan                # plan lists what gets billed
terraform apply
terraform output github_variables               # paste into repo settings
```

Then run the **Deploy to GCP Cloud Run** workflow from the Actions tab,
picking `api` or `web`.

Note on the bot specifically: a Discord gateway connection is a WebSocket that
must stay open continuously, which is the opposite of what Cloud Run is built
for. It needs `--min-instances=1 --no-cpu-throttling --max-instances=1` to
survive, and those flags bill CPU continuously for roughly the price of an
e2-micro VM. `DOCKER.md` covers why a small Compute Engine instance is the
better home for it.

## Why two processes talk over an internal HTTP bridge

Only the bot process holds a live Discord gateway/REST session. Some
dashboard actions (publish a panel message, force-publish a poll, list a
guild's channels/roles for a picker) require that session. Rather than give
the API its own bot token and duplicate Discord REST logic, the API calls a
small internal control server the bot exposes on a **private, unpublished**
port (`bot/src/core/controlServer.ts`, called from `api/src/services/botBridge.ts`
and `api/src/routes/guildResources.ts`), authenticated with a shared secret.
In `docker-compose.yml` this port is reachable only on the internal Docker
network — it is not the public API and must never be exposed to the internet.

## Why select-menu questions use a two-step flow

Discord Modals only support text input components; there is no native select
menu inside a modal. Forms with a `select`-type question therefore show an
ephemeral select-menu message first (`bot/src/interactions/selects/formSelectStep.ts`),
stash the choice in Redis keyed by `(userId, formId)` with a 15-minute TTL
(`bot/src/services/pendingAnswers.ts`), and open the modal for any remaining
text questions once all selects are answered. The modal submit handler merges
both answer sets before persisting.

## Feature notes

This project is an original implementation inspired by the publicly documented
feature set of comparable Discord application bots (panels, staff review,
role automation, gating, polls) — no third-party source or assets were used.
A few design decisions worth knowing:

- **`/apply <application_name>`** and panel buttons both route through
  `runApplicationFlow` (`bot/src/interactions/buttons/panelOpen.ts`) so
  gating and modal behavior can't drift between the two entry points.
- **Ping roles**: forms can configure roles to be pinged in the review
  channel when a new submission arrives (`forms.pingRoleIds`).
- **Denial-path roles** are split into `denyRemoveRoleIds` (stripped on
  denial) and `deniedGrantRoleIds` (added on denial, e.g. to tag a
  previously-denied user) — distinct from the accept-path grant/remove pair.
- **Action on leave**: `forms.leaveAction` auto-denies a pending submission
  if the applicant leaves the guild before review
  (`bot/src/events/guildMemberRemove.ts`), so the queue doesn't accumulate
  stale entries for people who are gone.
- **`/export_applications`** streams matching submissions to CSV as a
  Discord file attachment.
- **`/poll`** creates and immediately publishes a poll (channel, question,
  up to 9 options, optional multiselect) as a fast path alongside the
  dashboard's schedule-for-later flow in `services/pollService.ts`.
- **Panel display type**: panels can show attached forms as buttons
  (capped at 5 per panel) or a dropdown select (up to 25) — both available
  to every guild regardless of billing tier; see "Pricing model" below for
  what's actually metered.
- **Manager delegation** (fine-grained review/manage access without full
  Discord Administrator) is likewise available to every guild — not a
  paid feature.

## Pricing model: open source, pay for throughput and/or dedicated hosting

The bot's source is open — anyone can self-host it for free, no license
key, no feature gate. Two **independent, additive** billing axes exist on
top of that for people who'd rather not run their own infrastructure or who
outgrow the free throughput caps. Neither axis unlocks features; every
feature described in this README is available at every tier.

**Billing is annual-only — there is no monthly option, anywhere, by
design.** Standard card-processing fees run roughly 2.9% + $0.30 per
transaction. At the price points here (a few dollars up to ~$15/mo
equivalent), that flat $0.30-per-charge component would eat a large,
disproportionate share of revenue if billed monthly — twelve small monthly
charges pay that $0.30-plus-percentage fee twelve separate times for the
same total revenue one annual charge would collect once. Concretely: a
hypothetical $5/mo tier billed monthly loses roughly 9% of revenue to fees
across a year; the same tier billed as one $60/year charge loses roughly
3%. It gets worse at smaller amounts — a hypothetical $0.83/mo charge
(the monthly-equivalent framing of the $10/year hosting fee) would lose
over a third of its value to the flat fee alone if it were ever actually
billed that way, which is exactly why it isn't. So every paid option
collects one annual charge, and the dashboard always shows both the annual
price and a computed (never hardcoded) monthly-equivalent figure purely
for comparison, never as an actual billing cadence.

**Axis A — Throughput.** Every guild gets a free daily/standing cap on
submissions, tickets, giveaway entries, dashboard API requests, forms per
guild, panels per guild, roles per rule-type, and history retention. Two
preset tiers raise those caps at a fixed annual price; a **custom** option
lets a guild admin set its own numbers directly on the dashboard, priced
live with a simple per-unit formula so the price is visible before ever
reaching checkout — never a "contact us" step. Selections that total less
than `MINIMUM_CHARGE_CENTS` ($5) are refused at checkout rather than
billed — a charge that small isn't worth firing on its own; a production
implementation should roll it into the next renewal instead of skipping it
silently. Every cap, including custom, has a hard ceiling
(`CUSTOM_CAP_MAXIMUMS` in `shared/schema/pricing.ts`) — there is no
unlimited tier anywhere in this system, by design, so worst-case cost is
always bounded.

**Axis B — Hosting.** Self-hosting (cloning this repo and running it
yourself) is always free. Paying for **custom hosting** means we run a
dedicated instance of this same bot for you under your own bot token —
priced near cost, cheaper than provisioning it yourself on a generic
hosting provider, and completely unrelated to Axis A: a guild can be on
free throughput with custom hosting, or a paid throughput tier on shared
hosting, in any combination. $10/year — see
`CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR` in `shared/schema/pricing.ts`.

The two axes are strictly additive: no bundle or multi-axis discount
exists, and none is planned — each axis is priced and charged on its own.

All money in this codebase is **integer cents**, never floats — floating-
point cents arithmetic accumulates rounding error across many transactions
in ways that are individually invisible and collectively a real bug.

All pricing logic lives in `shared/schema/pricing.ts` as a pure function
with no side effects, so the dashboard (for live pre-checkout quoting),
the API (`api/src/routes/billing.ts`), and the bot's enforcement
(`bot/src/services/rateLimitService.ts`) can never disagree about a price
or a cap.

### Payment: Tebex, with a strict quote → checkout → webhook separation

Tebex is the **merchant of record**: it sells to the customer, collects the
money, and owns sales-tax and VAT registration and remittance in the
jurisdictions it sells into. Taking cards directly would mean being the
merchant — which starts with handing a processor a taxpayer identification
number (an SSN or ITIN for an individual, an EIN for a company) and continues
with owning tax registration wherever customers are.

`POST /billing/checkout` creates a Tebex checkout for a computed, non-catalog
annual amount. The Checkout API takes items with an **inline package** carrying
a `name` and a `price` chosen at request time, which is what makes it workable
for the custom-caps tier. Earlier revisions of this document claimed the
opposite — that Tebex could not price anything without pre-created SKUs — and
that is no longer true; nothing about the pricing model had to change to move,
because `shared/schema/pricing.ts` still computes the number and the service
still just hands it over. The chosen plan travels in the basket's `custom`
object.

Items are created as annual **subscriptions**, so Tebex emits the recurring
lifecycle events. That is how a plan now ends when a customer stops paying —
the previous integration handled only the first payment, so a plan bought once
never lapsed.

The guild's plan is changed in exactly one place:
`api/src/services/billingService.ts::applyPlanChange`, called only from
`api/src/routes/tebexWebhook.ts` after Tebex confirms payment succeeded.
That webhook handler does three things worth knowing if you're auditing
or extending it:

1. **Verifies the signature** against the raw request body (mounted
   before `express.json()` for exactly this reason — a re-serialized body
   won't match the signature computed over the original bytes — Tebex's own
   docs call out Express by name for this).
2. **Re-derives the plan from the session's server-set metadata**, never
   from anything a client sends to the webhook directly.
3. **Recalculates what the plan should cost and compares it to what Tebex
   says was actually paid before applying anything** — currency included,
   since 60 of the wrong unit is not the price. This is Tebex's own webhook
   documentation's warning: a signature proves the message came from the
   payment provider, not that its contents match what you intended to charge
   for. A mismatch is logged and the plan change is refused rather than
   applied at the wrong price.
4. **Ends plans that end.** `recurring-payment.ended` and `payment.refunded`
   return the guild to the free selection. The subscription is matched back to
   its guild through `guilds.tebex_recurring_reference`, recorded when the
   first payment was applied, because the lifecycle events identify themselves
   by that reference and do not carry the basket's custom data.

Downgrading to the fully-free selection is the one plan change that
bypasses checkout entirely (`PUT /billing/downgrade-to-free`) since it
never involves a payment to confirm.

## New subsystems: tickets, giveaways, verification, welcomer, role menus, anti-raid, staff utilities

Same original-implementation approach as the applications/panels/polls core —
independently built, informed by publicly documented behavior in this
category of bot, no third-party source or assets used.

- **Tickets** (`ticketConfigs`/`tickets` tables, `bot/src/services/ticketService.ts`):
  staff choose per ticket-type whether opened tickets become a **private
  channel**, a **private thread**, or a **public thread**
  (`ticketConfigs.channelType`) — your requested per-config choice rather
  than a single hardcoded mode. Includes claim/close buttons, an optional
  transcript posted to a configured channel on close, and the same
  `leaveAction` pattern used for applications (`none` / `close` /
  `notify`) when the ticket opener leaves the guild.
- **Giveaways** (`giveaways`/`giveawayEntries`, `bot/src/services/giveawayService.ts`):
  button-based entry (not reactions), role gating identical in shape to
  form gating, optional bonus-entry weighting per role, scheduled auto-end
  via the existing scheduler, and reroll support that excludes prior
  winners.
- **Verification** (`verificationConfigs`, `bot/src/interactions/buttons/verify.ts`):
  either a single-button instant grant or a retype-the-code text challenge
  (`method: "captcha"`) — a real image CAPTCHA would need an external
  rendering service, so this uses a short random alphanumeric code shown
  in the ephemeral response and confirmed via modal, which still screens
  out naive auto-join bots. An optional `unverifiedRoleId` gate role can be
  applied on join and stripped on verify, with an optional auto-kick timer
  for members who never complete it.
- **Welcomer** (`welcomerConfigs`, `bot/src/events/guildMemberAdd.ts`):
  join channel message, optional join DM, optional auto-role grant, and an
  optional leave-channel message — one config row per guild since these
  are almost always configured together.

All four follow the same conventions as the core system: Drizzle schema in
`shared/schema/schema.ts`, DTOs in `shared/types/index.ts`, dashboard CRUD
under `api/src/routes/`, and any action requiring the live gateway session
(publishing a panel, ending a giveaway) proxied through the bot's internal
control server exactly like the existing panel/poll publish flow.

## Getting started

```bash
cp .env.example .env
# fill in Discord app credentials, generate TOKEN_ENCRYPTION_KEY and
# INTERNAL_RPC_SECRET with: openssl rand -hex 32

docker compose up -d postgres redis
cd api && npm install && npm run db:generate && npm run db:migrate
cd ..
docker compose up --build
```

Register a Discord application at https://discord.com/developers/applications,
enable the **Server Members Intent** and **Message Content Intent** under
Bot settings, and set the OAuth2 redirect URI to match `DISCORD_REDIRECT_URI`.

## Project layout

```
shared/
  schema/schema.ts    # Drizzle table definitions (source of truth)
  schema/gating.ts     # pure role/cooldown/limit gating engine
  types/index.ts        # DTOs, custom_id encode/decode, template interpolation

bot/src/
  core/                 # client bootstrap, env, scheduler, internal control server
  events/                # gateway event handlers, central interactionCreate router
  interactions/
    buttons/             # panel-open, review-accept, review-deny
    modals/               # form submit, deny-reason submit
    selects/               # select-question pre-step, poll vote
  commands/              # /panel, /forms, /dashboard slash commands
  services/               # DM templating, permission/hierarchy checks, poll rendering
  db/                     # Drizzle client

api/src/
  routes/                # auth, forms, panels, submissions, dm-templates, polls,
                          # staff-permissions, guild resource proxy
  middleware/            # session auth (with token refresh), guild access control
  services/               # Discord OAuth2 client, bot-bridge RPC client
  db/                     # Drizzle client
```

## Regex answer validation

Questions can optionally require an answer to match a regex pattern, in
addition to (or instead of) plain min/max length — e.g. "must be a valid
Minecraft username" as `^[A-Za-z0-9_]{3,16}$`. Checked at both submission
points: the in-server modal submit (`formSubmit.ts`) and each individual
answer in the DM application flow (`dmApplicationService.ts`), via the
same shared `validateAnswersAgainstQuestions`/`validateAnswerAgainstPattern`
logic so the two flows can't enforce different rules. Not applicable to
`select`-type questions (enforced by a zod `.refine()` in
`api/src/routes/forms.ts`, not just a UI suggestion).

**Read `shared/schema/regexValidation.ts` before relying on this in
production — it states its own real limitation rather than hiding it.**
In short: patterns are vetted against a conservative, heuristic rejection
list of known catastrophic-backtracking shapes (nested quantified groups,
quantified alternation, backreferences, lookaheads/lookbehinds) before
they're ever stored, capped at 256 characters, and answers are capped at
4000 characters before a pattern is ever run against them. What this
module does **not** have is a runtime execution timeout — JavaScript's
`RegExp.test()` is synchronous and cannot be interrupted by a
`setTimeout` race once it starts, so a genuine hard timeout would require
running matches in a separate, forcibly-terminable worker thread, which
isn't built here. That means the static rejection list is the *only*
real defense, not one layer of several — if a pattern shape slips past
the heuristics, it can still hang the process. The heuristics are
deliberately conservative (they reject some safe patterns, never accept
all unsafe ones by design), but "conservative heuristic" is not the same
guarantee as "provably safe," and that gap is worth knowing about rather
than discovering in production. `shared/schema/__tests__/regexValidation.test.ts`
covers the accept/reject cases as they currently stand — run it after
any change to the heuristics.

## Data portability: full export and Appy submission import

- **`/export`** (bot slash command) and **`GET /api/guilds/:guildId/export`**
  (dashboard) both produce a complete JSON dump of everything Appealy
  stores for a guild — forms, questions, panels, submissions/answers, DM
  templates, ticket configs/tickets, giveaways/entries, verification
  config, welcomer config, role menus, anti-raid config, quick responses,
  sticky messages, and staff delegation. Billing/session data is
  deliberately excluded — it's an Appealy-hosting-account concern, not
  portable server configuration. The intent: a server that outgrows the
  shared bot and wants a dedicated self-hosted instance can take every bit
  of their own data with them, no lock-in.
- **Owner-only, not admin-only** — both the slash command and the API
  route check the guild's actual owner (`permissionService.ts::isGuildOwner`
  on the bot side, `guildAccess.ts::requireOwnerAccess` on the API side),
  deliberately stricter than the Administrator/manager-delegation levels
  used everywhere else. The reasoning: some owners want the assurance that
  a full data dump — or a bulk import of historical applicant data — can't
  be triggered by any admin they've delegated day-to-day management to,
  only by themselves.
- **`/import-appy`** (bot slash command, file upload) and
  **`POST /api/guilds/:guildId/migrate/appy-submissions`** (dashboard,
  JSON body) import a submissions-history export from Appy — a different,
  closed-source Discord application bot — into an existing Appealy form.
  Built against a real sample export (confirmed shape documented in
  `bot/src/services/appyImportService.ts`). Appy's export has no
  question-definition metadata (type, required, validation) and no
  reviewer/reason data — only submission text and outcome — so the
  importer matches each historical question to the target form's real
  questions by exact text match and leaves reviewer/reason fields empty
  rather than inventing them. Unmatched questions are surfaced in the
  response rather than silently dropped or guessed at.
- **Known uncertainty**: `importAppy.ts`'s file-attachment resolution
  (`interaction.data.resolved.attachments`) type-checks against Discordeno
  v20, but — like the gateway-wiring caveat in
  `bot/src/core/client.ts` — attachment-option resolution APIs shift
  across library versions and this hasn't been smoke-tested against a
  live bot token. Verify this specifically before relying on it.

## Known constraints worth knowing before extending this

- **Panel buttons are capped at 5 per action row** (Discord limit). A panel
  needing more than 5 forms should be split into multiple panels — the
  dashboard's panel builder should enforce this at the UI level.
- **Modals are capped at 5 components.** `showApplicationModal` truncates
  and logs a warning if a form has more than 5 text questions; the dashboard
  form builder should warn the admin at creation time instead of silently
  truncating.
- **Bot role hierarchy**: role grant/remove will silently fail for any role
  positioned above the bot's own highest role in Discord's settings — this
  is enforced by Discord itself. `permissionService.findUnmanageableRoles`
  checks this proactively so accept/deny can report it back to staff instead
  of failing invisibly.
- **The in-process `scheduler.ts` assumes a single bot instance.** If you run
  more than one bot replica, move scheduled poll publish/close to a
  distributed lock or a separate worker so it doesn't fire twice.
- **Discordeno version drift**: `bot/src/core/client.ts` deliberately uses the
  high-level `bot.start()` helper rather than hand-wiring
  `createGatewayManager`, since that lower-level API has changed shape across
  Discordeno releases. If you need multi-shard/multi-process gateway control,
  see the comment at the top of that file before reaching for the low-level API.
