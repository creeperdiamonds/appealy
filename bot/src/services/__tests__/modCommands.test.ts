// bot/src/services/__tests__/modCommands.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/modCommands.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkAction,
  formatDuration,
  type GuildInfo,
  MAX_TIMEOUT_MS,
  memberPermissions,
  parseDuration,
  parseModCommand,
  parseUserId,
  PERM,
} from "../modCommands.ts";

const BOT = 1538863299574112326n;
const GUILD = 100000000000000001n;
const OWNER = 100000000000000002n;
const MOD = 100000000000000003n;
const MEMBER = 100000000000000004n;
const ADMIN_ROLE = 200000000000000001n;
const MOD_ROLE = 200000000000000002n;
const MEMBER_ROLE = 200000000000000003n;

const guild: GuildInfo = {
  id: GUILD,
  ownerId: OWNER,
  roles: [
    { id: GUILD, position: 0, permissions: 0n },
    { id: MEMBER_ROLE, position: 1, permissions: 0n },
    { id: MOD_ROLE, position: 5, permissions: PERM.BAN_MEMBERS | PERM.KICK_MEMBERS | PERM.MODERATE_MEMBERS },
    { id: ADMIN_ROLE, position: 10, permissions: PERM.ADMINISTRATOR },
  ],
};

Deno.test("the prefix and a mention of Appealy both start a command", () => {
  assertEquals(parseModCommand("?ban <@123456789012345678> spamming", BOT), {
    action: "ban",
    args: ["<@123456789012345678>", "spamming"],
  });
  assertEquals(parseModCommand(`<@${BOT}> kick 123456789012345678`, BOT)?.action, "kick");
  assertEquals(parseModCommand(`<@!${BOT}>   MUTE <@123456789012345678> 10m`, BOT)?.action, "mute");
});

Deno.test("aliases, and things that are not commands", () => {
  assertEquals(parseModCommand("?timeout x", BOT)?.action, "mute");
  assertEquals(parseModCommand("?untimeout x", BOT)?.action, "unmute");
  assertEquals(parseModCommand("?help", BOT), null);
  assertEquals(parseModCommand("is this a ban?", BOT), null);
  assertEquals(parseModCommand("<@123456789012345678> ban someone", BOT), null, "mentioning someone else");
  assertEquals(parseModCommand("", BOT), null);
});

Deno.test("users come from mentions or bare ids", () => {
  assertEquals(parseUserId("<@123456789012345678>"), 123456789012345678n);
  assertEquals(parseUserId("<@!123456789012345678>"), 123456789012345678n);
  assertEquals(parseUserId("123456789012345678"), 123456789012345678n);
  assertEquals(parseUserId("@someone"), null);
  assertEquals(parseUserId(undefined), null);
});

Deno.test("durations", () => {
  assertEquals(parseDuration("10m"), 600_000);
  assertEquals(parseDuration("1h30m"), 5_400_000);
  assertEquals(parseDuration("2D"), 172_800_000);
  assertEquals(parseDuration("1w"), 604_800_000);
  assertEquals(parseDuration("spamming"), null);
  assertEquals(parseDuration("10"), null);
  assertEquals(parseDuration("0m"), null);
  assertEquals(formatDuration(5_400_000), "1h 30m");
  assertEquals(formatDuration(MAX_TIMEOUT_MS), "28d");
});

Deno.test("permissions add up across roles, and admin or owner means everything", () => {
  assertEquals(memberPermissions(guild, MEMBER, [MEMBER_ROLE]) & PERM.BAN_MEMBERS, 0n);
  assertEquals(memberPermissions(guild, MOD, [MOD_ROLE]) & PERM.BAN_MEMBERS, PERM.BAN_MEMBERS);
  assertEquals(memberPermissions(guild, MEMBER, [ADMIN_ROLE]) & PERM.MODERATE_MEMBERS, PERM.MODERATE_MEMBERS);
  assertEquals(memberPermissions(guild, OWNER, []) & PERM.BAN_MEMBERS, PERM.BAN_MEMBERS);
});

Deno.test("who may act on whom", () => {
  const mod = { id: MOD, roleIds: [MOD_ROLE] };
  assertEquals(checkAction(guild, "ban", mod, { id: MEMBER, roleIds: [MEMBER_ROLE] }, BOT), null);
  assertEquals(checkAction(guild, "ban", { id: MEMBER, roleIds: [MEMBER_ROLE] }, { id: MOD, roleIds: [MOD_ROLE] }, BOT), {
    reason: "missing_permission",
    permission: "Ban Members",
  });
  assertEquals(checkAction(guild, "kick", mod, { id: MOD, roleIds: [MOD_ROLE] }, BOT)?.reason, "self");
  assertEquals(checkAction(guild, "kick", mod, { id: BOT, roleIds: [] }, BOT)?.reason, "bot");
  assertEquals(checkAction(guild, "kick", mod, { id: OWNER, roleIds: [] }, BOT)?.reason, "owner");
  assertEquals(
    checkAction(guild, "mute", mod, { id: MEMBER, roleIds: [ADMIN_ROLE] }, BOT)?.reason,
    "hierarchy",
    "a member ranked above the moderator",
  );
  assertEquals(
    checkAction(guild, "mute", mod, { id: MEMBER, roleIds: [MOD_ROLE] }, BOT)?.reason,
    "hierarchy",
    "an equal rank is refused too, as Discord does",
  );
  assertEquals(checkAction(guild, "ban", { id: OWNER, roleIds: [] }, { id: MEMBER, roleIds: [ADMIN_ROLE] }, BOT), null);
  assertEquals(checkAction(guild, "unban", mod, { id: MEMBER, roleIds: null }, BOT), null, "not in the server: no rank");
});
