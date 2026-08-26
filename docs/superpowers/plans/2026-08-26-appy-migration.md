# Appy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin with an Appy export and no Appealy form ends up with a working form and their history inside it, having seen exactly what would happen before any of it was real.

**Architecture:** The duplicated import service is consolidated into `shared/services/appyImport.ts` first, taking the database handle as a parameter exactly as `shared/services/dataImport.ts` does — every feature after that is written once. Form derivation and near-miss scoring are pure functions with real unit tests. `forms.logChannelId` becomes nullable so a derived form can honestly say "not ready yet", guarded by the rule that such a form cannot be activated.

**Tech Stack:** TypeScript · Deno (bot) · Node + Express (api) · Drizzle ORM · Discordeno v20 · `deno test` with `https://deno.land/std@0.224.0/assert/mod.ts`

**Spec:** `docs/superpowers/specs/2026-08-26-appy-migration-design.md`

## Global Constraints

- **The importer never fuzzy-matches answers.** `matchQuestion` stays exact-match-after-normalisation. Near-misses are reported for a human; a wrong match silently misattributes an answer, which is worse than an honest gap.
- **Reviewer data is never invented.** `reviewedBy` and `reviewedAt` stay null on imported submissions.
- **A form with `logChannelId === null` cannot be activated or published.** This invariant is the only thing making the nullable column safe.
- **The dry run walks the same code path as the real run.** Same status mapping, same `BigInt` parsing, same date validation, same matching. Only the write is gated. A dry run that approximates will bless imports that then fail.
- Tests run **from the repository root**. Shared: `deno test shared/services/__tests__/`. Bot: `deno test --allow-read -c bot/deno.json bot/src/`. Bot type-check needs `-c bot/deno.json` or the import map is missing.
- API build: `cd api && npm run build` must exit 0.
- Converted interaction handlers use `defer()`/`finish()` from `bot/src/utils/interactionResponse.ts` and never call `sendInteractionResponse` directly — `bot/src/interactions/__tests__/deferGuard.test.ts` enforces this and must stay green.
- House style is comments that explain *why*, often at length.
- Commit after every task.

---

### Task 1: Consolidate the duplicated import service

`appyImportService.ts` exists twice — `bot/src/services/` (147 lines) and `api/src/services/` (109 lines), same logic, different comments. The API copy says it is "mirrored rather than shared for the same Deno/Node split reason", but `shared/services/dataImport.ts` is imported by both runtimes and solves the split by taking the db handle as a parameter. Every later task would otherwise be written twice.

**Files:**
- Create: `shared/services/appyImport.ts`
- Create: `shared/services/__tests__/appyImport.test.ts`
- Delete: `bot/src/services/appyImportService.ts`, `api/src/services/appyImportService.ts`
- Modify: `bot/src/commands/importAppy.ts` (its import), `api/src/routes/migration.ts` (its import)

**Interfaces:**
- Consumes: `Db = PostgresJsDatabase<typeof schema>` — the pattern from `shared/services/dataImport.ts:59`.
- Produces:
  - `normalize(text: string): string`
  - `matchQuestion(appyQuestionText: string, targetQuestions: Question[]): Question | null`
  - `importAppySubmissions(db: Db, guildId: bigint, targetFormId: string, rows: AppyExportRow[]): Promise<ImportResult>`
  - `interface AppyExportRow`, `interface ImportResult` — unchanged shapes

- [ ] **Step 1: Diff the two copies for behavioural difference, not line count**

Run: `diff bot/src/services/appyImportService.ts api/src/services/appyImportService.ts`

The line counts differ (147 vs 109) because of comments. **Confirm the executable statements are identical** before deleting either. If they are not, stop and report which behaviour each copy has — a silent drop here loses a fix that exists in only one place.

- [ ] **Step 2: Write the failing test**

Create `shared/services/__tests__/appyImport.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchQuestion, normalize } from "../appyImport.ts";

/** Minimal stand-in: matchQuestion only reads id and label. */
const q = (id: string, label: string) => ({ id, label }) as never;

Deno.test("normalize trims, lowercases and collapses whitespace", () => {
  assertEquals(normalize("  What   is your AGE? "), "what is your age?");
});

Deno.test("matchQuestion matches after normalisation", () => {
  const target = [q("a", "What is your age?"), q("b", "Why do you want to join?")];
  assertEquals(matchQuestion("  what is your AGE?  ", target)?.id, "a");
});

Deno.test("matchQuestion refuses a near miss", () => {
  const target = [q("a", "What is your age?")];
  assertEquals(matchQuestion("What's your age?", target), null);
});

Deno.test("matchQuestion returns null when nothing matches", () => {
  assertEquals(matchQuestion("Anything", [q("a", "Something")]), null);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: FAIL — `Module not found ".../appyImport.ts"`

- [ ] **Step 4: Move the service**

Create `shared/services/appyImport.ts` from the **bot** copy (the one with the fuller comments). Three changes:

1. Header comment: explain it is shared, and why — the db handle is injected, the same way `dataImport.ts` does it, which is what makes one copy serve both runtimes.
2. Replace `import { db, schema } from "../db/client.ts"` with:

```ts
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/schema.ts";

