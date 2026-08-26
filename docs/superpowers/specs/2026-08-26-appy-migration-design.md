# Appy migration: derive the form, show the plan, name the gaps

**Date:** 2026-08-26
**Status:** design, awaiting review
**Depends on:** Phase 0 (`2026-08-26-appealy-reliability-and-marketing-design.md`) — `/import-appy` defers there, without which a large import blows Discord's three-second window
**Sub-project:** 3 of 5 in the feature decomposition (Application intake)

---

## Why this document exists

Appealy can already import a submissions history from Appy. It cannot
import a *form*. So the sentence the marketing wants to say — "switch from
Appy in one command" — is currently false, and the honest version is
"recreate every question by hand, exactly, and then run one command."

That retyping is the largest single obstacle to a server switching, and
migration friction is the usual reason people stay with a bot they dislike.

### What exists today

`/import-appy <application_name> <file>` takes the JSON from Appy's
`/export_applications` and writes submission history into a form the admin
has already built. The export's confirmed shape:

```
[{
  id: string,                 // Appy's submission ID — not reused
  applicationId: string,      // Appy's form ID — not reused
  userId: string,             // Discord snowflake, as a string
  status: "ACCEPTED" | "DENIED" | "PENDING",
  createdAt: string,          // ISO 8601
  questions: [{ question: string, answer: string }],
  submissionDuration: number  // seconds
}]
```

`appyImportService.ts` matches each historical question against the target
form's real questions by exact text after trim/case/whitespace
normalisation, and **deliberately refuses to fuzzy-match**. Its comment
gives the reason, and it is correct:

> a wrong match silently attributing an answer to the wrong question is
> worse than an honestly-unmatched one

That refusal is right for *answers* and stays. It is too strict for
*getting started*, which is what this document addresses.

### What the export cannot tell us

Appy's export carries no reviewer identity, no review reason, and **no
question metadata at all** — no type, no required flag, no validation, no
ordering beyond the array. Only the question text as it appeared at
submission time. Every design decision below follows from that scarcity.

---

## Goal

An admin with an Appy export and no Appealy form ends up with a working
form and their history inside it, having seen exactly what would happen
before any of it was real.

## Non-goals

- **Automatic fuzzy matching of answers.** Never. Near-misses get reported
  for a human to resolve; the importer does not guess.
- **Inventing reviewer data.** `reviewedBy` and `reviewedAt` stay null.
  The export does not know when a decision was made, only when the
  submission arrived, and a plausible-looking `reviewedAt` misrepresents
  the historical record.
- **Importing anything but applications.** Appy's export is
  single-form-scoped; `applicationId` is not reused.
- **A dashboard upload flow.** The API route gains the same capabilities,
  but the browser-side upload UI is separate work.

---

## 0. The structural problem, fixed first

`appyImportService.ts` **exists twice**:

| File | Lines |
|---|---|
| `bot/src/services/appyImportService.ts` | 147 |
| `api/src/services/appyImportService.ts` | 109 |

Same logic, different comments. The API copy explains itself:

> Mirrored rather than shared for the same Deno/Node split reason as
> dataExportService.ts.

That reason does not hold. `shared/services/dataImport.ts` is imported by
**both** runtimes at the same relative path — `bot/src/commands/importAppealy.ts:21`
and `api/src/routes/migration.ts:24` — and it solves the split by taking
the database handle as a parameter:

```ts
export async function importGuildData(
  db: Db,                    // PostgresJsDatabase, injected
  payload: ImportPayload,
  options: ImportOptions,
): Promise<ImportReport>
```

Dependency injection already solves this, in the file next door.

**Every feature below must therefore be written once, in
`shared/services/appyImport.ts`, with both copies deleted.** Adding
derivation, dry-run and near-miss reporting to two diverging files is three
features implemented twice and a guaranteed future bug where one copy is
fixed and the other is not.

