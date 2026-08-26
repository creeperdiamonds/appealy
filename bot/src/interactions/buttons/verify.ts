// bot/src/interactions/buttons/verify.ts
//
// Handles the "Verify" button on a guild's verification panel. Two paths
// depending on config.method:
//   "button": grant the verified role immediately, no challenge.
//   "captcha": generate a short alphanumeric code, show it back to the user
//     in the ephemeral response, and open a modal asking them to retype it.
//     This is a simple text-retype challenge rather than an image captcha —
//     image generation would require a rendering dependency or an external
//     service, and a text-retype step already screens out the large
//     majority of naive auto-join bots without that added complexity.
//
// ONLY THE CAPTCHA BRANCH IS EXEMPT FROM DEFERRING.
//
// The modal exemption in bot/src/utils/interactionResponse.ts applies to a
// modal response, and only the captcha branch sends one. The "button" branch
// — which is the DEFAULT (commands/verifySetup.ts falls back to "button"
// when no method is given) — does four sequential Discord REST calls
// (getGuild + getMember inside findUnmanageableRoles, then addRole and
// removeRole) plus two database round trips before it can say anything. From
// us-central1 that is comfortably over a second against a three-second
// budget already spending ~300ms on delivery, on the first interaction a new
// member ever has with a server running Appealy. So it defers.
//
// The config lookup stays ahead of both branches because the branch choice
// depends on it: we cannot know whether deferring is legal until we know
// which method is configured. That is why this file gets a bespoke block in
// deferGuard.test.ts rather than a MUST_DEFER entry — the generic assertion
// there requires a file's first `await` to be `await defer(`, which this file
// deliberately is not.

import { eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import { findUnmanageableRoles } from "../../services/permissionService.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";
import { logger } from "../../utils/logger.ts";

const EPHEMERAL = 64;

function generateChallengeCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (I/O/0/1)
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export async function handleVerifyButton(bot: AppealyBot, interaction: Interaction, guildIdStr: string) {
  const guildId = BigInt(guildIdStr);
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return;

  const config = await db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, guildId) });
  if (!config || !config.enabled) {
    return respond(bot, interaction, "Verification is not currently enabled on this server.");
  }

  if (config.method === "button") {
    // No modal on this path, so the four REST calls and the insert below get
    // the fifteen-minute window instead of what is left of three seconds.
    await defer(bot, interaction, { ephemeral: true });
    await grantVerifiedRole(bot, guildId, user.id, config);
    await db.insert(schema.verificationAttempts).values({ guildId, userId: user.id, verified: true });
    return finish(bot, interaction, "You're verified! Welcome to the server.");
  }

  // captcha method
  const code = generateChallengeCode();
  await db.insert(schema.verificationAttempts).values({ guildId, userId: user.id, challengeCode: code, verified: false });

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      customId: encodeCustomId("verify", "captcha_confirm", guildIdStr, code),
      title: "Verify",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: "answer",
              label: `Type this code: ${code}`,
              style: 1,
              required: true,
              minLength: 6,
              maxLength: 6,
            },
          ],
        },
      ],
    },
  });
}

async function grantVerifiedRole(
  bot: AppealyBot,
  guildId: bigint,
  userId: bigint,
  config: typeof schema.verificationConfigs.$inferSelect,
) {
  const targetRoles = [config.verifiedRoleId, config.unverifiedRoleId].filter(Boolean) as bigint[];
  const unmanageable = await findUnmanageableRoles(bot, guildId, targetRoles.map(String));

  try {
    if (config.verifiedRoleId && !unmanageable.includes(config.verifiedRoleId.toString())) {
      await bot.helpers.addRole(guildId, userId, config.verifiedRoleId, "Verification passed");
    }
    if (config.unverifiedRoleId && !unmanageable.includes(config.unverifiedRoleId.toString())) {
      await bot.helpers.removeRole(guildId, userId, config.unverifiedRoleId, "Verification passed");
    }
  } catch (err) {
    logger.error("Role update failed during verification", { guildId: guildId.toString(), userId: userId.toString(), error: String(err) });
  }
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}

export { grantVerifiedRole };