type Db = PostgresJsDatabase<typeof schema>;
```

3. `importAppySubmissions` takes `db: Db` as its first parameter. Export `normalize` and `matchQuestion`, which were file-private.

Keep every other line, including the comment explaining why fuzzy matching is refused.

- [ ] **Step 5: Run the test**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 6: Update both call sites and delete both copies**

`bot/src/commands/importAppy.ts`: import from `../../../shared/services/appyImport.ts` and pass `db` as the first argument.

`api/src/routes/migration.ts`: same, matching how it already imports `importGuildData` from `../../../shared/services/dataImport.ts:24`.

Then `rm bot/src/services/appyImportService.ts api/src/services/appyImportService.ts`.

- [ ] **Step 7: Verify both runtimes**

Run: `deno check -c bot/deno.json bot/src/main.ts` → clean
Run: `cd api && npm run build` → exit 0
Run: `deno test --allow-read -c bot/deno.json bot/src/` → 39 passing (unchanged)

- [ ] **Step 8: Commit**

```bash
git add shared/services/appyImport.ts shared/services/__tests__/appyImport.test.ts bot/src/commands/importAppy.ts api/src/routes/migration.ts
git rm bot/src/services/appyImportService.ts api/src/services/appyImportService.ts
git commit -m "Share one Appy importer instead of two that drift"
```

---

### Task 2: Make `logChannelId` nullable

A derived form cannot supply a review channel from an Appy export, and the admin running the import may not have decided yet. `NOT NULL` forces a guess; nullable lets the form say "not ready".

**Files:**
- Modify: `shared/schema/schema.ts` (the `forms.logChannelId` column)
- Create: `db/migrations/0009_*.sql` (generated)
- Modify: `bot/src/commands/formList.ts:36`
- Modify: `api/src/routes/forms.ts:66` (zod), `:370` (response mapping)

**Interfaces:**
- Consumes: nothing.
- Produces: `forms.logChannelId` is `bigint | null` everywhere it is read.

- [ ] **Step 1: Make the column nullable**

In `shared/schema/schema.ts`, drop `.notNull()` from `logChannelId` and replace the trailing comment with the reason:

```ts
    // Nullable since the Appy migration path: a form derived from an export
    // has no review channel to name, and guessing one means real
    // applications land somewhere the admin never chose. Null means "not
    // ready yet", and the activation guard (api/src/routes/forms.ts) is what
    // makes that safe — a form with no log channel cannot go active, so the
    // submission paths that read this column are unreachable while it is null.
    logChannelId: bigint("log_channel_id", { mode: "bigint" }),
```

- [ ] **Step 2: Generate the migration**

Run: `cd api && npm run db:generate`

Confirm the generated SQL is exactly one statement dropping the constraint:

```sql
ALTER TABLE "forms" ALTER COLUMN "log_channel_id" DROP NOT NULL;
```

Then run `grep -icE "drop (table|column)|truncate" db/migrations/0009_*.sql` — expect `0`. The deploy workflow refuses destructive migrations, and `DROP NOT NULL` must not read as one.

- [ ] **Step 3: Handle null at the two read sites outside the submission path**

`bot/src/commands/formList.ts:36` currently renders `<#${f.logChannelId}>` unconditionally, which prints `<#null>`:

```ts
    (f) =>
      `${f.active ? "🟢" : "⚪"} **${f.name}** — ${
        f.logChannelId ? `<#${f.logChannelId}>` : "_no review channel yet_"
      } (${f.id})`,
```

`api/src/routes/forms.ts:370` calls `.toString()` on it:

```ts
    logChannelId: form.logChannelId?.toString() ?? null,
```

`api/src/routes/forms.ts:66` — the create schema becomes nullable, since a derived form posts without one:

```ts
  logChannelId: z.string().nullable().optional(),
```

and the insert at `:168` becomes `data.logChannelId ? BigInt(data.logChannelId) : null`.

- [ ] **Step 4: Verify**

Run: `deno check -c bot/deno.json bot/src/main.ts` → clean. If it flags a `logChannelId` read you did not expect, that is a submission-path site — report it rather than adding a null check, because it means the activation guard is not sufficient on its own.

Run: `cd api && npm run build` → exit 0

- [ ] **Step 5: Commit**

```bash
git add shared/schema/schema.ts db/migrations bot/src/commands/formList.ts api/src/routes/forms.ts
git commit -m "Let a form exist before it has a review channel"
```

---

### Task 3: The activation guard

Nullable `logChannelId` is only safe because a form without one cannot go live. This is the invariant, and it belongs in as few places as possible.

**Files:**
- Modify: `api/src/routes/forms.ts` (the update/activate route around `:306`)
- Modify: `bot/src/core/controlServer.ts` (the panel publish route)

**Interfaces:**
- Consumes: `forms.logChannelId` nullable, from Task 2.
- Produces: a `409` on activating a channel-less form; a thrown `form_missing_log_channel` on publishing one.

- [ ] **Step 1: Guard activation in the API**

In `api/src/routes/forms.ts`, before applying an update that sets `active: true`, load the form's current `logChannelId` and reject when the result would be active with no channel:

```ts
  // A form with no review channel cannot go active. This is the invariant
  // that makes logChannelId nullable safe: every other reader of that column
  // is on the submission path, which is unreachable until a form is live.
  // Without this, an admin activates a derived form and the first applicant's
  // submission tries to post into null.
  const willBeActive = data.active ?? existing.active;
  const willHaveChannel =
    data.logChannelId !== undefined ? data.logChannelId !== null : existing.logChannelId !== null;
  if (willBeActive && !willHaveChannel) {
    return res.status(409).json({
      error: "form_missing_log_channel",
      detail: "Set a review channel before activating this form.",
    });
  }
```

Match the file's existing error-response shape rather than copying this verbatim — read a neighbouring route first.

- [ ] **Step 2: Guard panel publishing in the bot**

In `bot/src/core/controlServer.ts`'s `/internal/panels/publish` route, the publish path resolves a form. Throw before posting when its `logChannelId` is null:

```ts
        if (!form.logChannelId) {
          throw new Error("form_missing_log_channel");
        }
```

A published panel is a live entry point regardless of `active`, so this needs its own check rather than relying on the API's.

- [ ] **Step 3: Test the guard**

This is the invariant the whole nullable column rests on, so it gets a test rather than a manual check. `api/` has no test runner configured, so the guard's decision is extracted as a pure function and tested with the rest of the shared logic.

In `shared/services/appyImport.ts`:

```ts
/**
 * Whether an update would leave a form active with no review channel.
 *
 * Extracted from the route so the invariant can be tested without a server:
 * this single rule is what makes forms.logChannelId nullable safe, and every
 * other reader of that column assumes it holds.
 */
export function wouldActivateWithoutChannel(
  existing: { active: boolean; logChannelId: bigint | null },
  update: { active?: boolean; logChannelId?: string | null },
): boolean {
  const willBeActive = update.active ?? existing.active;
  const willHaveChannel =
    update.logChannelId !== undefined ? update.logChannelId !== null : existing.logChannelId !== null;
  return willBeActive && !willHaveChannel;
}
```

In `shared/services/__tests__/appyImport.test.ts`:

```ts
import { wouldActivateWithoutChannel } from "../appyImport.ts";

Deno.test("activating a channel-less form is refused", () => {
  assertEquals(
    wouldActivateWithoutChannel({ active: false, logChannelId: null }, { active: true }),
    true,
  );
});

Deno.test("activating while setting a channel in the same update is allowed", () => {
  assertEquals(
    wouldActivateWithoutChannel({ active: false, logChannelId: null }, { active: true, logChannelId: "123" }),
    false,
  );
});

Deno.test("clearing the channel on an already-active form is refused", () => {
  assertEquals(
    wouldActivateWithoutChannel({ active: true, logChannelId: 1n }, { logChannelId: null }),
    true,
  );
});

Deno.test("editing an inactive channel-less form is allowed", () => {
  assertEquals(
    wouldActivateWithoutChannel({ active: false, logChannelId: null }, { logChannelId: null }),
    false,
  );
});
```

Then have the route call it instead of inlining the condition.

- [ ] **Step 4: Verify**

Run: `deno test shared/services/__tests__/appyImport.test.ts` → 8 passing (4 from Task 1, 4 new)
Run: `cd api && npm run build` → exit 0
Run: `deno check -c bot/deno.json bot/src/core/controlServer.ts` → clean

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/forms.ts bot/src/core/controlServer.ts shared/services/appyImport.ts shared/services/__tests__/appyImport.test.ts
git commit -m "Refuse to activate or publish a form with no review channel"
```

---

### Task 4: `deriveFormPlan`

Turns an export into a plan for a form. Pure — reads rows, writes nothing, touches no database.

**Files:**
- Modify: `shared/services/appyImport.ts`
- Modify: `shared/services/__tests__/appyImport.test.ts`

**Interfaces:**
- Consumes: `AppyExportRow` from Task 1.
- Produces:
  - `interface DerivedQuestion { label: string; sortOrder: number; truncatedFrom?: number; seenIn: number }`
  - `interface FormPlan { name: string; questions: DerivedQuestion[]; warnings: string[] }`
  - `deriveFormPlan(rows: AppyExportRow[], name: string): FormPlan`
  - `const LABEL_MAX = 200`, `const MODAL_LABEL_MAX = 45`

- [ ] **Step 1: Write the failing tests**

Append to `shared/services/__tests__/appyImport.test.ts`:

```ts
import { deriveFormPlan } from "../appyImport.ts";

const row = (questions: { question: string; answer: string }[]) => ({
  id: "s1",
  applicationId: "a1",
  userId: "123",
  status: "ACCEPTED",
  createdAt: "2026-01-01T00:00:00.000Z",
  questions,
}) as never;

Deno.test("deriveFormPlan keeps first-seen order", () => {
  const plan = deriveFormPlan(
    [
      row([{ question: "Name?", answer: "a" }, { question: "Age?", answer: "b" }]),
      row([{ question: "Age?", answer: "c" }, { question: "Why?", answer: "d" }]),
    ],
    "Staff",
  );
  assertEquals(plan.questions.map((q) => q.label), ["Name?", "Age?", "Why?"]);
  assertEquals(plan.questions.map((q) => q.sortOrder), [0, 1, 2]);
});

Deno.test("deriveFormPlan counts how many submissions carried each question", () => {
  const plan = deriveFormPlan(
    [row([{ question: "Name?", answer: "a" }]), row([{ question: "Name?", answer: "b" }, { question: "Rare?", answer: "c" }])],
    "Staff",
  );
  assertEquals(plan.questions.find((q) => q.label === "Name?")?.seenIn, 2);
  assertEquals(plan.questions.find((q) => q.label === "Rare?")?.seenIn, 1);
});

Deno.test("deriveFormPlan truncates over 200 chars and records the original length", () => {
  const long = "x".repeat(250);
  const plan = deriveFormPlan([row([{ question: long, answer: "a" }])], "Staff");
  assertEquals(plan.questions[0].label.length, 200);
  assertEquals(plan.questions[0].truncatedFrom, 250);
});

Deno.test("deriveFormPlan does not truncate to the modal limit", () => {
  const sixty = "y".repeat(60);
  const plan = deriveFormPlan([row([{ question: sixty, answer: "a" }])], "Staff");
  assertEquals(plan.questions[0].label.length, 60);
  assertEquals(plan.questions[0].truncatedFrom, undefined);
});

Deno.test("deriveFormPlan dedupes on normalised text", () => {
  const plan = deriveFormPlan(
    [row([{ question: "What is your age?", answer: "a" }, { question: "  what IS your age? ", answer: "b" }])],
    "Staff",
  );
  assertEquals(plan.questions.length, 1);
});