This is not optional cleanup bundled in for tidiness. It is the
precondition that makes the rest cost one implementation instead of two.

---

## 1. A form can exist before it is ready

`forms.logChannelId` is `NOT NULL`. It is where pending submissions get
posted for review, and Appy's export has no concept of it. So a derived
form cannot be complete from the export alone — something must supply a
channel, and the admin running an import may not have decided yet.

**Decision: make `logChannelId` nullable, and guard activation.**

A derived form is created `active: false, logChannelId: null` — a state
that honestly means "not ready yet" rather than one that guesses.

**The invariant that makes this safe:** *a form with no log channel cannot
be activated, and no panel for it can be published.* Enforced in the API's
form-update route and in the bot's panel-publish path, not left to
convention.

The blast radius is small because every other reader of `logChannelId` is
on the submission path, which is unreachable for a form that was never
activated:

| Site | Path |
|---|---|
| `formSubmit.ts:246`, `:293` | posts the review embed / opens its thread |
| `reviewAccept.ts:279`, `:301` | edits the log message on accept |
| `denyReason.ts:74`, `:93` | edits it on deny |
| `guildMemberRemove.ts:81` | edits it when an applicant leaves |

Only two sites read it outside that path and need null handling:
`formList.ts:36` (displays `<#id>`; should say "no review channel" instead)
and `api/src/routes/forms.ts:370` (`.toString()` on a value that can now be
null). The zod schema at `forms.ts:66` becomes nullable for creation and
stays required for activation.

**The alternative I rejected:** defaulting to whatever channel the command
ran in. It avoids a migration, but it silently picks a channel the admin
never chose, and if they do not notice, real applications start landing
there the moment the form goes live. A visible unfinished state beats a
plausible wrong one.

---

## 2. Derivation

```ts
export interface DerivedQuestion {
  label: string;          // truncated to 200 if needed
  sortOrder: number;      // first-seen order across the export
  truncatedFrom?: number; // original length, when truncation happened
  seenIn: number;         // how many submissions contained this question
}

export interface FormPlan {
  name: string;
  questions: DerivedQuestion[];
  warnings: string[];
}

export function deriveFormPlan(rows: AppyExportRow[], name: string): FormPlan;
```

Pure. Reads rows, writes nothing, touches no database.

**Rules, each forced by what the export lacks:**

- **Distinct question texts, in first-seen order**, become questions.
  `sortOrder` comes from that order — the column exists and every render
  path sorts on it (`panelOpen.ts:53`, `formSubmit.ts:53`, and three
  others).
- **`type: "short_text"`, `required: true`** for every question, because
  the export states nothing else. This is the plan's biggest lie-by-
  omission and the dry run must show it plainly, so the admin fixes the
  paragraph-shaped questions before anyone applies.
- **Labels truncate at `varchar(200)`** and record `truncatedFrom`. Never
  silently.
- **`seenIn` counts** how many submissions carried each question. A
  question present in 3 of 400 submissions is probably a wording variant
  of another, not a real question — that count is what lets a human see it.

**Not pre-truncated to 45 characters.** `questions.label` allows 200, and
the schema comment is explicit that the 45-character Discord modal limit
belongs to the `in_server` flow only, with `panelOpen.ts:177` truncating at
render time. A `direct_message` form has no such limit. Derivation stores
the full text and lets each flow decide.

**Long questions are surfaced, not solved.** Appy's questions are often
full sentences. For an `in_server` form these render truncated to 45
characters and page five per modal. The dry run reports how many labels
exceed 45 and how many modal pages the result implies, so the admin can
choose `direct_message` knowingly. Derivation does not pick the flow —
that changes the applicant's experience and is the admin's call.

---

## 3. Dry run

```ts
export interface ImportOptions {
  dryRun?: boolean;
}

export async function importAppySubmissions(
  db: Db,
  guildId: bigint,
  targetFormId: string,
  rows: AppyExportRow[],
  options?: ImportOptions,
): Promise<ImportResult>;
```

