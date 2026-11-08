// bot/src/interactions/modals/followUp.ts
//
// Follow-up questions, the submitted halves (the modals they come from are
// opened in interactions/buttons/reviewAsk.ts):
//
//   handleAskSubmit     staff asked: DM the applicant, note it for staff
//   handleAnswerSubmit  the applicant answered: show staff
//
// Staff see both in the submission's staff thread, or as a reply to the
// review post when the form has no threads, so the conversation sits next to
// the application it's about. Questions are only for pending submissions, and
// each one is answered once.
//
// An answer can carry files (up to five, from the answer popup's File
// Upload). They're copied into the staff thread with the answer, so they stay
// there like any attachment: Discord's link for an uploaded file stops working
// after about a day. Appealy keeps only their names, in the stored answer.

import { and, eq, isNull } from "drizzle-orm";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";
import { getGuild } from "../../core/guildLookup.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm } from "../../services/permissionService.ts";
import { logger } from "../../utils/logger.ts";
import { readModalAnswers, readModalFileIds } from "../../services/modalAnswers.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

type Submission = typeof schema.submissions.$inferSelect & { form: typeof schema.forms.$inferSelect };

export async function handleAskSubmit(bot: AppealyBot, interaction: Interaction, submissionId: string) {
  const guildId = interaction.guildId;
  const asker = interaction.member?.user ?? interaction.user;
  if (!guildId || !asker) return;

  await defer(bot, interaction, { ephemeral: true });

  const question = textValue(interaction);
  if (!question) return finish(bot, interaction, "The question was empty, so nothing was sent.");

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission) return finish(bot, interaction, "This submission no longer exists.");
  if (submission.status !== "pending") {
    return finish(bot, interaction, `This was already marked **${submission.status}**, so questions are closed.`);
  }
  const allowed = await canReviewForm(
    guildId,
    submission.formId,
    asker.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) return finish(bot, interaction, "Only reviewers can ask the applicant questions.");

  const [followup] = await db
    .insert(schema.submissionFollowups)
    .values({ submissionId, guildId, askerId: asker.id, question })
    .returning({ id: schema.submissionFollowups.id });

  const guildName = (await getGuild(bot, guildId))?.name ?? "the server";
  let delivered = true;
  try {
    const dm = await bot.helpers.getDmChannel(submission.applicantId);
    await bot.helpers.sendMessage(dm.id, {
      embeds: [
        {
          title: `A question about your ${submission.form.name} application`,
          description: question,
          color: 0x5865f2,
          footer: { text: `From the staff of ${guildName}` },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Answer", customId: encodeCustomId("submission", "answer", followup.id) },
          ],
        },
      ],
    } as never);
  } catch (err) {
    delivered = false;
    logger.warn("Couldn't DM a follow-up question", { submissionId, error: String(err) });
    // Nothing was sent, so there's nothing to answer: don't leave it open.
    await db.delete(schema.submissionFollowups).where(eq(schema.submissionFollowups.id, followup.id));
  }

  if (!delivered) {
    return finish(bot, interaction, "I couldn't DM the applicant: their DMs from this server are probably closed. Nothing was sent.");
  }
  await tellStaff(bot, submission, `❓ <@${asker.id}> asked <@${submission.applicantId}>:\n>>> ${question}`);
  return finish(bot, interaction, "Sent! Their answer will show up here for staff.");
}

