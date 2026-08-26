// bot/src/interactions/modals/verifyCaptcha.ts
// Handles submission of the retype-the-code captcha modal.

import { eq, and, desc } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { grantVerifiedRole } from "../buttons/verify.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleVerifyCaptchaModalSubmit(
  bot: AppealyBot,
  interaction: Interaction,
  guildIdStr: string,
) {
  const guildId = BigInt(guildIdStr);
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return;

  // Deferred here — before the code-match check below — because that check
  // itself responds on failure via respond()/finish(), which requires a
  // prior deferral. Everything past a correct code is a config lookup plus
  // a role grant plus another query and update, well past three seconds.
  await defer(bot, interaction, { ephemeral: true });

  // The expected code travels in the modal's custom_id (see verify.ts),
  // set at generation time — this avoids a race where the user opens two
  // verification attempts and answers the wrong one's modal.
  const expectedCode = interaction.data?.customId?.split(":")[3];
  const typedAnswer = interaction.data?.components?.[0]?.components?.[0]?.value?.trim().toUpperCase();

  if (!expectedCode || typedAnswer !== expectedCode) {
    return respond(bot, interaction, "That code didn't match. Please try verifying again.");
  }

  const config = await db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, guildId) });
  if (!config || !config.enabled) {
    return respond(bot, interaction, "Verification is not currently enabled on this server.");
  }

  await grantVerifiedRole(bot, guildId, user.id, config);

  const lastAttempt = await db.query.verificationAttempts.findFirst({
    where: and(eq(schema.verificationAttempts.guildId, guildId), eq(schema.verificationAttempts.userId, user.id)),
    orderBy: desc(schema.verificationAttempts.attemptedAt),
  });
  if (lastAttempt) {
    await db.update(schema.verificationAttempts).set({ verified: true }).where(eq(schema.verificationAttempts.id, lastAttempt.id));
  }

  await respond(bot, interaction, "You're verified! Welcome to the server.");
}

// Kept as a one-line wrapper rather than rewriting every call site: the
// ephemeral flag now lives on the deferral, so there is nothing left for
// this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
