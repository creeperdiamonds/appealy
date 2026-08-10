// api/src/routes/forms.ts
// CRUD for forms and their nested questions. Mounted at /api/guilds/:guildId/forms

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { checkStandingCap } from "../services/rateLimitService.ts";
import { checkPatternSafety } from "../../../shared/schema/regexValidation.ts";
import type { FormDTO } from "../../../shared/types/index.ts";

export const formsRouter = Router({ mergeParams: true });

const questionSchema = z
  .object({
    id: z.string().optional(), // present on update, absent on create
    label: z.string().min(1).max(200),
    placeholder: z.string().max(100).nullable().optional(),
    type: z.enum(["short_text", "paragraph", "select"]),
    required: z.boolean().default(true),
    minLength: z.number().int().min(0).nullable().optional(),
    maxLength: z.number().int().max(4000).nullable().optional(),
    options: z
      .array(z.object({ label: z.string(), value: z.string(), description: z.string().optional() }))
      .nullable()
      .optional(),
    validationType: z.enum(["none", "regex"]).default("none"),
    validationPattern: z.string().max(256).nullable().optional(),
    validationErrorMessage: z.string().max(200).nullable().optional(),
    sortOrder: z.number().int().default(0),
  })
  .refine((q) => q.validationType !== "regex" || q.type !== "select", {
    message: "Regex validation is not applicable to select questions.",
    path: ["validationType"],
  })
  .refine((q) => q.validationType !== "regex" || Boolean(q.validationPattern), {
    message: "A pattern is required when validationType is \"regex\".",
    path: ["validationPattern"],
  })
  .refine(
    (q) => {
      if (q.validationType !== "regex" || !q.validationPattern) return true;
      return checkPatternSafety(q.validationPattern).valid;
    },
    (q) => ({
      message: q.validationPattern
        ? checkPatternSafety(q.validationPattern).reason ?? "Invalid pattern."
        : "Invalid pattern.",
      path: ["validationPattern"],
    }),
  );

const formSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  applicationType: z.enum(["in_server", "direct_message"]).default("in_server"),
  logChannelId: z.string(),
  acceptedChannelId: z.string().nullable().optional(),
  deniedChannelId: z.string().nullable().optional(),
  grantRoleIds: z.array(z.string()).default([]),
  removeRoleIds: z.array(z.string()).default([]),
  deniedGrantRoleIds: z.array(z.string()).default([]),
  denyRemoveRoleIds: z.array(z.string()).default([]),
  pendingRoleIds: z.array(z.string()).default([]),
  removeRolesOnSubmitIds: z.array(z.string()).default([]),
  pingRoleIds: z.array(z.string()).default([]),
  leaveAction: z.enum(["none", "deny_application"]).default("none"),
  requiredRoleIds: z.array(z.string()).default([]),
  requiredRolesMatchMode: z.enum(["has_all", "has_any"]).default("has_all"),
  blacklistedRoleIds: z.array(z.string()).default([]),
  blacklistedRolesMatchMode: z.enum(["has_all", "has_any"]).default("has_all"),
  cooldownSeconds: z.number().int().min(0).default(0),
  maxTotalSubmissions: z.number().int().min(1).nullable().default(null),
  maxSubmissionsWindowSeconds: z.number().int().min(1).nullable().default(null),
  maxSubmissionsInWindow: z.number().int().min(1).nullable().default(null),
  timeLimitSeconds: z.number().int().min(60).nullable().default(null),
  allowMultiplePending: z.boolean().default(false),
  threadCollabEnabled: z.boolean().default(true),
  threadName: z.string().max(100).default("Review: {username}"),
  autoArchiveOnDecision: z.boolean().default(true),
  hideAnswersInEmbed: z.boolean().default(false),
  confirmationMessage: z.string().max(2000).nullable().default(null),
  active: z.boolean().default(true),
  questions: z.array(questionSchema).max(10).default([]),
});

formsRouter.use(requireGuildAccess);

formsRouter.get("/", async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const forms = await db.query.forms.findMany({
    where: eq(schema.forms.guildId, guildId),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  res.json(forms.map(toDTO));
});

formsRouter.get("/:formId", async (req, res) => {
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, req.params.formId), eq(schema.forms.guildId, BigInt(req.params.guildId))),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  if (!form) return res.status(404).json({ error: "form_not_found" });
  res.json(toDTO(form));
});

formsRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = formSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });

  const guildId = BigInt(req.params.guildId);
  const data = parsed.data;

  const existingFormCount = await db.$count(schema.forms, eq(schema.forms.guildId, guildId));
  const capCheck = await checkStandingCap(guildId, "formsPerGuild", existingFormCount);
  if (!capCheck.allowed) {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      detail: `This server has reached its limit of ${capCheck.limit} forms. Raise your limit from the billing page, or delete an existing form first.`,
      current: capCheck.current,
      limit: capCheck.limit,
    });
  }

  const form = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.forms)
      .values({
        guildId,
        name: data.name,
        description: data.description,
        applicationType: data.applicationType,
        logChannelId: BigInt(data.logChannelId),
        acceptedChannelId: data.acceptedChannelId ? BigInt(data.acceptedChannelId) : null,
        deniedChannelId: data.deniedChannelId ? BigInt(data.deniedChannelId) : null,
        grantRoleIds: data.grantRoleIds,
        removeRoleIds: data.removeRoleIds,
        deniedGrantRoleIds: data.deniedGrantRoleIds,
        denyRemoveRoleIds: data.denyRemoveRoleIds,
        pendingRoleIds: data.pendingRoleIds,
        removeRolesOnSubmitIds: data.removeRolesOnSubmitIds,
        pingRoleIds: data.pingRoleIds,
        leaveAction: data.leaveAction,
        requiredRoleIds: data.requiredRoleIds,
        requiredRolesMatchMode: data.requiredRolesMatchMode,
        blacklistedRoleIds: data.blacklistedRoleIds,
        blacklistedRolesMatchMode: data.blacklistedRolesMatchMode,
        cooldownSeconds: data.cooldownSeconds,
        maxTotalSubmissions: data.maxTotalSubmissions,
        maxSubmissionsWindowSeconds: data.maxSubmissionsWindowSeconds,
        maxSubmissionsInWindow: data.maxSubmissionsInWindow,
        timeLimitSeconds: data.timeLimitSeconds,
        allowMultiplePending: data.allowMultiplePending,
        threadCollabEnabled: data.threadCollabEnabled,
        threadName: data.threadName,
        autoArchiveOnDecision: data.autoArchiveOnDecision,
        hideAnswersInEmbed: data.hideAnswersInEmbed,
        confirmationMessage: data.confirmationMessage,
        active: data.active,
      })
      .returning();

    if (data.questions.length > 0) {
      await tx.insert(schema.questions).values(
        data.questions.map((q, i) => ({
          formId: created.id,
          label: q.label,
          placeholder: q.placeholder ?? null,
          type: q.type,
          required: q.required,
          minLength: q.minLength ?? null,
          maxLength: q.maxLength ?? null,
          options: q.options ?? null,
          validationType: q.validationType,
          validationPattern: q.validationType === "regex" ? q.validationPattern ?? null : null,
          validationErrorMessage: q.validationType === "regex" ? q.validationErrorMessage ?? null : null,
          sortOrder: q.sortOrder ?? i,
        })),
      );
    }
    return created;
  });

  const full = await db.query.forms.findFirst({
    where: eq(schema.forms.id, form.id),
    with: { questions: true },
  });
  res.status(201).json(toDTO(full!));
});

