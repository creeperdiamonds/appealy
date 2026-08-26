# Appealy: reliability, migration, and go-to-market

**Date:** 2026-08-26
**Status:** design, awaiting review
**Sequencing:** Phase 0 → 1 → 2 → 3, in order

---

## Why this document exists

The request that started it was "we need to market." Investigating what
there was to market turned up a defect in the product's single most
important action, so the marketing plan is now the last phase of four
rather than the first of one.

### What the logs say

Cloud Logging, project `yahav-project-505809`, service `appealy`:

```
{"msg": "Guilds upserted", "count": 1}
{"msg": "Startup: guild burst complete", "guildsExpected": 1, "guildsReceived": 1}
{"msg": "Ban set loaded", "guilds": 0, "users": 0}
```

**One guild.** No social proof exists or can be manufactured. Any plan
that leans on server counts, testimonials or "trusted by" is unavailable.

And, from 2026-08-23:

```
Unhandled error in interactionCreate
Error: Failed to send request to discord.
  at Object.sendInteractionResponse
  at respond (ticketOpen.ts:37)
  at handleTicketOpenButton (ticketOpen.ts:33)
```

Three tickets closed inside ninety seconds, each logging
`Transcript generation failed` and `Failed to send ticket rating prompt`.
That is not three unlucky tickets. That is someone clicking a button that
appeared not to work, and clicking it again.

### The defect

Discord allows **three seconds** to make a first interaction response.
`bot/src/interactions/buttons/reviewAccept.ts` — the "one click grants the
role, sends the DM and lifts the ban" feature the entire marketing site is
built around — does all of the following *before* it responds at line 352:

| Line | Work |
|---|---|
| 39, 51, 77, 85, 236 | five database queries |
| 146, 326 | `getGuild` ×2 |
| 167, 203 | `findUnmanageableRoles` ×2 |
| 217, 220 | `addRole` / `removeRole`, one REST call **per role** |
| 244 | `unbanMember` |
| 275, 300, 320 | `editMessage`, `sendMessage`, `editChannel` |
| 327, 328 | `getUser`, then a templated DM |
| 352 | *…and only now does it answer Discord* |

Ten to fifteen sequential Discord round trips at roughly 300 ms each from
`us-central1`, plus five Cloud SQL queries. The three-second window is not
close.

**Zero handlers in the repository defer.** All 32 files that call
`sendInteractionResponse` respond immediately or not at all; `type: 5`
appears nowhere. `ping.ts` responds first and edits afterwards, which is
correct. Nothing else has that excuse.

What a staff member sees is **"This interaction failed"** while the work
has, in fact, succeeded. That is the worst available failure mode: it
teaches the user the product is broken and invites them to do it twice.

It is also the answer to the earlier question about buttons being slow to
respond. They are not slow. They are timing out.

### The consequence for marketing

At one guild there is no reputation to spend on a bad first impression.
Driving server owners to a bot whose Accept button reports failure
converts them into people who tried Appealy once. Phase 0 is therefore not
a detour from marketing; it is its precondition.

---

## Goal

Credibility with Discord server owners who arrive cold — enough that a
careful person deciding whether to trust this bot with their bans says
yes.

## Non-goals

- Paid acquisition. There is no budget and it would not help at this stage.
- Public bot-list submissions during Phases 0–2. `top.gg` and
  `discord.bots.gg` render server counts on every card; listing at one
  guild advertises the one fact working hardest against us.
- Any claim of scale, adoption or endorsement. There is none, and server
  owners detect it.

---

## Phase 0 — Stop looking broken

Nothing else in this document is worth doing first.

### 0.1 The defer sweep

**Rule.** A handler that awaits anything before its first response must
defer: respond `type: 5` immediately, do the work, deliver the result with
`editOriginalInteractionResponse`. This moves the deadline from three
seconds to fifteen minutes.

**The exception, which is absolute.** A modal response must be the *first*
response. You cannot defer and then open a modal. Three handlers open
modals and must stay immediate:

- `panelOpen.ts:182` — the application form
- `reviewDeny.ts:94` — the deny-reason box
- `verify.ts` — the captcha, and *only* the captcha branch; the `button`
  branch in the same file defers (see below)

`panelOpen.ts:73` already carries a comment saying precisely this, so the
constraint was known once and not generalised.

