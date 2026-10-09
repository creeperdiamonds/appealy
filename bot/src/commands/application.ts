// bot/src/commands/application.ts
//
// /application status — the member's own applications in this server and
// where each one stands, privately. Answers "did anyone see my app?" without
// a DM to staff, and shows what can still be withdrawn.

import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from "@discordeno/bot";
import type { CreateApplicationCommand } from "@discordeno/bot";
import { and, desc, eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { defer, finish } from "../utils/interactionResponse.ts";
import { statusLine } from "../services/applicationStatus.ts";

/** Enough to cover anyone's recent history; more is on the dashboard for staff. */
const SHOWN = 10;

export const definition: CreateApplicationCommand = {
  name: "application",
  description: "Your applications in this server",
  descriptionLocalizations: { ja: "このサーバーでのあなたの応募" },
  type: ApplicationCommandTypes.ChatInput,
  options: [
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "status",
      description: "See your applications here and where each one stands",
      descriptionLocalizations: { ja: "このサーバーでの応募と、それぞれの状況を確認します" },
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const member = interaction.member?.user ?? interaction.user;
  if (!guildId || !member) return;

  await defer(bot, interaction, { ephemeral: true });

  const rows = await db
    .select({
      formName: schema.forms.name,
      status: schema.submissions.status,
      outcomeLabel: schema.submissions.outcomeLabel,
      createdAt: schema.submissions.createdAt,
      reviewedAt: schema.submissions.reviewedAt,
    })
    .from(schema.submissions)
    .innerJoin(schema.forms, eq(schema.forms.id, schema.submissions.formId))
    .where(and(eq(schema.submissions.guildId, guildId), eq(schema.submissions.applicantId, member.id)))
    .orderBy(desc(schema.submissions.createdAt))
    .limit(SHOWN + 1);

  if (rows.length === 0) {
    return finish(bot, interaction, "You haven't applied for anything in this server yet.");
  }

  const lines = rows.slice(0, SHOWN).map(statusLine);
  if (rows.length > SHOWN) lines.push(`…and older ones. Showing your latest ${SHOWN}.`);
  return finish(bot, interaction, {
    embeds: [{ title: "Your applications", description: lines.join("\n"), color: 0x5865f2 }],
  });
}
