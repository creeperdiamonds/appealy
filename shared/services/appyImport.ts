// shared/services/appyImport.ts
//
// Imports a submissions history export from Appy (a different, closed-source
// Discord application bot) into an existing Appealy form.
//
// Consolidated from the mirrored pair that used to live at
// bot/src/services/appyImportService.ts and api/src/services/appyImportService.ts,
// following dataExport.ts into shared/. Both runtimes now import this one
// module and pass their own db handle, so the two copies can no longer drift
// — and, just as importantly, the decision logic is reachable by `deno test`,
// which the API has no runner for.
//
// Confirmed export shape, built against a real sample:
//
//   [{
//     id: string,                 // Appy's own submission ID
//     applicationId: string,      // Appy's form ID — not reused, single-form scope
//     userId: string,             // Discord snowflake, as a string
//     status: "ACCEPTED" | "DENIED" | "PENDING",
//     createdAt: string,          // ISO 8601
//     questions: [{ question: string, answer: string }],
//     submissionDuration: number  // seconds
//   }]
//
// Notably absent from Appy's export: reviewer identity, review reason, and any
// question-definition metadata (type, required, validation) — only the question
// TEXT as it appeared at submission time. So this does not recreate a form; the
// admin builds the target Appealy form first and this imports history into it,
// matching each historical question by text.

