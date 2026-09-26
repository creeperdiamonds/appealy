// shared/services/__tests__/automodRules.test.ts
//
// Run with: deno test shared/services/__tests__/automodRules.test.ts
//
// Guards the translation between Discord's AutoMod rules and the dashboard's
// editor. The rule that matters most: saving a rule from the dashboard must
// never quietly drop a setting someone made in Discord.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTION,
  LIMITS,
  TRIGGER,
  checkRule,
  cleanWords,
  createFields,
  describeRejection,
  fromDiscord,
  toDiscord,
  type AutomodRuleInput,
  type DiscordAutomodRule,
} from "../automodRules.ts";

const APPEALY = "1000000000000000001";
const SOMEONE = "423457898095789043";

// Discord's own example rule, from its API reference.
const EXAMPLE: DiscordAutomodRule = {
  id: "969707018069872670",
  guild_id: "613425648685547541",
  name: "Keyword Filter 1",
  creator_id: SOMEONE,
  trigger_type: 1,
  event_type: 1,
  actions: [
    { type: 1, metadata: { custom_message: "Please keep financial discussions limited to the #finance channel" } },
    { type: 2, metadata: { channel_id: "123456789123456789" } },
    { type: 3, metadata: { duration_seconds: 60 } },
  ],
  trigger_metadata: {
    keyword_filter: ["cat*", "*dog", "*ana*", "i like c++"],
    regex_patterns: ["(b|c)at", "^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$"],
  },
  enabled: true,
  exempt_roles: ["323456789123456789", "423456789123456789"],
  exempt_channels: ["523456789123456789"],
};

function input(overrides: Partial<AutomodRuleInput> = {}): AutomodRuleInput {
  return {
    name: "Blocked words",
    enabled: true,
    keywords: [],
    regexPatterns: [],
    allowList: [],
    presets: [],
    mentionLimit: null,
    mentionRaidProtection: false,
    block: true,
    blockMessage: "",
    alertChannelId: null,
    timeoutSeconds: null,
    blockInteractions: false,
    exemptRoles: [],
    exemptChannels: [],
    ...overrides,
  };
}

Deno.test("Discord's example rule reads into the editor's fields", () => {
  const rule = fromDiscord(EXAMPLE, APPEALY);
  assertEquals(rule.name, "Keyword Filter 1");
  assertEquals(rule.triggerType, TRIGGER.KEYWORD);
  assertEquals(rule.keywords, ["cat*", "*dog", "*ana*", "i like c++"]);
  assertEquals(rule.regexPatterns.length, 2);
  assertEquals(rule.block, true);
  assertEquals(rule.blockMessage, "Please keep financial discussions limited to the #finance channel");
  assertEquals(rule.alertChannelId, "123456789123456789");
  assertEquals(rule.timeoutSeconds, 60);
  assertEquals(rule.blockInteractions, false);
  assertEquals(rule.exemptRoles, ["323456789123456789", "423456789123456789"]);
  assertEquals(rule.exemptChannels, ["523456789123456789"]);
  assertEquals(rule.createdByAppealy, false);
});

Deno.test("a rule Appealy created is marked, because only those count towards the badge", () => {
  assertEquals(fromDiscord({ ...EXAMPLE, creator_id: APPEALY }, APPEALY).createdByAppealy, true);
});

Deno.test("reading a rule and saving it unchanged sends Discord the same settings", () => {
  const rule = fromDiscord(EXAMPLE, APPEALY);
  const body = toDiscord(TRIGGER.KEYWORD, rule, EXAMPLE);
  assertEquals(body.actions, EXAMPLE.actions);
  assertEquals(body.trigger_metadata.keyword_filter, EXAMPLE.trigger_metadata!.keyword_filter);
  assertEquals(body.trigger_metadata.regex_patterns, EXAMPLE.trigger_metadata!.regex_patterns);
  assertEquals(body.exempt_roles, EXAMPLE.exempt_roles);
  assertEquals(body.exempt_channels, EXAMPLE.exempt_channels);
  assertEquals(body.enabled, true);
});

Deno.test("settings Discord added that this code doesn't know survive a save", () => {
  const existing = {
    trigger_metadata: { keyword_filter: ["old"], some_future_setting: 7 },
    actions: [
      { type: 1, metadata: {} },
      { type: 99, metadata: { something: "new" } },
    ],
  };
  const body = toDiscord(TRIGGER.KEYWORD, input({ keywords: ["new"] }), existing);
  assertEquals(body.trigger_metadata.some_future_setting, 7);
  assertEquals(body.trigger_metadata.keyword_filter, ["new"]);
  assertEquals(body.actions, [
    { type: ACTION.BLOCK_MESSAGE, metadata: {} },
    { type: 99, metadata: { something: "new" } },
  ]);
});

Deno.test("an action switched off in the editor is removed", () => {
  const body = toDiscord(TRIGGER.KEYWORD, input({ block: true, timeoutSeconds: null }), EXAMPLE);
  assertEquals(body.actions.map((a) => a.type), [ACTION.BLOCK_MESSAGE]);
});

