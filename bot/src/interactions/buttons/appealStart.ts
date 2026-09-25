// bot/src/interactions/buttons/appealStart.ts
//
// "Appeal this ban" — the button on the ban notice.
//
// WHY A BUTTON AND NOT QUESTIONS
//
// Being banned is not an invitation to fill in a form. The old flow DMed
// someone "question 1/5: why should we unban you?" seconds after they were
// removed, which reads as an interrogation and arrives before the person has
// even worked out what happened. Plenty of people never want to appeal at
// all; they just want to know what they were banned from and why.
//
// So the notice says what happened, and appealing is a thing you choose to
// do. Nobody is answering questions they did not agree to answer.
//
// WHY THE GUILD IS IN THE CUSTOM ID
//
// This button lives in a DM, and a DM interaction has no guild: the
// interaction's guildId is undefined. Without the id encoded in the button
// there is no way to know which server banned them — the handler would have
// to guess, and a person banned from two servers would get the wrong one.

import { eq, and } from "drizzle-orm";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { logger } from "../../utils/logger.ts";

/** Ephemeral, so the acknowledgement does not clutter the DM. */
const EPHEMERAL = 64;

export async function handleAppealStartButton(
  bot: AppealyBot,
  interaction: { id: bigint; token: string; user?: { id: bigint }; member?: { user?: { id: bigint } } },
  guildIdRaw: string,
  formId: string,
) {
  const applicantId = interaction.user?.id ?? interaction.member?.user?.id;
  if (!applicantId || !guildIdRaw || !formId) return;

  const guildId = BigInt(guildIdRaw);

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, formId), eq(schema.forms.guildId, guildId)),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });

  // Answered before anything slow happens. A button has three seconds to be
  // acknowledged, and startDmApplication writes a row and sends two DMs.
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: {
      content: form && form.active
        ? "Starting your appeal — the first question is on its way."
        : "Appeals are no longer open for that server.",
      flags: EPHEMERAL,
    },
  });

  if (!form || !form.active) return;

  const { startDmApplication } = await import("../../services/dmApplicationService.ts");

  // No roles: a banned user is definitionally not a member, so there are no
  // roles to gate on. Same reasoning as the ban handler that sent the notice.
  //
  // No intro note either — the notice they just clicked WAS the explanation.
  // Repeating it here would tell someone who has already decided to appeal
  // why they are being messaged.
  await startDmApplication(bot, guildId, form, applicantId, []);

  logger.info("Ban appeal started from the notice button", {
    guildId: guildId.toString(),
    userId: applicantId.toString(),
    formId,
  });
}
