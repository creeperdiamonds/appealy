// bot/src/commands/exportApplications.ts
//
// /export_applications <application_name> [status] — exports matching
// submissions (with answers) to CSV and sends it as a file attachment,
// since the applicant/reviewer/answer volume can easily exceed what's
// readable in an embed.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and, like } from "drizzle-orm";

const EPHEMERAL = 64;
const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "export_applications",
  description: "Export submitted applications to a CSV file",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ADMINISTRATOR.toString(),
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

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: {
      flags: EPHEMERAL,
      content: `Exported ${submissions.length} submission(s) for **${form.name}**.`,
    },
  });

  // Follow-up with the file, since attachments aren't supported on the
  // initial deferred/ephemeral response data payload in all clients.
  await bot.helpers.sendFollowupMessage(interaction.token, {
    flags: EPHEMERAL,
    file: {
      blob: new Blob([fileBytes], { type: "text/csv" }),
      name: `${form.name.replace(/[^a-z0-9]/gi, "_")}_export.csv`,
    },
  });
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

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
