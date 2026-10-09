// bot/src/services/__tests__/reviewButtons.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reviewButtonRow, VOTES_FIELD, votesFieldValue, withVotesField } from "../reviewButtons.ts";
import { statusLine } from "../applicationStatus.ts";

Deno.test("the review row stays inside Discord's five buttons and shows the counts", () => {
  const [row] = reviewButtonRow("s1", { up: 3, down: 1 });
  assertEquals(row.components.length, 5);
  assertEquals(row.components.map((c) => c.label), ["Accept", "Deny", "3", "1", "Ask applicant"]);
  assertEquals(row.components[2].customId, "review:vote:s1:up");
});

Deno.test("the votes field names who voted which way, and goes away when empty", () => {
  const votes = [{ voterId: 1n, vote: "up" }, { voterId: 2n, vote: "down" }, { voterId: 3n, vote: "up" }];
  assertEquals(votesFieldValue(votes), "👍 <@1> <@3>\n👎 <@2>");
  const fields = [{ name: "Why?", value: "x" }, { name: VOTES_FIELD, value: "old" }];
  assertEquals(withVotesField(fields, votes).map((f) => f.name), ["Why?", VOTES_FIELD]);
  assertEquals(withVotesField(fields, []).map((f) => f.name), ["Why?"]);
});

Deno.test("/application status says where each application stands", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const decided = new Date("2026-10-03T00:00:00Z");
  assertEquals(
    statusLine({ formName: "Moderator", status: "pending", outcomeLabel: null, createdAt: at, reviewedAt: null }),
    "🕓 **Moderator** · Waiting for review · applied <t:1790812800:R>",
  );
  assertEquals(
    statusLine({ formName: "Staff", status: "accepted", outcomeLabel: "Trainee", createdAt: at, reviewedAt: decided }),
    "✅ **Staff** · Accepted as Trainee · applied <t:1790812800:R>, decided <t:1790985600:R>",
  );
});
