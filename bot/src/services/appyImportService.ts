// bot/src/services/appyImportService.ts
//
// Imports a submissions history export from Appy (a different, closed-
// source Discord application bot) into an existing Appealy form. Built
// against a real sample export shared by the person building this
// project, confirmed shape:
//
//   [{
//     id: string,                 // Appy's own submission ID — not reused
//     applicationId: string,      // Appy's form ID — not reused, single-form scope
//     userId: string,             // Discord snowflake, as a string
//     status: "ACCEPTED" | "DENIED" | "PENDING",
//     createdAt: string,          // ISO 8601
//     questions: [{ question: string, answer: string }],
//     submissionDuration: number  // seconds
//   }]
//
// Notably absent from Appy's export: reviewer identity, review reason,
// and any question-definition metadata (type, required, validation) —
// only the question TEXT as it appeared at submission time. Because of
// that, this importer does not attempt to recreate a form from scratch;
// the admin picks or creates the target Appealy form themselves through
// the normal dashboard/command flow first, and this only imports
// submission HISTORY into it, matching each historical question by text
// against that form's real questions.

import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";

const STATUS_MAP: Record<string, typeof schema.submissions.$inferInsert["status"]> = {
  ACCEPTED: "accepted",
  DENIED: "denied",
  PENDING: "pending",
};

export interface AppyExportRow {
  id: string;
  applicationId: string;
  userId: string;
  status: string;
  createdAt: string;
  questions: { question: string; answer: string }[];
  submissionDuration?: number;
}

export interface ImportResult {
  imported: number;
  skipped: { appySubmissionId: string; reason: string }[];
  unmatchedQuestions: { appySubmissionId: string; questionText: string }[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Matches an Appy question's free-text label against the target form's
 * real questions. Exact match (after trim/case/whitespace normalization)
 * first; if nothing matches exactly, no fuzzy/partial match is attempted
 * — a wrong match silently attributing an answer to the wrong question is
 * worse than an honestly-unmatched one, so ambiguity is surfaced to the
 * importer rather than guessed at.
 */
function matchQuestion(
  appyQuestionText: string,
  targetQuestions: (typeof schema.questions.$inferSelect)[],
): (typeof schema.questions.$inferSelect) | null {
  const normalized = normalize(appyQuestionText);
  return targetQuestions.find((q) => normalize(q.label) === normalized) ?? null;
}

export async function importAppySubmissions(
  guildId: bigint,
  targetFormId: string,
  rows: AppyExportRow[],
): Promise<ImportResult> {
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, targetFormId), eq(schema.forms.guildId, guildId)),
    with: { questions: true },
  });
  if (!form) {
    throw new Error("target_form_not_found");
  }

  const result: ImportResult = { imported: 0, skipped: [], unmatchedQuestions: [] };

  for (const row of rows) {
    const status = STATUS_MAP[row.status];
    if (!status) {
      result.skipped.push({ appySubmissionId: row.id, reason: `unrecognized status "${row.status}"` });
      continue;
    }

    let applicantId: bigint;
    try {
      applicantId = BigInt(row.userId);
    } catch {
      result.skipped.push({ appySubmissionId: row.id, reason: "invalid userId" });
      continue;
    }

    const createdAt = new Date(row.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      result.skipped.push({ appySubmissionId: row.id, reason: "invalid createdAt" });
      continue;
    }

    const matchedAnswers: { questionId: string; value: string }[] = [];
    for (const q of row.questions ?? []) {
      const match = matchQuestion(q.question, form.questions);
      if (match) {
        matchedAnswers.push({ questionId: match.id, value: q.answer });
      } else {
        result.unmatchedQuestions.push({ appySubmissionId: row.id, questionText: q.question });
      }
    }

    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.submissions)
        .values({
          formId: targetFormId,
          guildId,
          applicantId,
          status,
          createdAt,
          completionSeconds: row.submissionDuration ?? null,
          // Appy's export has no reviewer/reason data — left null rather
          // than invented. reviewedAt likewise left null: we don't know
          // when the decision was actually made, only when it was
          // submitted, and guessing a reviewedAt would misrepresent the
          // historical record.
        })
        .returning();

      if (matchedAnswers.length > 0) {
        await tx.insert(schema.answers).values(
          matchedAnswers.map((a) => ({ submissionId: created.id, questionId: a.questionId, value: a.value })),
        );
      }
    });

    result.imported++;
  }

  return result;
}
