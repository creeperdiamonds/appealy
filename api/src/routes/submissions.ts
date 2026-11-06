// api/src/routes/submissions.ts
// The dashboard's Applications page: the queue, one application's answers and
// history, and accepting or denying it. A decision is carried out by the bot
// (bot/src/services/reviewDecision.ts), the same code the Accept and Deny
// buttons in Discord run, because it needs Discord: roles, DMs, the review
// post. Whether this person may decide this form is checked there too, from
// their roles in the server.

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and, desc, asc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import { botCallFailure, decideSubmission, resolveUsers, reviewOptions } from "../services/botBridge.ts";
import { requireGuildAccess } from "../middleware/guildAccess.ts";
import type { SubmissionDTO } from "../../../shared/types/index.ts";

export const submissionsRouter = Router({ mergeParams: true });

const listQuerySchema = z.object({
  formId: z.string().optional(),
  status: z.enum(["pending", "accepted", "denied", "withdrawn"]).optional(),
  applicantId: z.string().regex(/^\d{17,20}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

submissionsRouter.use(requireGuildAccess);

submissionsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });
  const { formId, status, applicantId, limit, offset } = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

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

  // Names and faces for the applicants, resolved now and not stored. One
  // call for the page, cached on the bot's side; if it fails the list still
  // loads and shows IDs.
  const resolved = await resolveUsers([...new Set(rows.map((r) => r.applicantId.toString()))]);
  const byId = new Map(resolved.map((u) => [u.id, { username: u.username, avatarUrl: u.avatarUrl }]));
  res.json(rows.map((r) => ({ ...toDTO(r), applicant: byId.get(r.applicantId.toString()) })));
});

submissionsRouter.get("/:submissionId", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const submission = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, routeParams(req).submissionId), eq(schema.submissions.guildId, guildId)),
    with: { answers: { with: { question: true } } },
  });
  if (!submission) return res.status(404).json({ error: "submission_not_found" });
  res.json(toDTO(submission));
});

// Everything that has happened to one application, oldest first.
//
// The submission row answers "where does this stand" and is overwritten on
// every change; this answers "what happened to it", which is the question an
// owner actually asks — why is the application I remember as pending now
// denied, and who denied it.
//
// Actor ids only. Names and avatars are resolved when the page is read (see
// the table comment in shared/schema/schema.ts): storing them would mean
// keeping Discord profile data indefinitely, which is more than
// site/privacy.html says this service holds.
submissionsRouter.get("/:submissionId/events", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);

  // Scoped by guild as well as id, so a submission id from another server
  // cannot be read by guessing it.
  const submission = await db.query.submissions.findFirst({
    where: and(
      eq(schema.submissions.id, routeParams(req).submissionId),
      eq(schema.submissions.guildId, guildId),
    ),
    columns: { id: true },
  });
  if (!submission) return res.status(404).json({ error: "submission_not_found" });

  const events = await db.query.submissionEvents.findMany({
    where: eq(schema.submissionEvents.submissionId, submission.id),
    orderBy: [asc(schema.submissionEvents.createdAt)],
    limit: 200,
  });

  // Resolved once per distinct actor, not once per event: the same reviewer
  // usually appears several times in one history, and a lookup keyed by id
  // sends each name and avatar once instead of repeating them.
  //
  // Nothing is stored — see the submission_events comment in
  // shared/schema/schema.ts. An id that cannot be resolved is simply absent,
  // and the dashboard shows the raw id rather than inventing a name.
  const actorIds = [...new Set(events.map((e) => e.actorId?.toString()).filter(Boolean))] as string[];
  const resolved = await resolveUsers(actorIds);
  const actors: Record<string, { username: string; avatarUrl: string }> = {};
  for (const u of resolved) actors[u.id] = { username: u.username, avatarUrl: u.avatarUrl };

  res.json({
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      // Null means the system acted — the applicant left and the form was set
      // to auto-deny. The dashboard renders that as "Appealy", not as a blank.
      actorId: e.actorId?.toString() ?? null,
      detail: e.detail ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    actors,
  });
});

// What the signed-in person may do with this application: whether they can
// review it, and which outcomes they may pick. Asked when it's opened, so the
// page only shows buttons that will work.
submissionsRouter.get("/:submissionId/review-options", async (req, res) => {
  try {
    res.json(await reviewOptions(routeParams(req).guildId, routeParams(req).submissionId, req.userId!.toString()));
  } catch (err) {
    res.status(502).json(botCallFailure(err));
  }
});

const decisionSchema = z.object({
  decision: z.enum(["accept", "deny"]),
  outcomeId: z.string().max(64).optional(),
  reason: z.string().max(1000).optional(),
});

submissionsRouter.post("/:submissionId/decide", async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  try {
    const result = await decideSubmission({
      guildId: routeParams(req).guildId,
      submissionId: routeParams(req).submissionId,
      userId: req.userId!.toString(),
      ...parsed.data,
    });
    // A refusal (no permission, already decided) is an answer, not a failure:
    // 200 either way, and the page shows the message.
    res.json(result);
  } catch (err) {
    res.status(502).json(botCallFailure(err));
  }
});

// Manual withdrawal — e.g. staff clean-up of a duplicate/stale pending
// submission without going through Discord. Does NOT touch Discord roles
// or send DMs; those side effects only happen via the bot's accept/deny
// buttons, which is the intended path for real decisions.
submissionsRouter.post("/:submissionId/withdraw", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const [updated] = await db
    .update(schema.submissions)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(schema.submissions.id, routeParams(req).submissionId),
        eq(schema.submissions.guildId, guildId),
        eq(schema.submissions.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return res.status(404).json({ error: "submission_not_found_or_not_pending" });

  // Written here rather than through the bot's helper: this route is the api,
  // and a withdraw never reaches the bot at all. Failure is swallowed for the
  // same reason it is there — the withdrawal has already happened, and an
  // error now would tell the person their action failed when it did not.
  try {
    await db.insert(schema.submissionEvents).values({
      guildId,
      submissionId: routeParams(req).submissionId,
      actorId: req.userId!,
      action: "withdrawn",
    });
  } catch (err) {
    logger.error("Failed to record a withdraw event; the history will have a hole", {
      submissionId: routeParams(req).submissionId,
      error: String(err),
    });
  }

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
    // A snapshot, not a join — see shared/schema/outcomes.ts. "Accepted as
    // Moderator" has to stay true after that outcome is renamed or deleted,
    // which is exactly why the dashboard should show it rather than re-deriving.
    outcomeLabel: submission.outcomeLabel ?? null,
    completionSeconds: submission.completionSeconds ?? null,
    createdAt: submission.createdAt.toISOString(),
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      label: a.question.label,
      value: a.value,
    })),
  };
}