Deno.test("deriveFormPlan warns when an export has no questions", () => {
  const plan = deriveFormPlan([row([])], "Staff");
  assertEquals(plan.questions.length, 0);
  assertEquals(plan.warnings.length > 0, true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: FAIL — `deriveFormPlan` is not exported

- [ ] **Step 3: Implement**

Add to `shared/services/appyImport.ts`:

```ts
/** questions.label is varchar(200). */
export const LABEL_MAX = 200;

/**
 * Discord's modal text-input label limit. NOT applied here — it belongs to
 * the in_server flow only (panelOpen.ts truncates at render), and a
 * direct_message form has no such limit. Exported so the dry run can COUNT
 * how many labels exceed it, which is what lets an admin choose the DM flow
 * knowingly instead of discovering truncation after the fact.
 */
export const MODAL_LABEL_MAX = 45;

export interface DerivedQuestion {
  label: string;
  sortOrder: number;
  truncatedFrom?: number;
  seenIn: number;
}

export interface FormPlan {
  name: string;
  questions: DerivedQuestion[];
  warnings: string[];
}

/**
 * Builds a form plan from an Appy export.
 *
 * Appy's export carries only the question TEXT — no type, no required flag,
 * no validation, no ordering beyond the array. So every derived question is
 * short_text and required, which is the plan's biggest lie by omission and
 * exactly what the dry run has to show before anyone commits to it.
 *
 * Deduping is on normalised text, using the same normalize() the matcher
 * uses, so a question that derivation collapses is one the importer would
 * also have matched. Any other pairing produces questions nothing can fill.
 */
export function deriveFormPlan(rows: AppyExportRow[], name: string): FormPlan {
  const seen = new Map<string, DerivedQuestion>();
  const warnings: string[] = [];

  for (const r of rows) {
    for (const q of r.questions ?? []) {
      const key = normalize(q.question);
      const existing = seen.get(key);
      if (existing) {
        existing.seenIn++;
        continue;
      }
      const full = q.question.trim();
      seen.set(key, {
        label: full.length > LABEL_MAX ? full.slice(0, LABEL_MAX) : full,
        truncatedFrom: full.length > LABEL_MAX ? full.length : undefined,
        sortOrder: seen.size,
        seenIn: 1,
      });
    }
  }

  const questions = [...seen.values()];
  if (questions.length === 0) {
    warnings.push(
      "This export contains no questions, so there is nothing to build a form from. " +
        "A form with no questions cannot be applied to.",
    );
  }

  return { name, questions, warnings };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: PASS — 14 tests (8 existing + 6 new)

- [ ] **Step 5: Commit**

```bash
git add shared/services/appyImport.ts shared/services/__tests__/appyImport.test.ts
git commit -m "Derive a form plan from an Appy export"
```

---

### Task 5: Near-miss scoring

Names the closest question an unmatched one nearly hit, for a human to resolve. Never applied automatically.

**Files:**
- Modify: `shared/services/appyImport.ts`
- Modify: `shared/services/__tests__/appyImport.test.ts`

**Interfaces:**
- Consumes: `normalize` from Task 1.
- Produces:
  - `interface NearMiss { questionText: string; closestLabel: string; closestQuestionId: string; score: number }`
  - `findNearMiss(appyQuestionText: string, targetQuestions: Question[]): NearMiss | null`
  - `const NEAR_MISS_FLOOR = 0.6`

- [ ] **Step 1: Write the failing tests**

```ts
import { findNearMiss, NEAR_MISS_FLOOR } from "../appyImport.ts";

Deno.test("findNearMiss catches a wording variant", () => {
  const target = [q("a", "What is your age?"), q("b", "Why do you want to join?")];
  const miss = findNearMiss("What's your age?", target);
  assertEquals(miss?.closestQuestionId, "a");
  assertEquals(miss!.score > NEAR_MISS_FLOOR, true);
});

Deno.test("findNearMiss returns null for something genuinely unrelated", () => {
  assertEquals(findNearMiss("Favourite colour?", [q("a", "What is your age?")]), null);
});

Deno.test("findNearMiss returns null when the list is empty", () => {
  assertEquals(findNearMiss("Anything", []), null);
});

Deno.test("an exact match never surfaces as a near miss", () => {
  const target = [q("a", "What is your age?")];
  const miss = findNearMiss("  what is your AGE? ", target);
  assertEquals(miss, null);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: FAIL — `findNearMiss` is not exported

- [ ] **Step 3: Implement**

```ts
/**
 * Below this, there is no near miss — just an unmatched question. Reporting
 * every distant string as a "did you mean" trains the reader to ignore the
 * column, which defeats the point of having it.
 */
export const NEAR_MISS_FLOOR = 0.6;

export interface NearMiss {
  questionText: string;
  closestLabel: string;
  closestQuestionId: string;
  /** 0..1, higher is closer. */
  score: number;
}

/** Levenshtein distance, iterative with two rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Reports the closest existing question, for a HUMAN to act on.
 *
 * Never wired into matchQuestion. The importer's refusal to fuzzy-match is
 * deliberate — a wrong match silently attributes an answer to the wrong
 * question, and the person who finds out is whoever reads that column of
 * answers months later. This exists so the admin can see that "What is your
 * age?" and "What's your age?" are the same question and fix the wording
 * themselves, before importing.
 *
 * Scored on the same normalize() the exact matcher uses, so a near miss is
 * measured against precisely what the match compared.
 */
export function findNearMiss(
  appyQuestionText: string,
  targetQuestions: { id: string; label: string }[],
): NearMiss | null {
  const a = normalize(appyQuestionText);
  let best: NearMiss | null = null;

  for (const target of targetQuestions) {
    const b = normalize(target.label);
    if (a === b) return null; // an exact match is not a near miss
    const longest = Math.max(a.length, b.length);
    if (longest === 0) continue;
    const score = 1 - editDistance(a, b) / longest;
    if (score > (best?.score ?? 0)) {
      best = {
        questionText: appyQuestionText,
        closestLabel: target.label,
        closestQuestionId: target.id,
        score,
      };
    }
  }

  return best && best.score >= NEAR_MISS_FLOOR ? best : null;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: PASS — 18 tests (14 existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add shared/services/appyImport.ts shared/services/__tests__/appyImport.test.ts
git commit -m "Report the question an unmatched one nearly hit"
```

---

### Task 6: Dry run

The importer opens **one transaction per row**, so a failure at row 400 leaves 399 committed. The dry run is the only chance to see the whole outcome while none of it is real — which is why it must walk the same path, not an approximation.

**Files:**
- Modify: `shared/services/appyImport.ts`
- Modify: `shared/services/__tests__/appyImport.test.ts`

**Interfaces:**
- Consumes: `findNearMiss` (Task 5), `matchQuestion` (Task 1).
- Produces:
  - `interface AppyImportOptions { dryRun?: boolean }`
  - `importAppySubmissions(db, guildId, targetFormId, rows, options?)` — `ImportResult` gains `nearMisses: NearMiss[]`

- [ ] **Step 1: Write the failing test**

The db handle is only used for one query and one transaction, so a hand-built fake is enough and needs no database:

```ts
import { importAppySubmissions } from "../appyImport.ts";

function fakeDb(formQuestions: { id: string; label: string }[]) {
  let transactions = 0;
  const db = {
    query: {
      forms: {
        findFirst: () => Promise.resolve({ id: "f1", guildId: 1n, questions: formQuestions }),
      },
    },
    transaction: (fn: unknown) => {
      transactions++;
      return Promise.resolve(fn);
    },
  };
  return { db: db as never, transactions: () => transactions };
}

Deno.test("dryRun writes nothing", async () => {
  const { db, transactions } = fakeDb([q("a", "Name?")]);
  const result = await importAppySubmissions(db, 1n, "f1", [row([{ question: "Name?", answer: "x" }])], {
    dryRun: true,
  });
  assertEquals(transactions(), 0);
  assertEquals(result.imported, 1);
});

Deno.test("dryRun counts the same rows a real run would", async () => {
  const rows = [
    row([{ question: "Name?", answer: "x" }]),
    { ...row([{ question: "Name?", answer: "y" }]), status: "NONSENSE" } as never,
  ];
  const { db } = fakeDb([q("a", "Name?")]);
  const result = await importAppySubmissions(db, 1n, "f1", rows, { dryRun: true });
  assertEquals(result.imported, 1);
  assertEquals(result.skipped.length, 1);
});

Deno.test("dryRun reports near misses for unmatched questions", async () => {
  const { db } = fakeDb([q("a", "What is your age?")]);
  const result = await importAppySubmissions(db, 1n, "f1", [row([{ question: "What's your age?", answer: "x" }])], {
    dryRun: true,
  });
  assertEquals(result.unmatchedQuestions.length, 1);
  assertEquals(result.nearMisses[0]?.closestQuestionId, "a");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: FAIL — the options parameter does not exist, and `result.nearMisses` is undefined

- [ ] **Step 3: Implement**

Add `nearMisses: NearMiss[]` to `ImportResult` and initialise it to `[]`. Add the options parameter:

```ts
export interface AppyImportOptions {
  /**
   * Walks every check a real import walks — status mapping, BigInt parsing,
   * date validation, question matching — and gates only the write. Not a
   * second code path: an approximation would bless imports that then fail,
   * which is worse than no dry run because it carries authority it has not
   * earned.
   */
  dryRun?: boolean;
}
```

In the loop, after `matchQuestion` returns null, record the near miss alongside the existing unmatched entry:

```ts
      } else {
        result.unmatchedQuestions.push({ appySubmissionId: row.id, questionText: q.question });
        const miss = findNearMiss(q.question, form.questions);
        if (miss && !result.nearMisses.some((m) => m.questionText === miss.questionText)) {
          result.nearMisses.push(miss);
        }
      }
```

Then gate the write, leaving the counter outside so a dry run reports what a real one would:

```ts
    if (!options?.dryRun) {
      await db.transaction(async (tx) => {
        // ...unchanged insert of submission + answers...
      });
    }

    result.imported++;
```

- [ ] **Step 4: Run and confirm pass**

Run: `deno test shared/services/__tests__/appyImport.test.ts`
Expected: PASS — 21 tests (18 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add shared/services/appyImport.ts shared/services/__tests__/appyImport.test.ts
git commit -m "Add a dry run that walks the real path and writes nothing"
```

---

### Task 7: The `appy` custom-id namespace and confirm staging

The dry run's confirm button arrives as a **new interaction** with no attachment, so the parsed rows must survive between the two. `bot/src/interactions/outcomeConfirm.ts` already solves this shape; follow it.

**Files:**
- Modify: `shared/types/index.ts` (`CUSTOM_ID_NAMESPACES`)
- Create: `bot/src/interactions/appyStaging.ts`

**Interfaces:**
- Consumes: `FormPlan` (Task 4), `AppyExportRow` (Task 1).
- Produces:
  - `CUSTOM_ID_NAMESPACES.APPY = "appy"`
  - `stageAppyImport(guildId: bigint, requesterId: bigint, entry: StagedAppyImport): void`
  - `takeAppyImport(guildId: bigint, requesterId: bigint): StagedAppyImport | null`
  - `startAppyStagingSweeper(): void`
  - `interface StagedAppyImport { plan: FormPlan; rows: AppyExportRow[]; expiresAt: number }`

- [ ] **Step 1: Add the namespace**

In `shared/types/index.ts`, add to `CUSTOM_ID_NAMESPACES`:

```ts
  APPY: "appy",
```

and add to the custom-id documentation block above it:

```
//   appy:confirm:<guildId>              -> confirm a derived-form import
//   appy:logchannel:<formId>            -> pick the review channel after import
```

- [ ] **Step 2: Create the staging module**

Create `bot/src/interactions/appyStaging.ts`, modelled on `outcomeConfirm.ts:60-120`:

```ts
// bot/src/interactions/appyStaging.ts
//
// Holds a derived-form import between its dry run and its confirm click.
//
// The confirm button arrives as a NEW interaction carrying only its
// custom_id — no attachment, no way back to the uploaded file. So the parsed
// rows and the plan the admin was shown have to be held somewhere for the
// round trip, exactly as outcomeConfirm.ts does for a review confirmation.
//
// In memory, deliberately, and for the same reason that file gives: a
// dropped entry on restart is harmless, because nothing has been written
// yet — the admin re-runs the command. Putting it in Redis would add a
// network hop to protect a five-minute window that costs one re-upload when
// it is lost.
//
// Holding rows rather than the attachment URL is the other deliberate
// choice: it guarantees the import applies exactly the bytes the dry run
// described. A re-fetch could return a different file, or a URL that has
// expired, and the admin would have approved a plan that no longer matches.
// Row count is capped upstream at 5000, so the entry is bounded.

import type { AppyExportRow, FormPlan } from "../../../shared/services/appyImport.ts";
import { logger } from "../utils/logger.ts";

const STAGING_TTL_MS = 5 * 60_000;
const SWEEP_MS = 60_000;

export interface StagedAppyImport {
  plan: FormPlan;
  rows: AppyExportRow[];
  expiresAt: number;
}

const pending = new Map<string, StagedAppyImport>();

/**
 * Keyed on guild + requester, the two things the button's custom_id and its
 * interaction can supply between them. One pending derivation per admin per
 * guild — a second run replaces the first, which is what someone re-uploading
 * a corrected export expects.
 */
const key = (guildId: bigint, requesterId: bigint) => `${guildId}:${requesterId}`;

export function stageAppyImport(
  guildId: bigint,
  requesterId: bigint,
  entry: Omit<StagedAppyImport, "expiresAt">,
): void {
  pending.set(key(guildId, requesterId), { ...entry, expiresAt: Date.now() + STAGING_TTL_MS });
}

/** Single-use: a double-click must not import the history twice. */
export function takeAppyImport(guildId: bigint, requesterId: bigint): StagedAppyImport | null {
  const k = key(guildId, requesterId);
  const entry = pending.get(k);
  if (!entry) return null;
  pending.delete(k);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

/** Abandoned dry runs are the common case; do not let them hold rows forever. */
export function startAppyStagingSweeper(): void {
  setInterval(() => {
    const now = Date.now();
    let dropped = 0;
    for (const [k, entry] of pending) {
      if (entry.expiresAt < now) {
        pending.delete(k);
        dropped++;
      }
    }
    if (dropped > 0) logger.info("Swept abandoned Appy import stagings", { dropped });
  }, SWEEP_MS);
}
```

- [ ] **Step 3: Start the sweeper**

Find where `startConfirmSweeper()` is called (`grep -rn "startConfirmSweeper" bot/src`) and call `startAppyStagingSweeper()` beside it, matching the surrounding style.

- [ ] **Step 4: Verify**

Run: `deno check -c bot/deno.json bot/src/main.ts` → clean
Run: `cd api && npm run build` → exit 0 (the namespace lives in `shared/`)

- [ ] **Step 5: Commit**

```bash
git add shared/types/index.ts bot/src/interactions/appyStaging.ts bot/src/events
git commit -m "Stage a derived import across its confirm click"
```

---

### Task 8: The autocomplete entry and the dry-run response

**Files:**
- Modify: `bot/src/commands/importAppy.ts`

**Interfaces:**
- Consumes: `deriveFormPlan`, `importAppySubmissions` with `dryRun`, `stageAppyImport`, `CUSTOM_ID_NAMESPACES.APPY`.
- Produces: `const DERIVE_SENTINEL = "__derive__"` — the autocomplete value meaning "create a new form".

- [ ] **Step 1: Add the derivation entry to autocomplete**

In `autocomplete()`, prepend a synthetic choice before the form matches:

```ts
  // Derivation is an entry in the existing list rather than a second
  // command, so the admin never has to know two commands exist. Its value is
  // a sentinel no form name can collide with — form names are varchar(100)
  // of user text, and this is not a plausible one.
  const choices = [
    { name: "➕ Create a new form from this export", value: DERIVE_SENTINEL },
    ...matches.map((m) => ({ name: m.name, value: m.name })),
  ].slice(0, 25);
```

Keep the `type: 8` response exactly as it is — autocomplete has no deferred variant, which is why this file has a dedicated guard-test block.

- [ ] **Step 2: Branch `execute()` on the sentinel**

After the attachment is fetched and parsed, and after the existing owner check:

```ts
  if (applicationName === DERIVE_SENTINEL) {
    // Dry run FIRST, and unconditionally. An admin deriving a form has by
    // definition not seen what the export contains, so showing them before
    // writing is the only order that makes sense. Importing into an existing
    // form keeps dryRun opt-in — that admin already knows their questions.
    const plan = deriveFormPlan(rows, formNameFromFilename(attachment.filename));

    // A name collision is reported, never resolved by overwriting. The
    // existing form may hold history nobody wants merged into.
    const clash = await db.query.forms.findFirst({
      where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, plan.name)),
    });
    if (clash) {
      return finish(
        bot,
        interaction,
        `A form named **${plan.name}** already exists. Rename the export file to change the ` +
          `derived name, or re-run and pick that form to import into it instead.`,
      );
    }

    stageAppyImport(guildId, requester.id, { plan, rows });
    return finish(bot, interaction, renderPlan(plan, rows.length, guildId));
  }
```

Define both helpers in the same file:

```ts
/**
 * Autocomplete value meaning "derive a new form". A sentinel rather than an
 * empty string so it cannot collide with a real form name — names are
 * varchar(100) of user text, and this is not a plausible one.
 */
const DERIVE_SENTINEL = "__derive__";

/** "Staff Application.json" -> "Staff Application", capped at forms.name's 100. */
function formNameFromFilename(filename: string): string {
  const base = filename.replace(/\.json$/i, "").trim();
  return (base.length > 0 ? base : "Imported from Appy").slice(0, 100);
}
```

- [ ] **Step 3: Render the plan**

```ts
/**
 * The dry run's report.
 *
 * The short_text/required line is stated near the top rather than buried,
 * because it is the plan's biggest lie by omission: Appy's export carries no
 * question metadata, so every derived question is a single-line required
 * field regardless of what it actually was. An admin who does not see that
 * before importing discovers it when an applicant tries to write a paragraph
 * into a one-line box.
 */
function renderPlan(plan: FormPlan, rowCount: number, guildId: bigint): InteractionEditPayload {
  const overModal = plan.questions.filter((q) => q.label.length > MODAL_LABEL_MAX).length;
  const truncated = plan.questions.filter((q) => q.truncatedFrom !== undefined);
  const pages = Math.ceil(plan.questions.length / 5);

  const lines = [
    `**${plan.questions.length}** question(s) from **${rowCount}** submission(s). Nothing has been written yet.`,
    "",
    "Every question will be created as a **single-line required** field — Appy's export",
    "carries no type or validation, so that is all it can tell us. Fix the ones that should",
    "be paragraphs in the dashboard afterwards.",
    "",
    ...plan.questions.map((q, i) => {
      const rare = q.seenIn < rowCount ? ` _(in ${q.seenIn} of ${rowCount})_` : "";
      return `${i + 1}. ${q.label}${rare}`;
    }),
  ];

  if (overModal > 0) {
    lines.push(
      "",
      `${overModal} label(s) exceed Discord's ${MODAL_LABEL_MAX}-character modal limit and will be`,
      `shortened when shown in a modal. The form will span ${pages} modal page(s).`,
      "A direct-message form has neither limit, if these questions are long.",
    );
  }
  if (truncated.length > 0) {
    lines.push("", `${truncated.length} label(s) were longer than 200 characters and were cut to fit.`);
  }
  for (const w of plan.warnings) lines.push("", `⚠️ ${w}`);

  return {
    embeds: [{ title: `Preview: ${plan.name}`, description: lines.join("\n"), color: 0x5865f2 }],
    components: plan.questions.length === 0 ? [] : [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: "Create form and import",
        customId: encodeCustomId(CUSTOM_ID_NAMESPACES.APPY, "confirm", guildId.toString()),
      }],
    }],
  };
}
```

The button is omitted when there are no questions — a form with none cannot be applied to, so there is nothing to confirm.

- [ ] **Step 4: Verify**

Run: `deno check -c bot/deno.json bot/src/commands/importAppy.ts` → clean
Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts` → 28 passing, unchanged. This file is in the autocomplete-exception block; if the count or shape changes, stop and report.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/importAppy.ts
git commit -m "Offer form derivation from the import autocomplete, dry run first"
```

---

### Task 9: The confirm handler

**Files:**
- Create: `bot/src/interactions/buttons/appyConfirm.ts`
- Modify: `bot/src/events/interactionCreate.ts` (route the namespace)

**Interfaces:**
- Consumes: `takeAppyImport`, `importAppySubmissions`, `defer`/`finish`.
- Produces: `handleAppyConfirmButton(bot, interaction, guildId: string): Promise<void>`

- [ ] **Step 1: Write the handler**

It must defer first — it creates a form, N questions and up to 5000 submissions:

```ts
export async function handleAppyConfirmButton(
  bot: AppealyBot,
  interaction: Interaction,
  guildIdRaw: string,
) {
  const guildId = interaction.guildId;
  const requester = interaction.member?.user ?? interaction.user;
  if (!guildId || !requester) return;

  // Creating a form, its questions and up to 5000 submissions is far past
  // Discord's three-second window. Defer before the first await.
  await defer(bot, interaction, { ephemeral: true });

  const staged = takeAppyImport(guildId, requester.id);
  if (!staged) {
    return finish(
      bot,
      interaction,
      "That import preview has expired or was already used. Run `/import-appy` again.",
    );
  }

  // Form and questions in one transaction: a form whose questions failed
  // half-way through is worse than no form, because it looks complete in the
  // dashboard. The submission import below is deliberately NOT inside it —
  // it commits per row by design, so a failure at row 400 keeps 399.
  const form = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.forms)
      .values({
        guildId,
        name: staged.plan.name,
        description: "Imported from an Appy export.",
        // Inactive with no review channel: the honest state for a form that
        // is not finished. The activation guard refuses to publish it until
        // the prompt below is answered.
        active: false,
        logChannelId: null,
      })
      .returning();

    if (staged.plan.questions.length > 0) {
      await tx.insert(schema.questions).values(
        staged.plan.questions.map((q) => ({
          formId: created.id,
          label: q.label,
          sortOrder: q.sortOrder,
          // Appy's export states no type, no required flag and no
          // validation, so these are the only defensible defaults. The dry
          // run told the admin this before they pressed the button.
          type: "short_text" as const,
          required: true,
        })),
      );
    }
    return created;
  });

  const result = await importAppySubmissions(db, guildId, form.id, staged.rows);
  return finish(bot, interaction, renderResult(form, result, staged.plan));
}
```

`renderResult` reports imported/skipped counts, any `nearMisses` as *"did you mean"* suggestions for the admin to reconcile, and carries the channel select from Step 3.

`guildIdRaw` from the custom_id is **not** trusted as the guild — `interaction.guildId` is. The custom_id carries it only so the button is scoped to where it was posted.

`forms` has other `NOT NULL` columns with defaults (`applicationType`, `kind`, `grantRoleIds` and the rest). Read the table before writing this insert and supply anything without a default; `deno check` will catch a missing one.

- [ ] **Step 2: Route it**

In `bot/src/events/interactionCreate.ts`'s button-component switch, add a case for the `appy` namespace with action `confirm`, matching how `ticket` and `review` are routed.

- [ ] **Step 3: Respond with the channel select**

The success response carries the prompt, which is Task 10's handler:

```ts
      components: [{
        type: 1,
        components: [{
          type: 8, // ChannelSelect
          customId: encodeCustomId(CUSTOM_ID_NAMESPACES.APPY, "logchannel", form.id),
          placeholder: "Where should submissions be posted for review?",
          channelTypes: [0], // GuildText
          minValues: 1,
          maxValues: 1,
        }],
      }],