`ImportResult` keeps its existing shape — `imported`, `skipped`,
`unmatchedQuestions` — and gains `wouldCreate` and `nearMisses`.

**Why this matters more than it sounds.** The current importer opens **one
transaction per row**:

```ts
for (const row of rows) {
  ...
  await db.transaction(async (tx) => { /* insert submission + answers */ });
  result.imported++;
}
```

A failure at row 400 leaves 399 rows committed and no way back. That is
defensible — a partial history beats none — but it means **the dry run is
the only opportunity to see the whole outcome while none of it is real.**

The dry run walks identical logic: same status mapping, same `BigInt`
parsing, same date validation, same question matching. It must not be a
second code path that approximates the first, or it will approve imports
that then fail. The write is the only thing gated.

---

## 4. Near-miss reporting

```ts
export interface NearMiss {
  questionText: string;      // from the export
  closestLabel: string;      // the form question it nearly matched
  closestQuestionId: string;
  score: number;             // 0..1, higher is closer
}
```

For every unmatched question, name the closest existing question and how
close it was. Scoring is normalised Levenshtein over the same
`normalize()` the matcher uses, so a near-miss is measured against exactly
what the exact match compared.

**Reported only. Never applied.** `matchQuestion` keeps its exact-match-only
behaviour unchanged. This exists so a human can see that *"What is your
age?"* and *"What's your age?"* are the same question and fix the wording,
rather than discovering months later that a column of answers is empty.

Only misses above a floor (~0.6) are worth showing; below that there is no
near-miss, just an unmatched question.

---

## 5. The post-import channel prompt

Deriving a form leaves exactly one thing unanswered, and the moment to ask
is after the work is done — not as a command argument the admin must decide
before they know what they are importing.

**How derivation is chosen.** `/import-appy`'s `application_name` option
is an autocomplete over the guild's existing forms, and picking one keeps
today's behaviour exactly. Derivation is a new entry at the top of that
autocomplete — **"➕ Create a new form from this export"** — so the two
paths are one command and the admin never has to know a second one exists.
Choosing it derives; choosing a form imports into it.

**Flow, in order:**

1. `/import-appy` with derivation selected runs the **dry run first** and
   writes nothing. It reports the plan: questions derived in order, how
   many labels exceed 45 characters, how many modal pages that implies,
   submissions that would import, submissions that would skip and why.
2. The response carries a **Create form and import** button. Nothing has
   been written at this point, and abandoning the interaction leaves the
   guild untouched.
3. On confirm, the form and questions are created `active: false,
   logChannelId: null`, and the history is imported.
4. The result carries a **channel select** (Discordeno v20 exposes
   `SelectMenuChannelsComponent`) asking *"Where should submissions for
   this form be posted for review?"*
5. **Picked** → set `logChannelId`, and offer to activate.
6. **Ignored** → nothing further happens. The form sits inactive with no
   channel, and the dashboard shows it as needing one.

Steps 1–2 are why the dry run is not an optional flag on this path: an
admin deriving a form has, by definition, not seen what the export
contains, so showing them first is the only order that makes sense.
Importing into an *existing* form keeps `dryRun` as an opt-in, since that
admin already knows their own questions.

Ignoring the prompt is a supported outcome, not an error. An admin
importing at 2am can leave it and finish in the dashboard tomorrow; the
unfinished state is visible in both places, which is the whole point of
making the column nullable rather than guessing a value.

The prompt is a component on the deferred response, so it inherits Phase
0's fifteen-minute window rather than the three-second one.

---

## Data flow