This works out cleanly rather than as a per-handler special case: in all
three flows the expensive work happens in the *modal-submit* handler —
`formSubmit`, `denyReason`, `verifyCaptcha` — and those defer freely.

**The modal-opening handlers must therefore stay cheap. Three of them
currently do not.** An earlier draft of this section asserted that they were
already cheap, which was never measured and is not true; that assertion is
why nobody measured.

- `verify.ts` — worst of the three, and not actually a modal handler on the
  path that matters. Only the `captcha` branch opens a modal; the `button`
  branch (the **default** — `verifySetup.ts` falls back to `"button"` when no
  method is given) does four sequential Discord REST calls — `getGuild` and
  `getMember` inside `findUnmanageableRoles`, then `addRole` and `removeRole`
  — plus two database round trips, on the first interaction a new member ever
  has with a server running Appealy. **Fixed in Phase 0:** the button branch
  now defers; only the captcha branch keeps the exemption.
- `panelOpen.ts` / `apply.ts` — seven sequential Cloud SQL queries before the
  modal. `apply.ts:43` looks up the form, `panelOpen.ts:50` looks up the
  *same* form again, and `checkGate` (`panelOpen.ts:204-249`) runs five more:
  last submission, pending count, total count, window count, gate override.
  Not fixable by deferring — the modal exemption is absolute.
- `reviewDeny.ts` — two to four queries before its `type: 9`: the submission,
  `canReviewForm`'s form lookup, `formOutcomes`, and `staffLevelFor` when an
  outcome menu is shown.

**The remedy is caching, not deferring**, and it is Phase 1 work: put the
`forms` row and the gate counters behind `guildConfigCache` so these paths do
no network I/O at all. The one exception is `apply.ts` passing its
already-fetched `form` into `runApplicationFlow` instead of letting
`panelOpen.ts:50` re-fetch it — a five-line change that removes one of the
seven queries outright. It is deliberately not bundled into the Phase 0
defer sweep: it is a behaviour change to a path that sweep does not otherwise
touch, and it deserves its own review.

**The detail that bites.** The ephemeral flag belongs on the deferred
response, `type: 5, data: { flags: 64 }`, not on the edit. Defer publicly
and it cannot be retracted to ephemeral afterwards; the channel gets a
visible "thinking…" from a bot that was supposed to answer quietly.

**Shape.** Two helpers, so this is one reviewable pattern rather than
twenty hand-written variants:

```ts
await defer(bot, interaction, { ephemeral: true });   // type 5
// ...work...
await finish(bot, interaction, "Application accepted.");  // editOriginal
```

**Handlers to convert:** `reviewAccept`, `ticketOpen`, `ticketClose`,
`formSubmit`, `denyReason`, `verifyCaptcha`, `giveawayEnter`,
`roleMenuSelect`, `pollVote`, `formSelectStep`, and the slash commands
that do real work before answering (`exportData`, `exportApplications`,
`panelCreate`, `pollCreate`, `giveaway`, `roleMenu`, `ticketPanel`,
`verifySetup`, `antiRaid`, `resetCooldown`, `formList`, `apply`,
`botStats`).

### 0.2 Make the errors say something

`Failed to send request to discord.` is what Discordeno throws for
everything — no status, no Discord error code, no body. That is why this
ran for days unnoticed.

Add `describeDiscordError(err)` returning `{ status, code, message }`, and
use it at every `logger.warn`/`logger.error` call site that currently
stringifies a raw error. Special-case **10062 Unknown Interaction** and
log it as *"handler exceeded the 3-second window"*, so this entire class of
bug reports itself from now on instead of being indistinguishable from a
network blip.

### 0.3 Cache invalidation without paying for Memorystore

The `appealy-redis-url` secret contains the literal string `memory`. The
bot therefore runs on the in-memory substitute and logs:

```
REDIS_URL is unset — using an in-memory substitute … NOT safe with more than one process
Cache invalidation subscriber skipped
Ban change subscriber skipped
```

API and bot are separate processes with separate caches that never
invalidate each other. The symptom a server owner meets: **edit a form in
the dashboard, the bot keeps serving the old one until the TTL expires.**

Terraform can provision the real thing (`enable_redis = true`), and
`terraform/outputs.tf` prices it honestly:

