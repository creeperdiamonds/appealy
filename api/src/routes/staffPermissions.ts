// api/src/routes/staffPermissions.ts
// Manager Delegation: grant specific roles/users the ability to manage
// and/or review applications without full Administrator permission.
// Mounted at /api/guilds/:guildId/staff-permissions

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";

export const staffPermissionsRouter = Router({ mergeParams: true });

const delegationSchema = z
  .object({
    roleId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    level: z.enum(["owner", "admin", "manager"]).default("manager"),
    formId: z.string().nullable().optional(), // null = applies to all forms
    canReview: z.boolean().default(true),
    canManageForm: z.boolean().default(false),
    canManagePanel: z.boolean().default(false),
  })
  .refine((d) => Boolean(d.roleId) !== Boolean(d.userId), {
    message: "Exactly one of roleId or userId must be set",
  });

// Only guild admins (Discord Administrator/Manage Guild/owner) may grant or
// revoke delegated access — a manager cannot promote themselves further.
staffPermissionsRouter.use(requireGuildAccess, requireAdminAccess);

staffPermissionsRouter.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(schema.staffPermissions)
    .where(eq(schema.staffPermissions.guildId, BigInt(routeParams(req).guildId)));

  res.json(
    rows.map((r) => ({
      id: r.id,
      roleId: r.roleId?.toString() ?? null,
      userId: r.userId?.toString() ?? null,
      level: r.level,
      formId: r.formId,
      canReview: r.canReview,
      canManageForm: r.canManageForm,
      canManagePanel: r.canManagePanel,
    })),
  );
});

// Manager delegation is available to every guild regardless of billing
// tier — this project charges only for throughput (see
// shared/schema/pricing.ts) and optional dedicated hosting, never for
// individual features.
staffPermissionsRouter.post("/", async (req, res) => {
  const parsed = delegationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const [created] = await db
    .insert(schema.staffPermissions)
    .values({
      guildId,
      roleId: data.roleId ? BigInt(data.roleId) : null,
      userId: data.userId ? BigInt(data.userId) : null,
      level: data.level,
      formId: data.formId ?? null,
      canReview: data.canReview,
      canManageForm: data.canManageForm,
      canManagePanel: data.canManagePanel,
    })
    .returning();

  res.status(201).json({ id: created.id });
});

staffPermissionsRouter.delete("/:delegationId", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const result = await db
    .delete(schema.staffPermissions)
    .where(
      and(
        eq(schema.staffPermissions.id, routeParams(req).delegationId),
        eq(schema.staffPermissions.guildId, guildId),
      ),
    )
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "delegation_not_found" });
  res.status(204).send();
});
