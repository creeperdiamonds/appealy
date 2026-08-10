// bot/src/services/dmService.ts
//
// Sends status-update DMs (submission/acceptance/denial) to applicants.
// Uses the guild's custom DmTemplate if one is configured and enabled,
// otherwise falls back to a sensible default. DM failures (closed DMs,
// blocked bot) are logged but never thrown — they must never block the
// review pipeline.

import { eq, and } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { interpolateTemplate, type DmType } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

interface SendTemplatedDmArgs {
  formId: string;
  type: DmType;
  userId: bigint;
  username: string;
  userTag: string;
  guildName: string;
  formName: string;
  reason?: string;
}

const DEFAULTS: Record<DmType, { title: string; body: string; color: number }> = {
  submission: {
    title: "Application Received",
    body: "Your application for **{form}** in **{guild}** has been received and is pending review.",
    color: 0x5865f2,
  },
  acceptance: {
    title: "Application Accepted",
    body: "Congratulations! Your application for **{form}** in **{guild}** has been **accepted**.",
    color: 0x57f287,
  },
  denial: {
    title: "Application Denied",
    body:
      "Your application for **{form}** in **{guild}** has been **denied**.\n\n**Reason:** {reason}",
    color: 0xed4245,
  },
};

export async function sendTemplatedDm(bot: AppealyBot, args: SendTemplatedDmArgs) {
  const template = await db.query.dmTemplates.findFirst({
    where: and(eq(schema.dmTemplates.formId, args.formId), eq(schema.dmTemplates.type, args.type)),
  });

  if (template && !template.enabled) return; // explicitly disabled by staff

  const fallback = DEFAULTS[args.type];
  const title = template?.title ?? fallback.title;
  const bodyRaw = template?.body ?? fallback.body;
  const color = template?.color ?? fallback.color;

  const body = interpolateTemplate(bodyRaw, {
    username: args.username,
    userTag: args.userTag,
    userId: args.userId.toString(),
    guildName: args.guildName,
    formName: args.formName,
    reason: args.reason,
  });

  try {
    const dmChannel = await bot.helpers.getDmChannel(args.userId);
    await bot.helpers.sendMessage(dmChannel.id, {
      embeds: [
        {
          title,
          description: body,
          color,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    logger.warn("Failed to DM applicant (likely closed DMs)", {
      userId: args.userId.toString(),
      type: args.type,
      error: String(err),
    });
  }
}