Deno.test("actions a rule's type can't take are never sent", () => {
  // Discord only allows timeouts on word and mention rules, and a profile rule
  // has no message to block.
  const preset = toDiscord(
    TRIGGER.KEYWORD_PRESET,
    input({ presets: [1], timeoutSeconds: 3600, block: true }),
  );
  assertEquals(preset.actions.map((a) => a.type), [ACTION.BLOCK_MESSAGE]);

  const profile = toDiscord(
    TRIGGER.MEMBER_PROFILE,
    input({ keywords: ["x"], block: true, blockInteractions: true }),
  );
  assertEquals(profile.actions.map((a) => a.type), [ACTION.BLOCK_MEMBER_INTERACTION]);

  const mention = toDiscord(TRIGGER.MENTION_SPAM, input({ mentionLimit: 20, timeoutSeconds: 600 }));
  assertEquals(mention.actions.map((a) => a.type), [ACTION.BLOCK_MESSAGE, ACTION.TIMEOUT]);
  assertEquals(mention.trigger_metadata.mention_total_limit, 20);
});

Deno.test("a blank block message falls back to Discord's own, rather than sending an empty one", () => {
  const body = toDiscord(TRIGGER.KEYWORD, input({ blockMessage: "   " }));
  assertEquals(body.actions[0], { type: ACTION.BLOCK_MESSAGE, metadata: {} });
});

Deno.test("profile rules are checked when a profile changes; the rest when a message is sent", () => {
  assertEquals(createFields(TRIGGER.MEMBER_PROFILE), { trigger_type: 6, event_type: 2 });
  assertEquals(createFields(TRIGGER.KEYWORD), { trigger_type: 1, event_type: 1 });
});

Deno.test("word lists are trimmed, blanks dropped, and repeats removed without case", () => {
  assertEquals(cleanWords([" scam ", "", "Scam", "free nitro", "  "]), ["scam", "free nitro"]);
});

Deno.test("a rule inside every Discord limit has no problems", () => {
  const full = input({
    keywords: Array.from({ length: LIMITS.keywords }, (_, i) => `word${i}`),
    regexPatterns: Array.from({ length: LIMITS.regexPatterns }, (_, i) => `p${i}`),
    allowList: Array.from({ length: LIMITS.allowList }, (_, i) => `ok${i}`),
    blockMessage: "x".repeat(LIMITS.customMessageLength),
    timeoutSeconds: LIMITS.timeoutSeconds,
    exemptRoles: Array.from({ length: LIMITS.exemptRoles }, (_, i) => String(i)),
    exemptChannels: Array.from({ length: LIMITS.exemptChannels }, (_, i) => String(i)),
  });
  assertEquals(checkRule(TRIGGER.KEYWORD, full), []);
});

Deno.test("going one past any Discord limit is caught, and says which", () => {
  const fields = (i: AutomodRuleInput, type: typeof TRIGGER[keyof typeof TRIGGER] = TRIGGER.KEYWORD) =>
    checkRule(type, i).map((p) => p.field);

  assertEquals(fields(input({ keywords: Array.from({ length: 1001 }, (_, i) => `w${i}`) })), ["keywords"]);
  assertEquals(fields(input({ keywords: ["x".repeat(61)] })), ["keywords"]);
  assertEquals(fields(input({ regexPatterns: Array.from({ length: 11 }, (_, i) => `p${i}`) })), ["regexPatterns"]);
  assertEquals(fields(input({ regexPatterns: ["x".repeat(261)] })), ["regexPatterns"]);
  assertEquals(fields(input({ allowList: Array.from({ length: 101 }, (_, i) => `a${i}`) })), ["allowList"]);
  assertEquals(fields(input({ blockMessage: "x".repeat(151) })), ["blockMessage"]);
  assertEquals(fields(input({ timeoutSeconds: LIMITS.timeoutSeconds + 1 })), ["timeoutSeconds"]);
  assertEquals(fields(input({ exemptRoles: Array.from({ length: 21 }, (_, i) => String(i)) })), ["exemptRoles"]);
  assertEquals(fields(input({ exemptChannels: Array.from({ length: 51 }, (_, i) => String(i)) })), ["exemptChannels"]);
  assertEquals(fields(input({ name: "  " })), ["name"]);
  assertEquals(fields(input({ mentionLimit: 51 }), TRIGGER.MENTION_SPAM), ["mentionLimit"]);
});

Deno.test("the ready-made filter's allow list is Discord's larger one", () => {
  const thousand = Array.from({ length: 1000 }, (_, i) => `a${i}`);
  assertEquals(checkRule(TRIGGER.KEYWORD_PRESET, input({ presets: [1], allowList: thousand })), []);
  assertEquals(checkRule(TRIGGER.KEYWORD, input({ allowList: thousand })).map((p) => p.field), ["allowList"]);
});

Deno.test("Discord's nested form errors become one sentence naming the field", () => {
  const errors = {
    trigger_metadata: {
      keyword_filter: { 3: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 60 or fewer in length." }] } },
    },
  };
  assertEquals(describeRejection(errors), "Word 4: Must be 60 or fewer in length.");

  const action = { actions: { 0: { metadata: { channel_id: { _errors: [{ message: "Unknown channel" }] } } } } };
  assertEquals(describeRejection(action), "Alert channel: Unknown channel");

  assertEquals(describeRejection(undefined), null);
  assertEquals(describeRejection({}), null);
});
