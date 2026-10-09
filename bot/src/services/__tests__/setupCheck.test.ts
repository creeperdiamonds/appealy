// bot/src/services/__tests__/setupCheck.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { channelPermissions, checkSetup, P, type SetupForm, type SetupGuild } from "../setupRules.ts";

const BASIC = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.READ_MESSAGE_HISTORY | P.CREATE_PUBLIC_THREADS |
  P.SEND_MESSAGES_IN_THREADS | P.MANAGE_THREADS | P.MANAGE_ROLES;

function guild(over: Partial<SetupGuild> = {}): SetupGuild {
  return {
    id: "1",
    ownerId: "9",
    botId: "2",
    botRoleIds: ["10"],
    roles: [
      { id: "1", name: "@everyone", position: 0, permissions: 0n },
      { id: "10", name: "Appealy", position: 5, permissions: BASIC },
      { id: "20", name: "Member", position: 2, permissions: 0n },
      { id: "30", name: "Owner", position: 9, permissions: 0n },
    ],
    channels: [{ id: "100", name: "apps", overwrites: [] }],
    ...over,
  };
}
const form = (over: Partial<SetupForm> = {}): SetupForm => ({
  id: "f",
  name: "Moderator",
  logChannelId: "100",
  acceptedChannelId: null,
  deniedChannelId: null,
  threads: true,
  archiveOnDecision: true,
  roleIds: ["20"],
  outcomeChannelIds: [],
  ...over,
});

Deno.test("a correct setup has no problems", () => {
  assertEquals(checkSetup(guild(), [form()]), []);
});

Deno.test("channel overwrites apply in Discord's order: @everyone, roles, then the member", () => {
  const g = guild();
  const denyEveryone = [{ type: 0, id: "1", allow: 0n, deny: P.VIEW_CHANNEL }];
  assert(!(channelPermissions(g, denyEveryone) & P.VIEW_CHANNEL));
  const roleAllows = [...denyEveryone, { type: 0, id: "10", allow: P.VIEW_CHANNEL, deny: 0n }];
  assert(channelPermissions(g, roleAllows) & P.VIEW_CHANNEL);
  const memberDenies = [...roleAllows, { type: 1, id: "2", allow: 0n, deny: P.VIEW_CHANNEL }];
  assert(!(channelPermissions(g, memberDenies) & P.VIEW_CHANNEL));
});

Deno.test("a private review channel is reported by name, with what's missing", () => {
  const g = guild({ channels: [{ id: "100", name: "apps", overwrites: [{ type: 0, id: "1", allow: 0n, deny: P.VIEW_CHANNEL | P.SEND_MESSAGES }] }] });
  const [issue] = checkSetup(g, [form()]);
  assertEquals(issue.level, "act");
  assertEquals(issue.message, "Appealy is missing View Channel, Send Messages in #apps, the review channel.");
});

Deno.test("deleted channels and roles, and roles above Appealy, are caught", () => {
  const messages = checkSetup(guild(), [form({ logChannelId: "404", roleIds: ["30", "404"] })]).map((i) => i.message);
  assert(messages.includes("The review channel was deleted. Pick a new one."));
  assert(messages.some((m) => m.startsWith("@Owner is above Appealy's highest role")));
  assert(messages.includes("One of this form's roles was deleted. Remove it from the form."));
});

Deno.test("Administrator covers channels but not role order", () => {
  const g = guild();
  g.roles[1].permissions = P.ADMINISTRATOR;
  const g2 = { ...g, channels: [{ id: "100", name: "apps", overwrites: [{ type: 0, id: "1", allow: 0n, deny: P.VIEW_CHANNEL }] }] };
  const messages = checkSetup(g2, [form({ roleIds: ["30"] })]).map((i) => i.message);
  assertEquals(messages.length, 1);
  assert(messages[0].startsWith("@Owner is above"));
});

Deno.test("threads only need thread permissions when the form uses them", () => {
  const g = guild();
  g.roles[1].permissions = BASIC & ~P.CREATE_PUBLIC_THREADS;
  assertEquals(checkSetup(g, [form({ threads: false })]), []);
  assertEquals(checkSetup(g, [form()]).length, 1);
});