```
/import-appy  ──  application_name autocomplete
        │
        ├─ an existing form ──► importAppySubmissions(db, …, { dryRun? })
        │                              exact-match → answers
        │                              unmatched   → nearMisses
        │                       (today's path, plus opt-in dry run)
        │
        └─ "➕ Create a new form from this export"
                   │
                   ├─ deriveFormPlan(rows, name) ──► FormPlan  (pure, no writes)
                   │            │
                   │      dry run renders it: questions, >45 labels,
                   │      modal pages, would-import, would-skip
                   │            │
                   │      [Create form and import]  ── abandoned ──► nothing written
                   │            │
                   ├─ create form + questions
                   │        active: false, logChannelId: null
                   │
                   ├─ importAppySubmissions(db, …)
                   │
                   └─ channel select ──► logChannelId set ──► offer activation
                              │
                              └─ ignored ──► dashboard: "needs a review channel"
```

## Error handling

- **Malformed export** — rejected before any write, naming the first row
  and field that failed. Unchanged from today.
- **Partial import failure** — per-row transactions stay. A row that fails
  is skipped with a reason and the rest proceed; the result reports both.
- **Derivation with zero questions** — an export whose rows carry no
  `questions` array produces a plan with no questions and a warning. No
  form is created; a form with no questions cannot be applied to.
- **Duplicate form name** — derivation does not overwrite. If a form of
  that name exists, the plan reports it and the admin renames or targets
  the existing form with the current import path.
- **Prompt failures** — a failed channel-select interaction leaves the
  form exactly as the import left it: inactive, no channel, visible in the
  dashboard. Nothing is half-applied.

## Testing

Derivation and near-miss scoring are pure functions over plain data, with
no database and no Discord. They get real unit tests — the first in this
area, and a meaningful change from Phase 0, where the interaction flows
could only be protected by a source-level textual guard.

- `deriveFormPlan` — first-seen ordering; `seenIn` counts; truncation at
  200 with `truncatedFrom` recorded; the >45-character count; an export
  with no questions; an export whose rows disagree about which questions
  exist.
- Near-miss scoring — that *"What is your age?"* against *"What's your
  age?"* scores high and *"Why do you want to join?"* against them scores
  below the floor; that the floor excludes noise; that an exact match
  never appears as a near miss.
- `importAppySubmissions` with `dryRun: true` — writes nothing (asserted
  against a transaction spy), and returns the same counts a real run
  produces on the same input.

The activation guard gets a route-level test: activating a form with a
null `logChannelId` is rejected.

## Migration and compatibility

One migration, one statement:

```sql
ALTER TABLE "forms" ALTER COLUMN "log_channel_id" DROP NOT NULL;
```

Dropping a `NOT NULL` is additive in the sense that matters — every
existing row already satisfies the looser constraint, and old code reading
the column keeps working because no existing row is null. A rollback needs
no data repair unless a derived form has been created in the meantime.

The `/import-appy` command keeps its current behaviour when given a form
that already exists. Derivation is what happens when no target is named.

## Risks

- **Derived forms are imperfect by construction.** Every question
  `short_text` and required, because the export says nothing else. The dry
  run exists so the admin sees that before committing, and the result is
  still faster than retyping thirty questions.
- **Nullable `logChannelId` is a real loosening.** Its safety rests on the
  activation guard, not on the type. If a future code path activates a
  form without going through that guard, the submission path will read a
  null channel. The guard belongs in as few places as possible for exactly
  this reason.
- **The dry run must share the real path.** If it drifts into an
  approximation, it will bless imports that then fail — worse than having
  no dry run, because it carries authority it has not earned.
- **Consolidating the duplicated service touches a working import.** The
  move is mechanical, but it is the kind of mechanical change that
  silently drops a behaviour present in only one copy. The two copies must
  be diffed for behavioural difference, not just line count, before either
  is deleted.

## Open questions

- **Should derivation offer `direct_message` when it detects long
  questions?** The spec reports the count and leaves the choice to the
  admin. An argument exists for recommending it outright when most labels
  exceed 45 characters — deliberately not decided here.
- **Should the dashboard get the same dry run?** The API route gains the
  capability; whether the browser exposes a preview screen is left to the
  dashboard work, which is separate.