```
Memorystore (1GB BASIC):     ~$26/month
VPC connector (always on):    ~$9/month
TOTAL: roughly $50-60/month   (against $15-25 today)
```

That is roughly **$420/year** to fix cache invalidation, for a product
selling dedicated hosting at $30/year with one guild on it.

**Decision: don't buy it yet.** API and bot are containers in a single
Cloud Run instance, and an authenticated internal channel between them
already exists — `BOT_INTERNAL_URL=http://127.0.0.1:9090`, guarded by
`INTERNAL_RPC_SECRET`. Invalidation rides that. No new infrastructure, no
VPC connector, no monthly cost.

Keep the existing Redis pub/sub path intact and choose between the two at
startup on whether `REDIS_URL` is the memory sentinel. Redis becomes
correct the moment there is more than one instance; that is when $420
starts being worth spending, and not before.

### 0.4 Pricing correction

The site advertises dedicated hosting at **$10/year**. The billing code
charges **$30/year** (`shared/schema/pricing.ts:224`,
`CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR = 3_000`). The constant was raised
when the per-runner cost maths came in; the site was not updated with it.

| Location | Fix |
|---|---|
| `site/pricing.html:310` | visible card, `$10/year` → `$30/year` |
| `site/pricing.html:94` | JSON-LD offer, `"10.00"` → `"30.00"` |
| `site/index.html:90` | JSON-LD offer, `"10.00"` → `"30.00"` |
| `bot/src/core/dedicatedRunner.ts:9,16` | stale comment citing $10 revenue |

The JSON-LD entries matter more than the visible one: search engines
ingest them into rich results, so the wrong price can end up in a listing
nobody is looking at.

Worth saying on the page rather than merely listing: $30/year is $2.50 a
month for a bot running under the customer's own token, name and avatar,
that they do not operate. The cheapest VPS they could rent to do it
themselves is about $60/year, and then they do the work. $10 was below
cost and quietly advertised that nobody had done the arithmetic.

### 0.5 Status publisher

`STATUS_OUT_DIR` is `/srv/status`, which Deno cannot write (`NotCapable`).
Every boot the bot logs `Status publisher started` and then
`Status publishing disabled: cannot write to the output directory`.

Point it at a writable path and grant the write permission, or turn the
publisher off. Announcing a service as started and immediately warning it
is disabled is worse than not having it.

### Testing

The interaction flows cannot be unit-tested against Discord. What is
testable, and what protects the fix:

- `describeDiscordError` — pure, table-driven over real Discordeno error
  shapes including 10062.
- The `defer`/`finish` helpers — assert the deferred response carries the
  ephemeral flag and the edit does not re-send it.
- A guard test that fails if a handler in the converted list calls
  `sendInteractionResponse` with `type: 4` after an `await`. Crude, but it
  is the regression that matters and it will catch the next handler
  somebody writes.

Manual verification: open a ticket, accept an application, close a ticket
with a transcript, on the live deployment, and confirm no
`Unknown Interaction` in the logs afterwards.

---

## Phase 1 — Appy migration as the wedge

This is simultaneously the product work and the marketing message, which
is why it gets real effort rather than a campaign.

### Where it stands

`/import-appy` and `POST /api/guilds/:guildId/migrate/appy-submissions`
import a submissions history from Appy's `/export_applications`. Appy's
export carries `id`, `applicationId`, `userId`, `status`, `createdAt`,
`questions[{question, answer}]` and `submissionDuration`. It carries **no**
reviewer identity, review reason, or question metadata — only the question
text as it appeared at submission time.

Because of that, `appyImportService.ts` deliberately refuses to invent a
form: the admin must build the target Appealy form by hand first, and the
importer then matches each historical question to a real one by exact
normalised text, declining fuzzy matches on the grounds that a wrong match
silently misattributes an answer.

That refusal is correct for *answers*. It is too strict for *getting
started*, and the friction it creates — retype every question, exactly,
before you may import anything — is the single largest obstacle to a
server switching.

### The improvement

**Derive the form from the export.** Distinct question texts, in first-seen
order, become questions on a new form: `label` = the Appy text, `type` =
`short_text`, `required` = true. Then run the existing import against it,
where every question matches by construction.

Constraints that must be respected:

- `questions.label` is `varchar(200)`. Appy question text can exceed it;
  truncate on import and record that it was truncated.
