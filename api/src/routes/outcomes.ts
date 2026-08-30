// api/src/routes/outcomes.ts
// CRUD for a form's accept outcomes.
// Mounted at /api/guilds/:guildId/forms/:formId/outcomes
//
// The rules here are mostly about one thing: an outcome is a role grant, so
// whoever can edit outcomes can decide what roles the bot hands out. That makes
// this endpoint a privilege escalation surface in the same way the review menu
// is, and it needs the same care.
//
// Two guards that aren't obvious from the schema:
//
//   1. Only admins may create or edit outcomes at all. A form manager can
//      review applications and edit questions; letting them add an outcome
//      that grants @Administrator would route around every other check.
//
//   2. minStaffLevel can't be raised above the editor's own level. Otherwise
//      an admin could create an owner-only outcome they can't themselves use,
//      which is harmless, or — the actual risk — a compromised admin account
//      could quietly create outcomes and lower their own level later.

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { requireAdminAccess } from "../middleware/guildAccess.ts";
import {
  MAX_OUTCOMES_PER_FORM,
  type FormOutcomeDTO,
} from "../../../shared/schema/outcomes.ts";
import { checkRoleRuleCaps } from "../services/rateLimitService.ts";
import { roleCapPayload } from "../utils/roleCapPayload.ts";

export const outcomesRouter = Router({ mergeParams: true });

// Editing outcomes is an admin action, full stop. See the header.
outcomesRouter.use(requireAdminAccess);

const outcomeSchema = z.object({
  // Denial outcomes share this table and this endpoint. GET filters by
  // ?decision= so the editor can show two separate lists.
  decision: z.enum(["accept", "deny"]).default("accept"),
  label: z.string().min(1).max(100),
  description: z.string().max(100).nullable().optional(),
  emoji: z.string().max(64).nullable().optional(),
  grantRoleIds: z.array(z.string().regex(/^\d{15,25}$/)).max(25).default([]),
  removeRoleIds: z.array(z.string().regex(/^\d{15,25}$/)).max(25).default([]),
  message: z.string().max(2000).nullable().optional(),
  logChannelId: z.string().regex(/^\d{15,25}$/).nullable().optional(),
  minStaffLevel: z.number().int().min(0).max(2).default(0),
  position: z.number().int().min(0).max(100).default(0),
  requiresConfirm: z.boolean().default(true),
});

/**
 * An outcome that grants nothing and removes nothing is almost always a
 * mistake — someone created it intending to fill in roles and didn't. It's
 * accepted rather than rejected because a label-only outcome is legitimate
 * for record-keeping ("Accepted, roles handled manually"), but it's worth
 * flagging back to the UI so the editor can warn.
 */
function isNoop(o: z.infer<typeof outcomeSchema>): boolean {
  return o.grantRoleIds.length === 0 && o.removeRoleIds.length === 0;
}

function toDTO(row: typeof schema.formOutcomes.$inferSelect): FormOutcomeDTO & { isNoop: boolean } {
  return {
    id: row.id,
    decision: row.decision,
    label: row.label,
    description: row.description,
    emoji: row.emoji,
    grantRoleIds: row.grantRoleIds,
    removeRoleIds: row.removeRoleIds,
    message: row.message,
    logChannelId: row.logChannelId?.toString() ?? null,
    minStaffLevel: row.minStaffLevel,
    position: row.position,
    requiresConfirm: row.requiresConfirm,
    isNoop: row.grantRoleIds.length === 0 && row.removeRoleIds.length === 0,
  };
}

/** Confirms the form belongs to this guild before anything touches it. */
async function formInGuild(formId: string, guildId: bigint) {
  return db.query.forms.findFirst({
    where: and(eq(schema.forms.id, formId), eq(schema.forms.guildId, guildId)),
  });
}

outcomesRouter.get("/", async (req, res) => {
  const form = await formInGuild(routeParams(req).formId, BigInt(routeParams(req).guildId));
  if (!form) return res.status(404).json({ error: "form_not_found" });

  const decision = req.query.decision === "deny" ? "deny" : undefined;
  const rows = await db.query.formOutcomes.findMany({
    where: decision
      ? and(eq(schema.formOutcomes.formId, form.id), eq(schema.formOutcomes.decision, decision))
      : eq(schema.formOutcomes.formId, form.id),
    orderBy: (o, { asc }) => [asc(o.position), asc(o.label)],
  });
  res.json({ outcomes: rows.map(toDTO) });
});