import { and, eq, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/schema.ts";

type Db = PostgresJsDatabase<typeof schema>;

const STATUS_MAP: Record<string, typeof schema.submissions.$inferInsert["status"]> = {
  ACCEPTED: "accepted",
  DENIED: "denied",
  PENDING: "pending",
};

/**
 * Hard limit on rows accepted in a single import call.
 *
 * The API enforced this via zod and the slash command enforced nothing, so a
 * 25 MB attachment could carry an unbounded number of rows into the bot. Both
 * paths now share this constant.
 *
 * Note this bounds ONE call, which is why it is not the real ceiling — see
 * importedSubmissionCeiling in shared/schema/pricing.ts for the per-guild
 * bound that a hundred separate files cannot route around.
 */
export const MAX_IMPORT_ROWS = 5_000;

/** Rows per transaction. See the loop in importAppySubmissions. */
const CHUNK_SIZE = 200;

export interface AppyExportRow {
  id: string;
  applicationId: string;
  userId: string;
  status: string;
  createdAt: string;
  questions: { question: string; answer: string }[];
  submissionDuration?: number;
}

/** Just enough of a question row for matching, so tests need not build full rows. */
export interface QuestionLike {
  id: string;
  label: string;
}

export interface PlannedSubmission {
  importSourceId: string;
  applicantId: bigint;
  status: typeof schema.submissions.$inferInsert["status"];
  createdAt: Date;
  completionSeconds: number | null;
  answers: { questionId: string; value: string }[];
}

export interface CeilingExceeded {
  /** Imported rows this form already holds. */
  stored: number;
  /** Rows this import would newly add. */
  incoming: number;
  /** historyRetentionDays * submissionsPerDay for the guild's tier. */
  ceiling: number;
}

export interface AppyImportPlan {
  toInsert: PlannedSubmission[];
  /** Rows already present from an earlier import. Not an error — the point of idempotency. */
  alreadyImported: number;
  skipped: { appySubmissionId: string; reason: string }[];
  unmatchedQuestions: { appySubmissionId: string; questionText: string }[];
  /** Set when the import is refused wholesale; toInsert is empty when present. */
  ceilingExceeded?: CeilingExceeded;
}

export interface ImportResult {
  imported: number;
  alreadyImported: number;
  skipped: { appySubmissionId: string; reason: string }[];
  unmatchedQuestions: { appySubmissionId: string; questionText: string }[];
  ceilingExceeded?: CeilingExceeded;
}

/**
 * Exported, though only this file calls it today: the near-miss scorer in the
 * Appy migration plan has to measure against the SAME normalisation the exact
 * matcher uses, or it would report near misses that are really exact matches
 * and vice versa.
 */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Matches an Appy question's free-text label against the target form's real
 * questions. Exact match (after trim/case/whitespace normalization) only; no
 * fuzzy or partial fallback is attempted, because a wrong match silently
 * attributing an answer to the wrong question is worse than an honestly
 * unmatched one. Ambiguity is surfaced, never guessed at.
 */
export function matchQuestion(
  appyQuestionText: string,
  questions: QuestionLike[],
): QuestionLike | null {
  const normalized = normalize(appyQuestionText);
  return questions.find((q) => normalize(q.label) === normalized) ?? null;
}

/**
 * Decides what an import would do, without touching the database.
 *
 * Pure on purpose: every rule that can reject, dedupe or refuse a row is
 * decided here, so it can be tested directly rather than through a live
 * Postgres. importAppySubmissions below is then only IO.
 */
export function planAppyImport(opts: {
  rows: AppyExportRow[];
  questions: QuestionLike[];
  /** Import source ids this form already holds. */
  alreadyImportedIds: ReadonlySet<string>;
  /** Ceiling from importedSubmissionCeiling(caps). */
  ceiling: number;
}): AppyImportPlan {
  const { rows, questions, alreadyImportedIds, ceiling } = opts;

  const plan: AppyImportPlan = {
    toInsert: [],
    alreadyImported: 0,
    skipped: [],
    unmatchedQuestions: [],
  };

  // Guards against a file that repeats a row, which the database's partial
  // unique index would otherwise reject mid-chunk.
  const seenInFile = new Set<string>();

  for (const row of rows) {
    const sourceId = String(row.id ?? "").trim();
    if (!sourceId) {
      // Without an id there is no way to recognise this row on a re-import,
      // so accepting it would reintroduce exactly the duplication this
      // column exists to prevent. Surfaced rather than silently imported.
      plan.skipped.push({ appySubmissionId: "(missing)", reason: "row has no id, so it cannot be safely re-imported" });
      continue;
    }

    if (seenInFile.has(sourceId)) {
      plan.skipped.push({ appySubmissionId: sourceId, reason: "duplicate id within this file" });
      continue;
    }
    seenInFile.add(sourceId);

    if (alreadyImportedIds.has(sourceId)) {
      plan.alreadyImported++;
      continue;
    }

    const status = STATUS_MAP[row.status];
    if (!status) {
      plan.skipped.push({ appySubmissionId: sourceId, reason: `unrecognized status "${row.status}"` });
      continue;
    }

    let applicantId: bigint;
    try {
      applicantId = BigInt(row.userId);
    } catch {
      plan.skipped.push({ appySubmissionId: sourceId, reason: "invalid userId" });
      continue;
    }

    const createdAt = new Date(row.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      plan.skipped.push({ appySubmissionId: sourceId, reason: "invalid createdAt" });
      continue;
    }

    const answers: { questionId: string; value: string }[] = [];
    for (const q of row.questions ?? []) {
      const match = matchQuestion(q.question, questions);
      if (match) {
        answers.push({ questionId: match.id, value: q.answer });
      } else {
        plan.unmatchedQuestions.push({ appySubmissionId: sourceId, questionText: q.question });
      }
    }

    plan.toInsert.push({
      importSourceId: sourceId,
      applicantId,
      status,
      createdAt,
      completionSeconds: row.submissionDuration ?? null,
      answers,
    });
  }

  // Checked against rows already stored, not against this call alone —
  // otherwise a hundred separate files would each pass their own check and
  // the bound would mean nothing.
  //
  // Refused wholesale rather than truncated. Importing "the newest 800 of
  // your 4,000" silently discards real applicant history, and the kind of
  // loss people discover months later is worse than an import that fails
  // loudly on the day with a number and a remedy attached.
  const stored = alreadyImportedIds.size;
  if (stored + plan.toInsert.length > ceiling) {
    plan.ceilingExceeded = { stored, incoming: plan.toInsert.length, ceiling };
    plan.toInsert = [];
  }

  return plan;
}

/**
 * Imports Appy submission history into an existing Appealy form.
 *
 * Idempotent: re-running with the same file imports nothing the second time
 * and reports the rows as already imported. That makes re-uploading the file
 * the CORRECT recovery from a partial failure, which is what the command's
 * error message has always told people to do.
 */
export async function importAppySubmissions(
  db: Db,
  guildId: bigint,
  targetFormId: string,
  rows: AppyExportRow[],
  opts: { ceiling: number },
): Promise<ImportResult> {
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, targetFormId), eq(schema.forms.guildId, guildId)),
    with: { questions: true },
  });
  if (!form) {
    throw new Error("target_form_not_found");
  }

  const existing = await db
    .select({ importSourceId: schema.submissions.importSourceId })
    .from(schema.submissions)
    .where(and(
      eq(schema.submissions.formId, targetFormId),
      isNotNull(schema.submissions.importSourceId),
    ));

  const alreadyImportedIds = new Set(
    existing.map((r) => r.importSourceId).filter((v): v is string => v !== null),
  );

  const plan = planAppyImport({
    rows,
    questions: form.questions,
    alreadyImportedIds,
    ceiling: opts.ceiling,
  });

  const result: ImportResult = {
    imported: 0,
    alreadyImported: plan.alreadyImported,
    skipped: plan.skipped,
    unmatchedQuestions: plan.unmatchedQuestions,
    ceilingExceeded: plan.ceilingExceeded,
  };
  if (plan.ceilingExceeded) return result;

  // Chunked rather than one transaction per row. The previous shape opened a
  // transaction and ran one or two queries for EVERY submission, so a 5,000
  // row history meant 5,000 sequential transactions — slow enough to threaten
  // even the fifteen minutes a deferred interaction buys.
  //
  // Chunks rather than one big transaction so partial progress still survives
  // a mid-import failure, exactly as it did before. What changed is that
  // resuming is now safe.
  for (let i = 0; i < plan.toInsert.length; i += CHUNK_SIZE) {
    const chunk = plan.toInsert.slice(i, i + CHUNK_SIZE);

    await db.transaction(async (tx) => {
      // onConflictDoNothing is the race guard: two imports running at once
      // both pass the in-application duplicate check, and the partial unique
      // index is what actually stops the second one. Without this the second
      // import would throw instead of no-opping.
      const inserted = await tx
        .insert(schema.submissions)
        .values(chunk.map((p) => ({
          formId: targetFormId,
          guildId,
          applicantId: p.applicantId,
          status: p.status,
          createdAt: p.createdAt,
          completionSeconds: p.completionSeconds,
          importSourceId: p.importSourceId,
          // Appy's export carries no reviewer or reason data — left null
          // rather than invented. reviewedAt likewise: we know when the
          // application was submitted, never when it was decided, and a
          // guessed reviewedAt would misrepresent the historical record.
        })))
        .onConflictDoNothing()
        .returning({ id: schema.submissions.id, importSourceId: schema.submissions.importSourceId });

      // Mapped by importSourceId rather than by position: RETURNING omits
      // conflicting rows, so the returned array does not line up with the
      // input once anything is skipped.
      const bySourceId = new Map(chunk.map((p) => [p.importSourceId, p]));
      const answerRows: { submissionId: string; questionId: string; value: string }[] = [];
      for (const row of inserted) {
        const planned = row.importSourceId ? bySourceId.get(row.importSourceId) : undefined;
        if (!planned) continue;
        for (const a of planned.answers) {
          answerRows.push({ submissionId: row.id, questionId: a.questionId, value: a.value });
        }
      }

      if (answerRows.length > 0) {
        await tx.insert(schema.answers).values(answerRows);
      }

      result.imported += inserted.length;
      // Anything the database refused was inserted by a concurrent import
      // between the read above and this write. Counted as already imported,
      // because that is what it is.
      result.alreadyImported += chunk.length - inserted.length;
    });
  }

  return result;
}