export async function handleAnswerSubmit(bot: AppealyBot, interaction: Interaction, followupId: string) {
  const answerer = interaction.user ?? interaction.member?.user;
  if (!answerer) return;

  await defer(bot, interaction, { ephemeral: true });

  // The popup's Labels, or the older text-only popup's action row.
  const answer = (readModalAnswers(interaction.data?.components as never).answer ?? "").trim();
  const files = readModalFileIds(interaction.data?.components as never, "files")
    .map((id) => uploadedFile(interaction, id))
    .filter((f): f is UploadedFile => f !== null);
  if (!answer && files.length === 0) return finish(bot, interaction, "Your answer was empty, so nothing was sent.");

  const followup = await db.query.submissionFollowups.findFirst({ where: eq(schema.submissionFollowups.id, followupId) });
  if (!followup) return finish(bot, interaction, "This question no longer exists.");
  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, followup.submissionId),
    with: { form: true },
  });
  if (!submission || submission.applicantId !== answerer.id) return finish(bot, interaction, "This question isn't for you.");
  if (submission.status !== "pending") {
    return finish(bot, interaction, `Your application was already **${submission.status}**, so there's no need to answer.`);
  }

  // Answered once: the update only lands if nobody answered first.
  const [saved] = await db
    .update(schema.submissionFollowups)
    .set({
      // Only the names: the files themselves are posted in Discord, not kept.
      answer: files.length
        ? `${answer}${answer ? "\n\n" : ""}Attached: ${files.map((f) => f.filename).join(", ")}`
        : answer,
      answeredAt: new Date(),
    })
    .where(and(eq(schema.submissionFollowups.id, followupId), isNull(schema.submissionFollowups.answeredAt)))
    .returning({ id: schema.submissionFollowups.id });
  if (!saved) return finish(bot, interaction, "You already answered this question.");

  await tellStaff(
    bot,
    submission,
    `💬 <@${submission.applicantId}> answered <@${followup.askerId}>'s question:\n> ${followup.question.slice(0, 300).replace(/\n/g, "\n> ")}\n>>> ${answer || "*(sent files only)*"}`,
    files,
  );
  return finish(bot, interaction, "Thanks! Your answer was sent to the staff.");
}

/**
 * Into the staff thread, or as a reply to the review post without one. Names
 * people without pinging them: staff are reading the thread already, and the
 * applicant must never be pinged into a staff channel.
 */
async function tellStaff(bot: AppealyBot, submission: Submission, content: string, files: UploadedFile[] = []) {
  const target = submission.threadId ?? submission.form.logChannelId;
  const send = (text: string, attach: { blob: Blob; name: string }[]) =>
    bot.helpers.sendMessage(target, {
      content: text.slice(0, 2000),
      allowedMentions: { parse: [] },
      ...(attach.length ? { files: attach } : {}),
      ...(!submission.threadId && submission.logMessageId
        ? { messageReference: { messageId: submission.logMessageId, failIfNotExists: false } }
        : {}),
    } as never);

  // Copied, not linked: a link to an uploaded file stops working after about
  // a day. Files over what a bot can post in any server stay links.
  const copied: { blob: Blob; name: string }[] = [];
  const linked: UploadedFile[] = [];
  for (const f of files) {
    if (f.size > COPY_LIMIT_BYTES) {
      linked.push(f);
      continue;
    }
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      copied.push({ blob: await res.blob(), name: f.filename });
    } catch (err) {
      logger.warn("Couldn't copy an answer's file", { submissionId: submission.id, error: String(err) });
      linked.push(f);
    }
  }
  const links = (list: UploadedFile[]) =>
    list.length
      ? `\n-# Linked, not copied (links stop working after about a day): ${
        list.map((f) => `[${f.filename}](<${f.url}>)`).join(", ")
      }`
      : "";

  try {
    await send(content + links(linked), copied);
  } catch (err) {
    // Usually the server's upload limit. Post the answer with links rather than lose it.
    if (copied.length) {
      try {
        await send(content + links(files), []);
        return;
      } catch { /* reported below */ }
    }
    logger.warn("Couldn't post a follow-up to staff", { submissionId: submission.id, error: String(err) });
  }
}

/** What a bot can post in any server, boosted or not. */
const COPY_LIMIT_BYTES = 10 * 1024 * 1024;

interface UploadedFile {
  filename: string;
  url: string;
  size: number;
}

/** One file from the popup, found in the interaction's resolved data by its ID. */
function uploadedFile(interaction: Interaction, id: string): UploadedFile | null {
  const all = interaction.data?.resolved?.attachments as unknown as Map<bigint | string, UploadedFile> | undefined;
  if (!all) return null;
  let found: UploadedFile | undefined;
  try {
    found = all.get(BigInt(id));
  } catch { /* not a snowflake */ }
  found ??= all.get(id);
  return found?.url ? { filename: found.filename || "file", url: found.url, size: Number(found.size ?? 0) } : null;
}

/** The one text input in these modals. */
function textValue(interaction: Interaction): string {
  const row = interaction.data?.components?.[0] as { components?: { value?: string }[] } | undefined;
  return row?.components?.[0]?.value?.trim() ?? "";
}