```

State plainly in the message that the form is **inactive until a review channel is set**, and that ignoring this is fine — the dashboard will show it.

- [ ] **Step 4: Verify**

Run: `deno check -c bot/deno.json bot/src/main.ts` → clean
Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts` → the new file must be added to `MUST_DEFER` and the count rises by one. State the arithmetic.

- [ ] **Step 5: Commit**

```bash
git add bot/src/interactions/buttons/appyConfirm.ts bot/src/events/interactionCreate.ts bot/src/interactions/__tests__/deferGuard.test.ts
git commit -m "Create the derived form and import its history on confirm"
```

---

### Task 10: The channel-select handler

**Files:**
- Create: `bot/src/interactions/selects/appyLogChannel.ts`
- Modify: `bot/src/events/interactionCreate.ts`

**Interfaces:**
- Consumes: `defer`/`finish`, the activation guard from Task 3.
- Produces: `handleAppyLogChannelSelect(bot, interaction, formId: string): Promise<void>`

- [ ] **Step 1: Write the handler**

Defer, set `logChannelId` on the form (scoped to `interaction.guildId` so a custom_id from another guild cannot target it), and respond offering activation:

```ts
  await defer(bot, interaction, { ephemeral: true });

  const channelId = interaction.data?.values?.[0];
  if (!channelId) return finish(bot, interaction, "No channel was selected.");

  const [updated] = await db
    .update(schema.forms)
    .set({ logChannelId: BigInt(channelId) })
    .where(and(eq(schema.forms.id, formId), eq(schema.forms.guildId, guildId)))
    .returning();

  if (!updated) return finish(bot, interaction, "That form no longer exists.");
```

