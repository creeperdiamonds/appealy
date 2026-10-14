// bot/src/services/webAppeal.ts
//
// Ban appeals from the web: appealy.app/appeal/<server id>, for someone who
// signs in with Discord there (web/src/pages/WebAppeal.tsx). The API passes
// requests here through the control server, because only the bot can ask
// Discord whether the person is banned, and only the bot posts submissions
// for review.
//
// Until now the only way into a ban appeal was the DM Appealy sends at the
// moment of the ban, and that DM only arrives if the person shares another
// server with the bot and accepts DMs. A link a server can put in its ban
// message or rules works for everyone, from the first server Appealy is in.
//
// Bans only. Someone timed out or restricted is still a member, and already
// gets the appeal DM from inside the server.
//
// The ban is checked with Discord every time, never taken on trust: the page
// is public, and an appeal from someone who isn't banned is noise in a staff
// channel.

import { and, desc, eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { answerProblem } from "../../../shared/schema/answers.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { checkGateForDm, createSubmission } from "./dmApplicationService.ts";
import { gateReasonToMessage } from "../../../shared/schema/gating.ts";
import { logger } from "../utils/logger.ts";

export type BanCheck = "banned" | "not_banned" | "cant_check";

/** Whether Discord has this user banned here. */
export async function checkBan(bot: AppealyBot, guildId: bigint, userId: bigint): Promise<BanCheck> {
  try {
    await bot.helpers.getBan(guildId, userId);
    return "banned";
  } catch (err) {
    const info = describeDiscordError(err);
    // 10026 Unknown Ban: Discord's way of saying no.
    if (info.code === 10026 || info.status === 404) return "not_banned";
    // Usually the bot lacking Ban Members, which it also needs to unban.
    logger.warn("Couldn't check a ban for a web appeal", { guildId: String(guildId), status: info.status, code: info.code });
    return "cant_check";
  }
}

async function loadAppealForm(guildId: bigint) {
  const config = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) });
  if (!config?.enabled || !config.formId) return null;
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, config.formId), eq(schema.forms.guildId, guildId)),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  return form && form.kind === "appeal" && form.active ? form : null;
}

export type WebAppealStatus =
  | { status: "unavailable" }
  | { status: "cant_check" }
  | { status: "not_banned"; latest: LatestAppeal | null }
  | { status: "banned"; latest: LatestAppeal | null };

export interface LatestAppeal {
  id: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

/** Where this person stands with this server: banned or not, and their last appeal here. */
export async function webAppealStatus(bot: AppealyBot, guildId: bigint, userId: bigint): Promise<WebAppealStatus> {
  const form = await loadAppealForm(guildId);
  if (!form) return { status: "unavailable" };
  const ban = await checkBan(bot, guildId, userId);
  if (ban === "cant_check") return { status: "cant_check" };
  const [last] = await db
    .select()
    .from(schema.submissions)
    .where(and(eq(schema.submissions.guildId, guildId), eq(schema.submissions.applicantId, userId), eq(schema.submissions.appealKind, "ban")))
    .orderBy(desc(schema.submissions.createdAt))
    .limit(1);
  const latest = last
    ? {
      id: last.id,
      status: last.status,
      createdAt: last.createdAt.toISOString(),
      decidedAt: last.reviewedAt?.toISOString() ?? null,
    }
    : null;
  return { status: ban, latest };
}

export type WebAppealResult =
  | { status: "submitted"; submissionId: string }
  | { status: "unavailable" }
  | { status: "cant_check" }
  | { status: "not_banned" }
  | { status: "invalid"; problems: Record<string, string> }
  | { status: "refused"; message: string };

export async function submitWebAppeal(
  bot: AppealyBot,
  guildId: bigint,
  applicantId: bigint,
  answers: Record<string, string>,
  completionSeconds: number | null,
): Promise<WebAppealResult> {
  const form = await loadAppealForm(guildId);
  if (!form) return { status: "unavailable" };

  const ban = await checkBan(bot, guildId, applicantId);
  if (ban !== "banned") return { status: ban };

  // Only this form's questions, each checked by the same rules the page used.
  const clean: Record<string, string> = {};
  const problems: Record<string, string> = {};
  for (const q of form.questions) {
    const value = typeof answers[q.id] === "string" ? answers[q.id] : "";
    const problem = answerProblem(q, value);
    if (problem) problems[q.id] = problem;
    else if (value.trim()) clean[q.id] = value;
  }
  if (Object.keys(problems).length) return { status: "invalid", problems };

  // Cooldown, one pending at a time, lifetime caps, as for a DM appeal. No
  // roles: a banned person has none here.
  const gate = await checkGateForDm(form, guildId, applicantId, []);
  if (!gate.allowed) return { status: "refused", message: gateReasonToMessage(gate) };

  const result = await createSubmission(bot, form, {
    guildId,
    applicantId,
    answers: clean,
    completionSeconds,
    appeal: { kind: "ban", roleIds: [], timeoutUntil: null },
    roleAutomation: false,
  });
  if (result.status === "capped") return { status: "refused", message: result.message };
  logger.info("Web appeal submitted", { guildId: String(guildId), submissionId: result.submissionId });
  return { status: "submitted", submissionId: result.submissionId };
}
