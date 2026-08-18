// bot/src/events/interactionCreate.ts
//
// Single entrypoint for every interaction Discord sends us. Routes by
// InteractionType, then for components/modals routes again by the
// namespace segment of custom_id (see shared/types/index.ts).
//
// Keeping routing centralized here (rather than scattering `bot.events.X =`
// assignments) means every interaction handler has one place to be found,
// and lets us wrap all of them in the same error boundary + defer logic.

import { InteractionTypes, MessageComponentTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { AppealyBot } from "../core/client.ts";

import { decodeCustomId } from "../../../shared/types/index.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.ts";

import { handlePanelOpenButton, proceedToQuestions } from "../interactions/buttons/panelOpen.ts";
import { handleReviewAccept } from "../interactions/buttons/reviewAccept.ts";
import { handleReviewDeny } from "../interactions/buttons/reviewDeny.ts";
import { handleFormModalSubmit } from "../interactions/modals/formSubmit.ts";
import { handleDenyReasonModalSubmit } from "../interactions/modals/denyReason.ts";
import { handleFormSelectStep } from "../interactions/selects/formSelectStep.ts";
import { handlePollVote } from "../interactions/selects/pollVote.ts";
import { handleRoleMenuSelect } from "../interactions/selects/roleMenuSelect.ts";
import { handleTicketOpenButton } from "../interactions/buttons/ticketOpen.ts";
import { handleTicketCloseButton, handleTicketClaimButton, handleTicketRateButton } from "../interactions/buttons/ticketClose.ts";
import { handleGiveawayEnterButton } from "../interactions/buttons/giveawayEnter.ts";
import { handleVerifyButton } from "../interactions/buttons/verify.ts";
import { handleVerifyCaptchaModalSubmit } from "../interactions/modals/verifyCaptcha.ts";
import { routeSlashCommand, routeAutocomplete } from "../commands/index.ts";
import { passesBanGate } from "../core/banGate.ts";
import { absorbFromInteraction } from "../core/entitlements.ts";

export function onInteractionCreate(bot: AppealyBot) {
  return async (interaction: Interaction) => {
    try {
      // Before routing, before defer, before any database read. A banned
      // subject costs us one in-memory Map lookup and nothing else.
      if (!(await passesBanGate(bot, interaction))) return;

      // Every interaction carries the caller's entitlements. Free, and it
      // self-heals anything the gateway dropped across a reconnect.
      absorbFromInteraction((interaction as { entitlements?: never[] }).entitlements);

      switch (interaction.type) {
        case InteractionTypes.ApplicationCommand: {
          await routeSlashCommand(bot, interaction);
          return;
        }

        case InteractionTypes.ApplicationCommandAutocomplete: {
          await routeAutocomplete(bot, interaction);
          return;
        }

        case InteractionTypes.MessageComponent: {
          const customId = interaction.data?.customId;
          if (!customId) return;
          const { namespace, action, entityId, extra } = decodeCustomId(customId);

          if (namespace === "panel" && action === "open") {
            return await handlePanelOpenButton(bot, interaction, entityId);
          }
          if (namespace === "modal" && action === "confirm") {
            const form = await db.query.forms.findFirst({
              where: eq(schema.forms.id, entityId),
              with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
            });
            if (form) return await proceedToQuestions(bot, interaction, entityId, form);
            return;
          }
          if (namespace === "panel" && action === "select_open") {
            // entityId is the panelId here, not a formId; the chosen formId
            // comes from the select menu's value, matching dropdown-mode
            // panels built in bot/src/core/controlServer.ts.
            const chosenFormId = interaction.data?.values?.[0];
            if (chosenFormId) {
              return await handlePanelOpenButton(bot, interaction, chosenFormId);
            }
            return;
          }
          if (namespace === "review" && action === "accept") {
            return await handleReviewAccept(bot, interaction, entityId);
          }
          // Outcome menu: entityId is the submissionId, the chosen outcome id
          // arrives as the select value. Same handler — it branches on whether
          // an outcome was chosen rather than duplicating the accept path.
          if (namespace === "review" && action === "outcome") {
            const chosen = interaction.data?.values?.[0];
            if (!chosen) return;
            return await handleReviewAccept(bot, interaction, entityId, chosen);
          }
          // Confirm click. `extra` carries the submissionId; entityId is the
          // outcome. interaction.message.interaction.token is not available
          // here, so the staged token is the confirm message's own custom_id
          // suffix — see outcomeConfirm.ts.
          if (namespace === "review" && action === "confirm") {
            if (!extra) return;
            return await handleReviewAccept(bot, interaction, extra, entityId, extra);
          }
          if (namespace === "review" && action === "denyoutcome") {
            const chosen = interaction.data?.values?.[0];
            if (!chosen) return;
            return await handleReviewDeny(bot, interaction, entityId, chosen);
          }
          if (namespace === "review" && action === "cancel") {
            return await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
              type: 7, // update the ephemeral message in place
              data: { content: "Cancelled — nothing was applied.", embeds: [], components: [] },
            });
          }
          if (namespace === "review" && action === "deny") {
            return await handleReviewDeny(bot, interaction, entityId);
          }
          if (namespace === "poll" && action === "vote") {
            return await handlePollVote(bot, interaction, entityId, extra);
          }
          if (namespace === "modal" && action === "select") {
            return await handleFormSelectStep(bot, interaction, entityId, extra);
          }
          if (namespace === "ticket" && action === "open") {
            return await handleTicketOpenButton(bot, interaction, entityId);
          }
          if (namespace === "ticket" && action === "close") {
            return await handleTicketCloseButton(bot, interaction, entityId);
          }
          if (namespace === "ticket" && action === "claim") {
            return await handleTicketClaimButton(bot, interaction, entityId);
          }
          if (namespace === "ticket" && action === "rate") {
            return await handleTicketRateButton(bot, interaction, entityId, extra);
          }
          if (namespace === "giveaway" && action === "enter") {
            return await handleGiveawayEnterButton(bot, interaction, entityId);
          }
          if (namespace === "verify" && action === "start") {
            return await handleVerifyButton(bot, interaction, entityId);
          }
          if (namespace === "rolemenu" && action === "select") {
            return await handleRoleMenuSelect(bot, interaction, entityId);
          }

          logger.warn("Unhandled message component interaction", { customId });
          return;
        }

        case InteractionTypes.ModalSubmit: {
          const customId = interaction.data?.customId;
          if (!customId) return;
          const { namespace, action, entityId } = decodeCustomId(customId);

          if (namespace === "modal" && action === "submit") {
            return await handleFormModalSubmit(bot, interaction, entityId);
          }
          if (namespace === "review" && action === "deny_confirm") {
            return await handleDenyReasonModalSubmit(bot, interaction, entityId);
          }
          if (namespace === "verify" && action === "captcha_confirm") {
            return await handleVerifyCaptchaModalSubmit(bot, interaction, entityId);
          }

          logger.warn("Unhandled modal submit interaction", { customId });
          return;
        }

        default:
          return;
      }
    } catch (err) {
      logger.error("Unhandled error in interactionCreate", {
        error: err instanceof Error ? err.stack : String(err),
        interactionId: interaction.id?.toString(),
      });

      // Best-effort user-facing error response; ignore failures here since
      // the interaction token may already be invalid/expired/acknowledged.
      try {
        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "Something went wrong processing that. Please try again.",
            flags: 64, // ephemeral
          },
        });
      } catch {
        // swallow — interaction already responded to or token expired
      }
    }
  };
}
