// shared/services/__tests__/appyImport.test.ts
//
// Run with: deno test shared/services/__tests__/appyImport.test.ts
//
// Guards the rules that decide what an Appy import writes. These matter more
// than most: the import is a bulk write of historical data attributed to real
// applicants, it has no undo, and before importSourceId existed it was not
// idempotent — so the obvious recovery from a partial failure, re-uploading
// the same file, silently duplicated every row that had already succeeded.
//
// planAppyImport is pure precisely so these cases can be asserted without a
// live Postgres. The API has no test runner at all, which is the other reason
// this logic lives in shared/.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planAppyImport, type AppyExportRow, type QuestionLike } from "../appyImport.ts";

const QUESTIONS: QuestionLike[] = [
  { id: "q-age", label: "How old are you?" },
  { id: "q-why", label: "Why do you want to join?" },
];

function row(over: Partial<AppyExportRow> = {}): AppyExportRow {
  return {
    id: "appy-1",
    applicationId: "app-1",
    userId: "123456789012345678",
    status: "ACCEPTED",
    createdAt: "2026-01-15T10:00:00.000Z",
    questions: [{ question: "How old are you?", answer: "21" }],
    ...over,
  };
}

const NO_EXISTING = new Set<string>();
const HUGE = 1_000_000;

Deno.test("imports a clean row and resolves its question by text", () => {
  const plan = planAppyImport({
    rows: [row()],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.length, 1);
  assertEquals(plan.toInsert[0].importSourceId, "appy-1");
  assertEquals(plan.toInsert[0].status, "accepted");
  assertEquals(plan.toInsert[0].answers, [{ questionId: "q-age", value: "21" }]);
  assertEquals(plan.skipped, []);
});

Deno.test("question matching ignores case and collapsed whitespace", () => {
  const plan = planAppyImport({
    rows: [row({ questions: [{ question: "  HOW   OLD are   you?  ", answer: "30" }] })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert[0].answers, [{ questionId: "q-age", value: "30" }]);
  assertEquals(plan.unmatchedQuestions, []);
});

Deno.test("an unmatched question is surfaced, and the submission still imports", () => {
  const plan = planAppyImport({
    rows: [row({ questions: [{ question: "What is your timezone?", answer: "UTC" }] })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.length, 1);
  assertEquals(plan.toInsert[0].answers, []);
  assertEquals(plan.unmatchedQuestions, [
    { appySubmissionId: "appy-1", questionText: "What is your timezone?" },
  ]);
});

// The whole reason importSourceId exists.
Deno.test("re-importing the same file inserts nothing the second time", () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];

  const first = planAppyImport({
    rows,
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });
  assertEquals(first.toInsert.length, 2);

  const second = planAppyImport({
    rows,
    questions: QUESTIONS,
    alreadyImportedIds: new Set(first.toInsert.map((p) => p.importSourceId)),
    ceiling: HUGE,
  });
  assertEquals(second.toInsert.length, 0);
  assertEquals(second.alreadyImported, 2);
  assertEquals(second.skipped, []);
});

// Recovering from a partial failure is the case that used to corrupt data:
// half the rows landed, the user re-uploaded, and the landed half duplicated.
Deno.test("resuming a partial import inserts only the rows that are missing", () => {
  const plan = planAppyImport({
    rows: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
    questions: QUESTIONS,
    alreadyImportedIds: new Set(["a", "b"]),
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.map((p) => p.importSourceId), ["c"]);
  assertEquals(plan.alreadyImported, 2);
});

Deno.test("a file repeating one id imports it once", () => {
  const plan = planAppyImport({
    rows: [row({ id: "dup" }), row({ id: "dup" })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.length, 1);
  assertEquals(plan.skipped, [
    { appySubmissionId: "dup", reason: "duplicate id within this file" },
  ]);
});

Deno.test("a row with no id is skipped rather than imported unrecognisably", () => {
  const plan = planAppyImport({
    rows: [row({ id: "" })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.length, 0);
  assertEquals(plan.skipped.length, 1);
  assertEquals(plan.skipped[0].appySubmissionId, "(missing)");
});

Deno.test("malformed rows are skipped individually, not fatally", () => {
  const plan = planAppyImport({
    rows: [
      row({ id: "bad-status", status: "ARCHIVED" }),
      row({ id: "bad-user", userId: "not-a-snowflake" }),
      row({ id: "bad-date", createdAt: "the fifth of never" }),
      row({ id: "good" }),
    ],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: HUGE,
  });

  assertEquals(plan.toInsert.map((p) => p.importSourceId), ["good"]);
  assertEquals(plan.skipped.map((s) => s.appySubmissionId), ["bad-status", "bad-user", "bad-date"]);
});

Deno.test("an import within the ceiling is allowed", () => {
  const plan = planAppyImport({
    rows: [row({ id: "a" }), row({ id: "b" })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: 2,
  });

  assertEquals(plan.toInsert.length, 2);
  assertEquals(plan.ceilingExceeded, undefined);
});

Deno.test("an over-ceiling import is refused whole, never truncated", () => {
  const plan = planAppyImport({
    rows: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
    questions: QUESTIONS,
    alreadyImportedIds: NO_EXISTING,
    ceiling: 2,
  });

  assertEquals(plan.toInsert, []);
  assertEquals(plan.ceilingExceeded, { stored: 0, incoming: 3, ceiling: 2 });
});

// The bound is on what the guild HOLDS, not on one call — otherwise a hundred
// separate files would each pass their own check and bound nothing.
Deno.test("the ceiling counts rows already stored, not just this call", () => {
  const plan = planAppyImport({
    rows: [row({ id: "new" })],
    questions: QUESTIONS,
    alreadyImportedIds: new Set(["old-1", "old-2"]),
    ceiling: 2,
  });

  assertEquals(plan.toInsert, []);
  assertEquals(plan.ceilingExceeded, { stored: 2, incoming: 1, ceiling: 2 });
});

// Idempotency must not be defeated by the ceiling: re-running an import that
// exactly fills the ceiling adds nothing, so it must not now be refused.
Deno.test("re-running an import that exactly fills the ceiling is not refused", () => {
  const plan = planAppyImport({
    rows: [row({ id: "a" }), row({ id: "b" })],
    questions: QUESTIONS,
    alreadyImportedIds: new Set(["a", "b"]),
    ceiling: 2,
  });

  assertEquals(plan.ceilingExceeded, undefined);
  assertEquals(plan.alreadyImported, 2);
});
