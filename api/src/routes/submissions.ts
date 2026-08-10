// api/src/routes/submissions.ts
// Read-mostly routes for the dashboard's review queue view. Actual
// accept/deny actions stay in the bot (they require posting to Discord,
// role changes, DMs) — this surface is for browsing history and manual
// housekeeping (e.g. withdrawing a stale submission).

import { Router } from "express";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess } from "../middleware/guildAccess.ts";
import type { SubmissionDTO } from "../../../shared/types/index.ts";

export const submissionsRouter = Router({ mergeParams: true });

const listQuerySchema = z.object({
  formId: z.string().optional(),
  status: z.enum(["pending", "accepted", "denied", "withdrawn"]).optional(),
  applicantId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

submissionsRouter.use(requireGuildAccess);

submissionsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  const { formId, status, applicantId, limit, offset } = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const conditions = [eq(schema.submissions.guildId, guildId)];
  if (formId) conditions.push(eq(schema.submissions.formId, formId));
  if (status) conditions.push(eq(schema.submissions.status, status));
  if (applicantId) conditions.push(eq(schema.submissions.applicantId, BigInt(applicantId)));

  const rows = await db.query.submissions.findMany({
    where: and(...conditions),
    orderBy: desc(schema.submissions.createdAt),
    limit,
    offset,
    with: { answers: { with: { question: true } } },
  });

  res.json(rows.map(toDTO));
});

submissionsRouter.get("/:submissionId", async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const submission = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, req.params.submissionId), eq(schema.submissions.guildId, guildId)),
    with: { answers: { with: { question: true } } },
  });
  if (!submission) return res.status(404).json({ error: "submission_not_found" });
  res.json(toDTO(submission));
});

// Manual withdrawal — e.g. staff clean-up of a duplicate/stale pending
// submission without going through Discord. Does NOT touch Discord roles
// or send DMs; those side effects only happen via the bot's accept/deny
// buttons, which is the intended path for real decisions.
submissionsRouter.post("/:submissionId/withdraw", async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const [updated] = await db
    .update(schema.submissions)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(schema.submissions.id, req.params.submissionId),
        eq(schema.submissions.guildId, guildId),
        eq(schema.submissions.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return res.status(404).json({ error: "submission_not_found_or_not_pending" });
  res.json({ status: "withdrawn" });
});

function toDTO(
  submission: typeof schema.submissions.$inferSelect & {
    answers: ((typeof schema.answers.$inferSelect) & { question: typeof schema.questions.$inferSelect })[];
  },
): SubmissionDTO {
  return {
    id: submission.id,
    formId: submission.formId,
    applicantId: submission.applicantId.toString(),
    status: submission.status,
    reviewerId: submission.reviewerId?.toString() ?? null,
    reviewReason: submission.reviewReason,
    reviewedAt: submission.reviewedAt?.toISOString() ?? null,
    createdAt: submission.createdAt.toISOString(),
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      label: a.question.label,
      value: a.value,
    })),
  };
}
