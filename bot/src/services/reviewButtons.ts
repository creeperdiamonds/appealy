// bot/src/services/reviewButtons.ts
//
// The buttons under a pending submission's review post, in one place so the
// post as first sent (interactions/modals/formSubmit.ts) and the post after a
// vote (interactions/buttons/reviewVote.ts) can't drift apart:
//
//   [Accept] [Deny] [👍 n] [👎 n] [Ask applicant]
//
// Five is Discord's limit for one row. Deciding removes the whole row
// (services/reviewPost.ts), which is also what ends voting and questions.

import { encodeCustomId } from "../../../shared/types/index.ts";

export interface VoteCounts {
  up: number;
  down: number;
}

/** Discord's button styles. */
const SUCCESS = 3;
const DANGER = 4;
const SECONDARY = 2;

export function reviewButtonRow(submissionId: string, votes: VoteCounts = { up: 0, down: 0 }) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: SUCCESS, label: "Accept", customId: encodeCustomId("review", "accept", submissionId) },
        { type: 2, style: DANGER, label: "Deny", customId: encodeCustomId("review", "deny", submissionId) },
        {
          type: 2,
          style: SECONDARY,
          emoji: { name: "👍" },
          label: String(votes.up),
          customId: encodeCustomId("review", "vote", submissionId, "up"),
        },
        {
          type: 2,
          style: SECONDARY,
          emoji: { name: "👎" },
          label: String(votes.down),
          customId: encodeCustomId("review", "vote", submissionId, "down"),
        },
        { type: 2, style: SECONDARY, label: "Ask applicant", customId: encodeCustomId("review", "ask", submissionId) },
      ],
    },
  ];
}

/** The "Staff votes" field on the review post: who voted which way. */
export const VOTES_FIELD = "Staff votes";

export function votesFieldValue(votes: { voterId: bigint; vote: string }[]): string {
  const who = (v: string) => votes.filter((x) => x.vote === v).map((x) => `<@${x.voterId}>`).join(" ");
  const lines = [
    votes.some((x) => x.vote === "up") ? `👍 ${who("up")}` : null,
    votes.some((x) => x.vote === "down") ? `👎 ${who("down")}` : null,
  ].filter(Boolean);
  // Discord's limit on a field's value.
  const text = lines.join("\n") || "No votes yet";
  return text.length > 1024 ? `${text.slice(0, 1023)}…` : text;
}

/** The embed's fields with the votes field replaced (or added, or dropped once empty). */
export function withVotesField(
  fields: { name: string; value: string; inline?: boolean }[] | undefined,
  votes: { voterId: bigint; vote: string }[],
) {
  const rest = (fields ?? []).filter((f) => f.name !== VOTES_FIELD);
  if (votes.length === 0) return rest;
  // Discord allows 25 fields; the votes field gives way to an answer, never the reverse.
  return [...rest.slice(0, 24), { name: VOTES_FIELD, value: votesFieldValue(votes), inline: false }];
}
