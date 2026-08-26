// bot/src/commands/exportApplications.ts
//
// /export_applications <application_name> [status] — exports matching
// submissions (with answers) to CSV and sends it as a file attachment,
// since the applicant/reviewer/answer volume can easily exceed what's
// readable in an embed.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and, like } from "drizzle-orm";
import { defer, finish } from "../utils/interactionResponse.ts";
import { logger } from "../utils/logger.ts";

const EPHEMERAL = 64;
const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "export_applications",
  description: "Export submitted applications to a CSV file",
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "application_name",
      description: "The application to export",
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
    {
      name: "status",
      description: "Filter by status (default: all)",
      type: ApplicationCommandOptionTypes.String,
      required: false,
      choices: [
        { name: "Pending", value: "pending" },
        { name: "Accepted", value: "accepted" },
        { name: "Denied", value: "denied" },
        { name: "Withdrawn", value: "withdrawn" },
      ],
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const formName = String(opts.application_name);
  const statusFilter = opts.status ? String(opts.status) : undefined;

  // The form/submissions lookups below and the CSV build can outrun
  // Discord's three-second first-response window on a guild with a large
  // application history. Deferring buys fifteen minutes.
  //
  // This only covers the `execute` handler. `autocomplete` below is a
  // separate interaction type (ApplicationCommandAutocomplete) that Discord
  // only accepts an immediate type: 8 response for — there is no deferred
  // variant for autocomplete, so it must keep responding to Discord
  // directly, the way both handlers did before this conversion. See the
  // dedicated guard test for this file in deferGuard.test.ts for why that
  // keeps it out of the generic MUST_DEFER list.
  await defer(bot, interaction, { ephemeral: true });

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, formName)),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  if (!form) {
    return respond(bot, interaction, `No application found named **${formName}**.`);
  }

  const conditions = [eq(schema.submissions.formId, form.id)];
  if (statusFilter) {
    conditions.push(eq(schema.submissions.status, statusFilter as typeof schema.submissions.$inferSelect["status"]));
  }

  const submissions = await db.query.submissions.findMany({
    where: and(...conditions),
    with: { answers: true },
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });

  if (submissions.length === 0) {
    return respond(bot, interaction, "No submissions match that filter.");
  }

  const csv = buildCsv(form.questions, submissions);
  const fileBytes = new TextEncoder().encode(csv);

  await finish(bot, interaction, `Exported ${submissions.length} submission(s) for **${form.name}**.`);

  // Follow-up with the file, since attachments aren't supported on the
  // initial deferred/ephemeral response data payload in all clients. This
  // goes through sendFollowupMessage rather than finish() because it's a
  // second, separate message — finish() can only edit the one original
  // response, which the line above already delivered.
  //
  // Wrapped in its own try/catch because the finish() call above is
  // deliberately not this handler's last statement: interactionCreate.ts's
  // catch-all EDITS the deferred response on any uncaught throw, and that
  // edit target is the "Exported N submission(s)" message above, which
  // already told the requester the truth. An uncaught throw from the
  // followup send would have the router overwrite that true message with
  // "Something went wrong," reporting a successful export as a failure.
  try {
    await bot.helpers.sendFollowupMessage(interaction.token, {
      flags: EPHEMERAL,
      // Renamed to a list in Discordeno v19+; a single-element array is the
      // same request.
      files: [
        {
          blob: new Blob([fileBytes], { type: "text/csv" }),
          name: `${form.name.replace(/[^a-z0-9]/gi, "_")}_export.csv`,
        },
      ],
    });
  } catch (err) {
    logger.warn("Failed to send export_applications CSV followup after acknowledgment was already sent", {
      formId: form.id,
      error: String(err),
    });
  }
}

function buildCsv(
  questions: (typeof schema.questions.$inferSelect)[],
  submissions: ((typeof schema.submissions.$inferSelect) & { answers: (typeof schema.answers.$inferSelect)[] })[],
): string {
  const headers = [
    "submission_id",
    "applicant_id",
    "status",
    "submitted_at",
    "reviewer_id",
    "review_reason",
    "reviewed_at",
    ...questions.map((q) => q.label),
  ];

  const rows = submissions.map((s) => {
    const answerByQuestion = Object.fromEntries(s.answers.map((a) => [a.questionId, a.value]));
    return [
      s.id,
      s.applicantId.toString(),
      s.status,
      s.createdAt.toISOString(),
      s.reviewerId?.toString() ?? "",
      s.reviewReason ?? "",
      s.reviewedAt?.toISOString() ?? "",
      ...questions.map((q) => answerByQuestion[q.id] ?? ""),
    ];
  });

  const escape = (val: string) => `"${val.replace(/"/g, '""')}"`;
  return [headers, ...rows].map((row) => row.map((v) => escape(String(v))).join(",")).join("\n");
}

export async function autocomplete(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const typed = String(interaction.data?.options?.[0]?.value ?? "");
  if (!guildId) return;

  const matches = await db
    .select({ name: schema.forms.name })
    .from(schema.forms)
    .where(and(eq(schema.forms.guildId, guildId), like(schema.forms.name, `%${typed}%`)))
    .limit(25);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 8,
    data: { choices: matches.map((m) => ({ name: m.name, value: m.name })) },
  });
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