- Discord's modal text-input label limit is 45 characters. Already handled
  — `panelOpen.ts:177` keeps the full text in the database and truncates
  at render time. Derivation must store the full text and rely on that,
  not pre-truncate.
- Discord modals hold at most five inputs. Appealy already pages forms;
  derived forms with more than five questions must use the same paging.

**Add a dry run.** Report what would be created and imported — questions
derived, submissions matched, submissions skipped and why — without
writing. Migration is exactly the operation people want to see before they
commit to it.

**Keep exact matching for the import into an existing form.** The dry run
should surface near-misses as a diff for a human to resolve, rather than
guessing.

### Why it is the marketing

"Switch from Appy in one command" is the strongest sentence available
against an incumbent, and migration friction is the usual reason people
stay with a bot they dislike. It is also verifiable, which nothing else in
the marketing currently is.

---

## Phase 2 — Tickets

**Transcripts silently lose data.** `generateAndPostTranscript` calls
`getMessages(channelId, { limit: 100 })` — Discord's per-call maximum — and
treats the result as the whole conversation. Any ticket longer than 100
messages is transcribed from its last 100 only, with nothing indicating
the rest existed. For a feature described in the code as a
"compliance/reference artifact", losing the beginning of the conversation
is the wrong failure. Paginate with `before`, and cap explicitly with a
stated limit and a line in the transcript when it is hit.

**Rating prompts die quietly.** `sendRatingPrompt` catches everything and
logs a warning, on the assumption that the failure means closed DMs. The
Aug 23 logs show it also swallows genuine API failures. Distinguish them
using `describeDiscordError` from 0.2, and fall back to an in-channel
prompt before the channel is archived when the DM is refused.

**Ordering.** `closeTicket` generates the transcript, then archives or
deletes the channel. Correct as written; worth an explicit comment so it
is not reordered later, since deletion first would destroy the source.

---

## Phase 3 — Marketing

Only after 0–2. The strategy is set by two facts: one guild, and no
budget.

**What is not available:** social proof, scale claims, bot-list
submissions (their cards show server counts).

**What is:**

1. **Show the product.** There is not a single screenshot in the
   repository — no PNG, JPG, WebP or GIF anywhere. The site is text and
   SVG. Server owners want to see the review queue and the panel before
   installing something that touches bans. Screenshots and one short clip
   of an appeal going from submission to accepted are the highest-value
   assets available, and they cost nothing but an afternoon.

2. **Position on the existing line.** `brand/README.md` already has it:
   *Appy's ban message says "this decision is final and cannot be
   appealed."* The mark is an open door because that is the opposite of
   that sentence in one shape. That is a better hook than anything a
   campaign would produce; build the page around it.

3. **Be openly new.** With one guild, the honest posture outperforms the
   aspirational one. A public changelog, a working status page (0.5), and
   visible commit activity say "maintained" without claiming "popular".
   Note that `CHANGES.md` is an internal handoff note, not a changelog,
   and cannot be published as-is.

4. **Recruit by hand.** Five to ten real servers, approached individually,
   who will report what breaks. This is the phase that produces the first
   thing worth saying publicly.

5. **Then list.** Once the server count is not the weakest fact about the
   product.

---

## Risks

- **The defer sweep touches every interaction path.** It is mechanical but
  broad, and a mistake in it breaks a working flow. The modal constraint in
  0.1 is the specific trap; the guard test in Testing is the mitigation.
- **Declining Memorystore is a deliberate bet on staying single-instance.**
  It is correct today and wrong the moment `maxScale > 1`. The startup
  selection in 0.3 exists so that flipping `enable_redis` is the whole
  change when that day comes.
- **Deriving forms from Appy exports produces imperfect forms** — every
  question `short_text` and required, because the export says nothing else.
  The dry run exists so the admin sees that before committing, and the
  result is still faster than retyping.
- **Phase 3 depends on work not yet scheduled.** Screenshots require a
  populated dashboard, which requires the product working, which is Phase 0.

## Open questions

- "Improvements for Appy export" was read as Appy *import* — the migration
  path in Phase 1. Appealy's own `/export` may also have been meant; it is
  not covered here.
- Region: the ~300 ms round trip to Discord from `us-central1` is a
  contributing factor to 0.1 and is not addressed by it. `europe-west1`
  was raised earlier and remains open.
