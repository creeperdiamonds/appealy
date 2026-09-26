// bot/src/services/__tests__/helpMessage.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/helpMessage.test.ts
//
// /help is what a top.gg reviewer opens first. These pin that it lists every
// command, in the right group, in the asker's language, inside Discord's embed
// limits, with a way to the dashboard.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import { helpMessage, type HelpOptions } from "../helpMessage.ts";

const SUB = 1; // Discord's subcommand option type

// Shaped like the real ones in bot/src/commands, which can't be imported here:
// they load the environment, and these tests run without one.
const DEFINITIONS = [
  { name: "panel", description: "Manage application panels", defaultMemberPermissions: ["ADMINISTRATOR"], options: [
    { name: "create", description: "Create and publish a panel for a form in this channel", descriptionLocalizations: { ja: "このチャンネルにフォームのパネルを作成して公開します" }, type: SUB },
  ] },
  { name: "forms", description: "List all application forms configured in this server", descriptionLocalizations: { ja: "このサーバーの応募フォームを一覧表示します" } },
  { name: "apply", description: "Apply for an application form in this server" },
  { name: "giveaway", description: "Manage giveaways", defaultMemberPermissions: ["ADMINISTRATOR"], options: [
    { name: "create", description: "Create and start a giveaway", type: SUB },
    { name: "end", description: "End a giveaway early", type: SUB },
  ] },
  { name: "export", description: "Export all of this server's Appealy data as a JSON file (owner only)" },
  { name: "import-appealy", description: "Import another server's Appealy setup from an /export file", defaultMemberPermissions: ["ADMINISTRATOR"] },
  { name: "ping", description: "Check the bot's latency" },
] as unknown as CreateApplicationCommand[];

function options(overrides: Partial<HelpOptions> = {}): HelpOptions {
  return {
    ja: false,
    brand: "Appealy",
    dashboardUrl: "https://appealy.app/dashboard/guilds/1",
    docsUrl: "https://docs.appealy.app",
    supportUrl: "https://discord.gg/example",
    ids: new Map([["panel", "111"], ["forms", "222"], ["apply", "333"], ["giveaway", "444"]]),
    ...overrides,
  };
}

function fieldText(message: ReturnType<typeof helpMessage>) {
  return message.embeds[0].fields.map((f) => `${f.name}\n${f.value}`).join("\n");
}

Deno.test("every command and subcommand is listed", () => {
  const text = fieldText(helpMessage(DEFINITIONS, options()));
  for (const expected of ["</panel create:111>", "</forms:222>", "</apply:333>", "</giveaway create:444>",
    "</giveaway end:444>", "`/export`", "`/import-appealy`", "`/ping`"]) {
    assert(text.includes(expected), `missing ${expected}`);
  }
});

Deno.test("commands Discord has an id for are clickable; the rest are plain text", () => {
  const text = fieldText(helpMessage(DEFINITIONS, options({ ids: new Map() })));
  assert(text.includes("`/apply`"));
  assert(!text.includes("</"));
});

Deno.test("commands are grouped for everyone, for admins, and for moving data", () => {
  const [everyone, admins, data] = helpMessage(DEFINITIONS, options()).embeds[0].fields;
  assertEquals(everyone.name, "Commands for everyone");
  assert(everyone.value.startsWith("</apply:333>"), "apply leads the list");
  assert(everyone.value.includes("</forms:222>") && everyone.value.includes("`/ping`"));
  assertEquals(admins.name, "Commands for server admins");
  assert(admins.value.includes("</panel create:111>") && admins.value.includes("</giveaway end:444>"));
  assertEquals(data.name, "Moving your data");
  assert(data.value.includes("`/export`") && data.value.includes("`/import-appealy`"));
});

Deno.test("the getting-started steps mention the commands they're about", () => {
  const { description } = helpMessage(DEFINITIONS, options()).embeds[0];
  assert(description.includes("</panel create:111>"));
  assert(description.includes("</apply:333>"));
});

Deno.test("Japanese uses the commands' own Japanese descriptions, and English where there isn't one", () => {
  const message = helpMessage(DEFINITIONS, options({ ja: true }));
  const embed = message.embeds[0];
  assertEquals(embed.title, "Appealy ヘルプ");
  const text = fieldText(message);
  assert(text.includes("このサーバーの応募フォームを一覧表示します"));
  assert(text.includes("このチャンネルにフォームのパネルを作成して公開します"));
  assert(text.includes("Apply for an application form in this server"), "falls back to English");
  assertEquals(message.components[0].components[0].label, "ダッシュボードを開く");
});

Deno.test("links to the dashboard and the docs, and to support only when there's somewhere to go", () => {
  const withSupport = helpMessage(DEFINITIONS, options()).components[0].components;
  assertEquals(withSupport.map((b) => b.url), [
    "https://appealy.app/dashboard/guilds/1",
    "https://docs.appealy.app",
    "https://discord.gg/example",
  ]);
  for (const b of withSupport) assertEquals([b.type, b.style], [2, 5]);
  const without = helpMessage(DEFINITIONS, options({ supportUrl: "" })).components[0].components;
  assertEquals(without.length, 2);
});

Deno.test("a long list is split to stay inside Discord's 1024-character fields", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `command-${i}`,
    description: "A description as long as the longest real one, give or take a few words",
    defaultMemberPermissions: ["ADMINISTRATOR"],
  })) as unknown as CreateApplicationCommand[];
  const fields = helpMessage(many, options()).embeds[0].fields;
  assert(fields.length > 1);
  for (const f of fields) assert(f.value.length <= 1024, `${f.value.length} characters`);
  assertEquals(fields[0].name, "Commands for server admins");
  assert(fields.slice(1).every((f) => f.name === "​"), "continuations read as the same list");
  assertEquals(fields.flatMap((f) => f.value.split("\n")).length, 40);
});

Deno.test("a full command list fits Discord's 6000-character embed limit", () => {
  // Eighteen commands with 20-digit ids and long descriptions: more than the
  // real list, which has shorter names and descriptions.
  const eighteen = Array.from({ length: 18 }, (_, i) => ({
    name: `long-command-name-${i}`,
    description: "x".repeat(100),
    options: [{ name: "subcommand", description: "y".repeat(100), type: SUB }],
  })) as unknown as CreateApplicationCommand[];
  const ids = new Map(eighteen.map((d) => [d.name, "12345678901234567890"]));
  const embed = helpMessage(eighteen, options({ ids })).embeds[0];
  const total = embed.title.length + embed.description.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert(total <= 6000, `${total} characters`);
});
