// api/src/routes/ops.ts
//
// Operator surface. Every route is behind requireOpsUser, which is behind
// requireSession — see the mount in api/src/app.ts.
//
// Nothing here may be reachable by a normal dashboard user, so resist moving a
// "read-only" endpoint out to save a click. Ban evidence and internal notes
// are exactly the things that shouldn't be enumerable.

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { acceptAppeal } from "./platformAppeals.ts";
import { publishBanChange } from "../middleware/banGate.ts";
import { toPublicBan } from "../../../shared/schema/platformBans.ts";
import { env } from "../env.ts";

export const opsRouter: Router = Router();

/** Appeal review queue. Automated bans first — a heuristic false positive
 *  waiting four days is worse than a reviewed ban waiting four days. */
opsRouter.get("/appeals", async (_req, res) => {
  const rows = await db.query.platformBanAppeals.findMany({
    where: eq(schema.platformBanAppeals.status, "open"),
    orderBy: desc(schema.platformBanAppeals.createdAt),
    with: { ban: true },
    limit: 100,
  });

  res.json({
    appeals: rows
      .map((a) => ({
        id: a.id,
        body: a.body,
        appellantId: a.appellantId.toString(),
        createdAt: a.createdAt.toISOString(),
        // Operators see the internal fields. This is the only place they leave
        // the database, which is why this router is gated.
        ban: { ...toPublicBan(a.ban), notes: a.ban.notes, evidence: a.ban.evidence },
      }))
      .sort((x, y) => Number(y.ban.automated) - Number(x.ban.automated)),
  });
});

opsRouter.post("/appeals/:id/accept", async (req, res) => {
  const { note } = req.body as { note?: string };
  if (!note?.trim()) {
    return res.status(422).json({ error: "note_required", message: "Write what you're telling them." });
  }
  await acceptAppeal(req.params.id, req.userId!, note.trim());
  res.status(204).end();
});

opsRouter.post("/appeals/:id/deny", async (req, res) => {
  const { note } = req.body as { note?: string };
  if (!note?.trim()) {
    return res.status(422).json({ error: "note_required", message: "Write what you're telling them." });
  }
  // Denial does not touch the ban — only the appeal status and the note the
  // appellant reads. The 30-day cooldown keys off decidedAt.
  await db
    .update(schema.platformBanAppeals)
    .set({ status: "denied", decidedAt: new Date(), decidedBy: req.userId!, decisionNote: note.trim() })
    .where(eq(schema.platformBanAppeals.id, req.params.id));
  res.status(204).end();
});

/** Issue a ban. The only write path, and it exists only in here. */
opsRouter.post("/bans", async (req, res) => {
  const { subject, subjectId, reasonCode, reasonPublic, notes, expiresAt } =
    req.body as Record<string, string>;

  if (subject !== "user" && subject !== "guild") {
    return res.status(422).json({ error: "invalid_subject" });
  }
  if (!/^\d{15,25}$/.test(subjectId ?? "") || !reasonCode?.trim() || !reasonPublic?.trim()) {
    return res.status(422).json({ error: "invalid_request" });
  }
  // Nobody bans themselves by fat-fingering an id, and nobody bans another
  // operator through this route.
  if (subject === "user" && (BigInt(subjectId) === req.userId! || env.OPS_USER_IDS.has(subjectId))) {
    return res.status(409).json({ error: "operator_protected", message: "That account is an operator." });
  }

  const [row] = await db
    .insert(schema.platformBans)
    .values({
      subject,
      subjectId: BigInt(subjectId),
      reasonCode: reasonCode.trim(),
      reasonPublic: reasonPublic.trim(),
      notes: notes?.trim() || null,
      actorId: req.userId!,
      automated: false,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })
    .returning();

  await publishBanChange("add", toPublicBan(row));
  res.status(201).json({ id: row.id });
});

/** Lift a ban without an appeal. */
opsRouter.delete("/bans/:id", async (req, res) => {
  const [row] = await db
    .update(schema.platformBans)
    .set({ revokedAt: new Date(), revokedBy: req.userId!, revokeReason: "Lifted by operator" })
    .where(eq(schema.platformBans.id, req.params.id))
    .returning();
  if (!row) return res.status(404).json({ error: "not_found" });

  await publishBanChange("remove", toPublicBan(row));
  res.status(204).end();
});
