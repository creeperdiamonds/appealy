// bot/src/services/__tests__/roleHierarchy.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AppealyBot } from "../../core/client.ts";
import { findUnmanageableRoles } from "../roleHierarchy.ts";

const GUILD = 100000000000000000n;
const BOT_ROLE = 300000000000000000n;
const BELOW = 400000000000000000n;
const ABOVE = 500000000000000000n;

const holding = (...permissions: string[]) => ({ has: (p: string) => permissions.includes(p) });

function fakeBot(botPermissions = holding("MANAGE_ROLES")) {
  const roles = [
    { id: GUILD, position: 0, permissions: holding() },
    { id: BOT_ROLE, position: 5, permissions: botPermissions },
    { id: BELOW, position: 3, permissions: holding() },
    { id: ABOVE, position: 8, permissions: holding() },
  ];
  return {
    id: 200000000000000000n,
    helpers: {
      getGuild: () => Promise.resolve({ roles }),
      getMember: () => Promise.resolve({ roles: [BOT_ROLE] }),
    },
  } as unknown as AppealyBot;
}

Deno.test("a role above the bot's is reported, and one below isn't", async () => {
  assertEquals(await findUnmanageableRoles(fakeBot(), GUILD, [String(BELOW), String(ABOVE)]), [String(ABOVE)]);
});

Deno.test("without Manage Roles, every role is out of reach", async () => {
  assertEquals(
    await findUnmanageableRoles(fakeBot(holding()), GUILD, [String(BELOW), String(ABOVE)]),
    [String(BELOW), String(ABOVE)],
  );
});

Deno.test("a role deleted from the server isn't the bot's problem", async () => {
  assertEquals(await findUnmanageableRoles(fakeBot(), GUILD, ["600000000000000000"]), []);
});

// Every caller filters on this list before calling BigInt on what's left, so
// reporting it here is what stops a saved role name from breaking accept and deny.
Deno.test("text that isn't an ID is reported rather than thrown", async () => {
  assertEquals(await findUnmanageableRoles(fakeBot(), GUILD, ["Moderators", String(BELOW)]), ["Moderators"]);
});

Deno.test("so is it without Manage Roles", async () => {
  assertEquals(
    await findUnmanageableRoles(fakeBot(holding()), GUILD, ["Moderators", String(BELOW)]),
    ["Moderators", String(BELOW)],
  );
});

Deno.test("a list with no IDs in it doesn't need to ask Discord", async () => {
  const bot = {
    helpers: {
      getGuild: () => Promise.reject(new Error("nothing to ask about")),
      getMember: () => Promise.reject(new Error("nothing to ask about")),
    },
  } as unknown as AppealyBot;
  assertEquals(await findUnmanageableRoles(bot, GUILD, ["Moderators"]), ["Moderators"]);
});
