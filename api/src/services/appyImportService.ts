// api/src/services/appyImportService.ts
// API-side counterpart to bot/src/services/appyImportService.ts — see that
// file's header for the confirmed Appy export shape and matching rationale.
// Mirrored rather than shared for the same Deno/Node split reason as
// dataExportService.ts.

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

function matchQuestion(appyQuestionText: string, targetQuestions: (typeof schema.questions.$inferSelect)[]) {
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
  if (!form) throw new Error("target_form_not_found");

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