formsRouter.patch("/:formId", requireAdminAccess, async (req, res) => {
  const parsed = formSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });

  const guildId = BigInt(req.params.guildId);
  const formId = req.params.formId;
  const existing = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, formId), eq(schema.forms.guildId, guildId)),
  });
  if (!existing) return res.status(404).json({ error: "form_not_found" });

  const data = parsed.data;

  await db.transaction(async (tx) => {
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of [
      "name",
      "description",
      "applicationType",
      "cooldownSeconds",
      "maxTotalSubmissions",
      "maxSubmissionsWindowSeconds",
      "maxSubmissionsInWindow",
      "timeLimitSeconds",
      "allowMultiplePending",
      "threadCollabEnabled",
      "threadName",
      "autoArchiveOnDecision",
      "hideAnswersInEmbed",
      "confirmationMessage",
      "active",
      "grantRoleIds",
      "removeRoleIds",
      "deniedGrantRoleIds",
      "denyRemoveRoleIds",
      "pendingRoleIds",
      "removeRolesOnSubmitIds",
      "pingRoleIds",
      "leaveAction",
      "requiredRoleIds",
      "requiredRolesMatchMode",
      "blacklistedRoleIds",
      "blacklistedRolesMatchMode",
    ] as const) {
      if (data[key] !== undefined) updateSet[key] = data[key];
    }
    if (data.logChannelId !== undefined) updateSet.logChannelId = BigInt(data.logChannelId);
    if (data.acceptedChannelId !== undefined) {
      updateSet.acceptedChannelId = data.acceptedChannelId ? BigInt(data.acceptedChannelId) : null;
    }
    if (data.deniedChannelId !== undefined) {
      updateSet.deniedChannelId = data.deniedChannelId ? BigInt(data.deniedChannelId) : null;
    }

    if (Object.keys(updateSet).length > 1) {
      await tx.update(schema.forms).set(updateSet).where(eq(schema.forms.id, formId));
    }

    if (data.questions !== undefined) {
      // Replace-all strategy: simpler and safer than diffing given forms
      // rarely exceed 10 questions, and submissions reference questions by
      // ID which is preserved for existing rows (see id? in questionSchema).
      await tx.delete(schema.questions).where(eq(schema.questions.formId, formId));
      await tx.insert(schema.questions).values(
        data.questions.map((q, i) => ({
          id: q.id, // preserve ID if provided so existing answers stay linked
          formId,
          label: q.label,
          placeholder: q.placeholder ?? null,
          type: q.type,
          required: q.required,
          minLength: q.minLength ?? null,
          maxLength: q.maxLength ?? null,
          options: q.options ?? null,
          validationType: q.validationType,
          validationPattern: q.validationType === "regex" ? q.validationPattern ?? null : null,
          validationErrorMessage: q.validationType === "regex" ? q.validationErrorMessage ?? null : null,
          sortOrder: q.sortOrder ?? i,
        })),
      );
    }
  });

  const full = await db.query.forms.findFirst({
    where: eq(schema.forms.id, formId),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  res.json(toDTO(full!));
});

formsRouter.delete("/:formId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const result = await db
    .delete(schema.forms)
    .where(and(eq(schema.forms.id, req.params.formId), eq(schema.forms.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "form_not_found" });
  res.status(204).send();
});

function toDTO(form: typeof schema.forms.$inferSelect & { questions: (typeof schema.questions.$inferSelect)[] }): FormDTO {
  return {
    id: form.id,
    guildId: form.guildId.toString(),
    name: form.name,
    description: form.description ?? "",
    applicationType: form.applicationType,
    logChannelId: form.logChannelId.toString(),
    acceptedChannelId: form.acceptedChannelId?.toString() ?? null,
    deniedChannelId: form.deniedChannelId?.toString() ?? null,
    grantRoleIds: form.grantRoleIds,
    removeRoleIds: form.removeRoleIds,
    deniedGrantRoleIds: form.deniedGrantRoleIds,
    denyRemoveRoleIds: form.denyRemoveRoleIds,
    pendingRoleIds: form.pendingRoleIds,
    removeRolesOnSubmitIds: form.removeRolesOnSubmitIds,
    pingRoleIds: form.pingRoleIds,
    leaveAction: form.leaveAction,
    requiredRoleIds: form.requiredRoleIds,
    requiredRolesMatchMode: form.requiredRolesMatchMode,
    blacklistedRoleIds: form.blacklistedRoleIds,
    blacklistedRolesMatchMode: form.blacklistedRolesMatchMode,
    cooldownSeconds: form.cooldownSeconds,
    maxTotalSubmissions: form.maxTotalSubmissions,
    maxSubmissionsWindowSeconds: form.maxSubmissionsWindowSeconds,
    maxSubmissionsInWindow: form.maxSubmissionsInWindow,
    timeLimitSeconds: form.timeLimitSeconds,
    allowMultiplePending: form.allowMultiplePending,
    threadCollabEnabled: form.threadCollabEnabled,
    threadName: form.threadName ?? "Review: {username}",
    autoArchiveOnDecision: form.autoArchiveOnDecision,
    hideAnswersInEmbed: form.hideAnswersInEmbed,
    confirmationMessage: form.confirmationMessage,
    active: form.active,
    questions: form.questions.map((q) => ({
      id: q.id,
      label: q.label,
      placeholder: q.placeholder,
      type: q.type,
      required: q.required,
      minLength: q.minLength,
      maxLength: q.maxLength,
      options: q.options,
      validationType: q.validationType,
      validationPattern: q.validationPattern,
      validationErrorMessage: q.validationErrorMessage,
      sortOrder: q.sortOrder,
    })),
  };
}
