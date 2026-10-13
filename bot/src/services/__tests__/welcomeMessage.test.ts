// bot/src/services/__tests__/welcomeMessage.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/welcomeMessage.test.ts
//
// The message a server sees the moment it adds Appealy. These pin that it
// leads with the updates channel on the hosted platform, speaks the server's
// language, fits in an embed, and only goes where the bot may post.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { P, type SetupGuild } from "../setupRules.ts";
import { FRESH_JOIN_MS, isFreshJoin, welcomeChannel, welcomeMessage, type WelcomeChannel, type WelcomeOptions } from "../welcomeMessage.ts";

function options(overrides: Partial<WelcomeOptions> = {}): WelcomeOptions {
  return {
    ja: false,
    brand: "Appealy",
    dashboardUrl: "https://appealy.app/dashboard/guilds/1",
    supportUrl: "https://discord.gg/example",
    ids: new Map([["panel", "111"], ["apply", "333"], ["help", "555"]]),
    updatesStep: true,
    ...overrides,
  };
}

Deno.test("on the platform, picking the updates channel is step 1", () => {
  const d = welcomeMessage(options()).embeds[0].description;
  assert(d.includes("1. Open the dashboard and pick a channel for Appealy's updates"));
  assert(d.includes("2. Create a form"));
  assert(d.includes("4. Answers arrive"));
});

Deno.test("self-hosted servers aren't asked for an updates channel", () => {
  const d = welcomeMessage(options({ updatesStep: false })).embeds[0].description;
  assert(!d.includes("updates"));
  assert(d.includes("1. Create a form"));
});

Deno.test("commands are clickable mentions, or plain text when the id is unknown", () => {
  const d = welcomeMessage(options()).embeds[0].description;
  assert(d.includes("</panel create:111>"));
  assert(d.includes("</help:555>"));
  const plain = welcomeMessage(options({ ids: new Map() })).embeds[0].description;
  assert(plain.includes("`/panel create`"));
});

Deno.test("Japanese servers get it in Japanese", () => {
  const m = welcomeMessage(options({ ja: true }));
  assert(m.embeds[0].description.includes("はじめかた"));
  assertEquals(m.components[0].components[0].label, "ダッシュボードを開く");
});

Deno.test("buttons go to this server's dashboard, and support only when there is one", () => {
  const withSupport = welcomeMessage(options()).components[0].components;
  assertEquals(withSupport.map((b) => b.url), ["https://appealy.app/dashboard/guilds/1", "https://discord.gg/example"]);
  assertEquals(welcomeMessage(options({ supportUrl: "" })).components[0].components.length, 1);
});

Deno.test("it fits Discord's embed description limit", () => {
  for (const ja of [false, true]) assert(welcomeMessage(options({ ja })).embeds[0].description.length <= 4096);
});

Deno.test("only a join from the last couple of minutes counts, not a reconnect", () => {
  const now = 1_000_000_000;
  assert(isFreshJoin(now - 5_000, now));
  assert(!isFreshJoin(now - FRESH_JOIN_MS - 1, now));
  assert(!isFreshJoin(undefined, now));
});

const BOT = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS;
const guild: SetupGuild = {
  id: "1",
  ownerId: "9",
  botId: "2",
  botRoleIds: ["10"],
  roles: [
    { id: "1", name: "@everyone", position: 0, permissions: 0n },
    { id: "10", name: "Appealy", position: 5, permissions: BOT },
  ],
  channels: [],
};
const text = (id: string, position: number, overwrites: WelcomeChannel["overwrites"] = []): WelcomeChannel => ({ id, type: 0, position, overwrites });
const hidden = [{ type: 0, id: "10", allow: 0n, deny: P.SEND_MESSAGES }];

Deno.test("the system channel comes first when the bot may post there", () => {
  assertEquals(welcomeChannel(guild, [text("a", 0), text("sys", 3)], "sys"), "sys");
});

Deno.test("otherwise the highest text channel the bot may post in", () => {
  const channels = [text("low", 5), text("sys", 0, hidden), text("top", 1, hidden), text("mid", 2), { ...text("voice", 0), type: 2 }];
  assertEquals(welcomeChannel(guild, channels, "sys"), "mid");
});

Deno.test("nowhere to post means no message", () => {
  assertEquals(welcomeChannel(guild, [text("a", 0, hidden)], null), null);
});