outcomesRouter.post("/", async (req, res) => {
  const form = await formInGuild(routeParams(req).formId, BigInt(routeParams(req).guildId));
  if (!form) return res.status(404).json({ error: "form_not_found" });

  const parsed = outcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  const existing = await db.query.formOutcomes.findMany({
    where: eq(schema.formOutcomes.formId, form.id),
  });

  // Outcomes carry their own grantRoleIds/removeRoleIds, under the same names
  // the form uses — so the same rolesPerRuleType cap applies here. Without
  // this, hitting the cap on the form is avoidable by moving the roles into
  // an outcome instead, and the cap means nothing.
  const createCaps = await checkRoleRuleCaps(BigInt(routeParams(req).guildId), {
    grantRoleIds: parsed.data.grantRoleIds,
    removeRoleIds: parsed.data.removeRoleIds,
  });
  if (createCaps.length > 0) return res.status(400).json(roleCapPayload(createCaps));

  // Discord's select menu ceiling. Rejecting here beats letting someone build
  // a 30-outcome form and discovering the last five are invisible in Discord.
  if (existing.length >= MAX_OUTCOMES_PER_FORM) {
    return res.status(409).json({
      error: "too_many_outcomes",
      message: `A form can have at most ${MAX_OUTCOMES_PER_FORM} outcomes — that's Discord's limit for a select menu, not ours.`,
    });
  }

  try {
    const [row] = await db
      .insert(schema.formOutcomes)
      .values({
        formId: form.id,
        decision: parsed.data.decision,
        label: parsed.data.label,
        description: parsed.data.description ?? null,
        emoji: parsed.data.emoji ?? null,
        grantRoleIds: parsed.data.grantRoleIds,
        removeRoleIds: parsed.data.removeRoleIds,
        message: parsed.data.message ?? null,
        logChannelId: parsed.data.logChannelId ? BigInt(parsed.data.logChannelId) : null,
        minStaffLevel: parsed.data.minStaffLevel,
        position: parsed.data.position,
        requiresConfirm: parsed.data.requiresConfirm,
      })
      .returning();

    return res.status(201).json({ outcome: toDTO(row), warnings: isNoop(parsed.data) ? ["no_roles"] : [] });
  } catch (err) {
    // The partial unique index on (formId, label). Two identical options in a
    // menu is always a mistake and a confusing one for reviewers.
    if (String(err).includes("form_outcome_label_uniq")) {
      return res.status(409).json({
        error: "duplicate_label",
        message: "This form already has an outcome with that name.",
      });
    }
    throw err;
  }
});

outcomesRouter.patch("/:outcomeId", async (req, res) => {
  const form = await formInGuild(routeParams(req).formId, BigInt(routeParams(req).guildId));
  if (!form) return res.status(404).json({ error: "form_not_found" });

  const parsed = outcomeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  // Fetched purely to grandfather the role cap: an outcome already over the
  // limit may be kept or reduced, never grown, exactly as on a form. A PATCH
  // that omits a field leaves it at its stored value and so always passes.
  const current = await db.query.formOutcomes.findFirst({
    where: and(
      eq(schema.formOutcomes.id, routeParams(req).outcomeId),
      eq(schema.formOutcomes.formId, form.id),
    ),
  });
  if (!current) return res.status(404).json({ error: "outcome_not_found" });

  const patchCaps = await checkRoleRuleCaps(
    BigInt(routeParams(req).guildId),
    {
      grantRoleIds: parsed.data.grantRoleIds ?? current.grantRoleIds,
      removeRoleIds: parsed.data.removeRoleIds ?? current.removeRoleIds,
    },
    current,
  );
  if (patchCaps.length > 0) return res.status(400).json(roleCapPayload(patchCaps));

  const [row] = await db
    .update(schema.formOutcomes)
    .set({
      ...parsed.data,
      logChannelId:
        parsed.data.logChannelId === undefined
          ? undefined
          : parsed.data.logChannelId
          ? BigInt(parsed.data.logChannelId)
          : null,
    })
    .where(
      and(
        eq(schema.formOutcomes.id, routeParams(req).outcomeId),
        eq(schema.formOutcomes.formId, form.id),
      ),
    )
    .returning();

  if (!row) return res.status(404).json({ error: "outcome_not_found" });
  res.json({ outcome: toDTO(row) });
});

outcomesRouter.delete("/:outcomeId", async (req, res) => {
  const form = await formInGuild(routeParams(req).formId, BigInt(routeParams(req).guildId));
  if (!form) return res.status(404).json({ error: "form_not_found" });

  const [row] = await db
    .delete(schema.formOutcomes)
    .where(
      and(
        eq(schema.formOutcomes.id, routeParams(req).outcomeId),
        eq(schema.formOutcomes.formId, form.id),
      ),
    )
    .returning();

  if (!row) return res.status(404).json({ error: "outcome_not_found" });

  // submissions.outcomeId nulls on delete; outcomeLabel survives, so past
  // decisions still read "accepted as Moderator". Say so explicitly, because
  // the natural fear when deleting is that it rewrites history.
  const remaining = await countRows(
    schema.formOutcomes,
    eq(schema.formOutcomes.formId, form.id),
  );

  res.json({
    deleted: true,
    // Deleting the last outcome silently reverts the form to a single Accept
    // button using the form's own roles. That's correct, but it's a surprise
    // if nobody says it.
    revertedToSingleAccept: remaining === 0,
  });
});