The reply names the channel and says the form can now be activated from the dashboard.

- [ ] **Step 2: Route it**

Add the select-menu case in `interactionCreate.ts` beside the existing `poll`/`rolemenu` select routing.

- [ ] **Step 3: Verify**

Run: `deno check -c bot/deno.json bot/src/main.ts` → clean
Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts` → add this file to `MUST_DEFER`; count rises by one. State the arithmetic.

- [ ] **Step 4: Commit**

```bash
git add bot/src/interactions/selects/appyLogChannel.ts bot/src/events/interactionCreate.ts bot/src/interactions/__tests__/deferGuard.test.ts
git commit -m "Set the review channel from the post-import prompt"
```

---

### Task 11: Expose the new capabilities on the API route

**Files:**
- Modify: `api/src/routes/migration.ts`

**Interfaces:**
- Consumes: `deriveFormPlan`, `importAppySubmissions` with options.
- Produces: `POST /api/guilds/:guildId/migrate/appy-submissions` accepts `dryRun?: boolean`; `POST .../migrate/appy-derive` returns a `FormPlan`.

- [ ] **Step 1: Add `dryRun` to the existing route**

Extend `importSchema`:

```ts
const importSchema = z.object({
  targetFormId: z.string(),
  rows: z.array(appyRowSchema).min(1).max(5000),
  dryRun: z.boolean().optional(),
});
```

and pass it through to `importAppySubmissions`.

- [ ] **Step 2: Add the derivation preview route**

```ts
// Preview only. Returns the plan and writes nothing, so the dashboard can
// show the same thing the bot's dry run shows before anyone commits.
migrationRouter.post("/migrate/appy-derive", requireOwnerAccess, async (req, res) => {
  const parsed = z.object({
    name: z.string().min(1).max(100),
    rows: z.array(appyRowSchema).min(1).max(5000),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  res.json(deriveFormPlan(parsed.data.rows, parsed.data.name));
});
```

Match the file's existing route and error style — read the neighbouring handler first.

- [ ] **Step 3: Verify**

Run: `cd api && npm run build` → exit 0

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/migration.ts
git commit -m "Expose the dry run and derivation preview on the migration route"
```

---

### Task 12: Update the documentation

`README.md:376-427` describes the data-portability surface and currently states that the importer does not recreate a form. That is about to be false.

**Files:**
- Modify: `README.md` (the "Data portability" section)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Rewrite the section**

State what is now true: `/import-appy` either imports into an existing form or derives a new one from the export; derivation shows a dry run before writing; derived questions are all `short_text` and required because Appy's export carries no metadata; a derived form starts inactive with no review channel and cannot be activated until one is set.

Keep the existing note that Appy's export has no reviewer data.

- [ ] **Step 2: Check for other stale claims**

Run: `grep -rn "does not attempt to recreate\|recreate a form" --include=*.md --include=*.ts . | grep -v node_modules`

Fix every hit. The consolidated `shared/services/appyImport.ts` header still carries the original claim from the file it was moved from.

- [ ] **Step 3: Commit**

```bash
git add README.md shared/services/appyImport.ts
git commit -m "Document that the importer can now derive a form"
```

---

## Verification before calling this done

- [ ] `deno test shared/services/__tests__/` — 21 passing (4 matcher + 4 activation guard + 6 derivation + 4 near-miss + 3 dry run)
- [ ] `deno test --allow-read -c bot/deno.json bot/src/` — 39 + 2 new guard entries
- [ ] `deno check -c bot/deno.json bot/src/main.ts` — clean
- [ ] `cd api && npm run build` — exit 0
- [ ] `cd web && npm run build` — exit 0
- [ ] Migration `0009` contains exactly one `DROP NOT NULL` and no destructive statement

Manual, on a real guild, since no automated test reaches Discord:

- [ ] `/import-appy` → pick **➕ Create a new form from this export** → the dry run lists questions in order and states that all will be short_text and required, and nothing exists in the dashboard yet
- [ ] Press **Create form and import** → the form appears, inactive, with its questions in the right order and the history attached
- [ ] The channel prompt appears; pick a channel → the form reports it can be activated
- [ ] Run it again and **ignore** the prompt → the form sits inactive, and the dashboard shows it needs a review channel
- [ ] Try to activate that form from the dashboard → refused with `form_missing_log_channel`
- [ ] `/import-appy` against an **existing** form → behaves exactly as it did before this plan
