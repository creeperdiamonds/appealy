// shared/services/automodRules.ts
//
// Discord's AutoMod, in the shape the dashboard edits it.
//
// Discord holds the rules and Appealy stores none of them: the dashboard reads
// and writes them through the bot, because the API has no bot token. This file
// is the one translation between the two shapes: Discord's rule object
// (snake_case, actions as a list) and the dashboard's (one field for each thing
// a person can switch on).
//
// The reason the page exists at all: Discord's own apps can't edit AutoMod on a
// phone. Its FAQ says so: "Updates to your AutoMod rules cannot be made on
// mobile devices at this time." The dashboard can, so it has to be able to do
// everything Discord's desktop settings can.
//
// Every limit here is Discord's, copied from its API reference
// (developers/resources/auto-moderation). Appealy adds none of its own: a rule
// Discord would accept, the dashboard accepts.
//
// Pure, so the bot, the API and the tests can all share it.

export const TRIGGER = {
  KEYWORD: 1,
  SPAM: 3,
  KEYWORD_PRESET: 4,
  MENTION_SPAM: 5,
  MEMBER_PROFILE: 6,
} as const;

export type TriggerType = (typeof TRIGGER)[keyof typeof TRIGGER];

export const ACTION = {
  BLOCK_MESSAGE: 1,
  SEND_ALERT_MESSAGE: 2,
  TIMEOUT: 3,
  BLOCK_MEMBER_INTERACTION: 4,
} as const;

export const EVENT = {
  MESSAGE_SEND: 1,
  MEMBER_UPDATE: 2,
} as const;

export const PRESET = {
  PROFANITY: 1,
  SEXUAL_CONTENT: 2,
  SLURS: 3,
} as const;

/** Discord's limits, from its API reference. */
export const LIMITS = {
  /** How many rules of each trigger type one server may hold. */
  perGuild: { 1: 6, 3: 1, 4: 1, 5: 1, 6: 1 } as Record<TriggerType, number>,
  keywords: 1000,
  keywordLength: 60,
  regexPatterns: 10,
  regexLength: 260,
  /** allow_list on word and profile rules. */
  allowList: 100,
  /** allow_list on the ready-made (preset) rule. */
  presetAllowList: 1000,
  allowLength: 60,
  mentionTotalLimit: 50,
  exemptRoles: 20,
  exemptChannels: 50,
  customMessageLength: 150,
  /** Four weeks, the longest timeout Discord allows. */
  timeoutSeconds: 2_419_200,
} as const;

export function isKnownTrigger(type: number): type is TriggerType {
  return (Object.values(TRIGGER) as number[]).includes(type);
}

/**
 * Which actions a rule of this type can take.
 *
 * TIMEOUT on word and mention rules only is Discord's documented rule. The
 * others follow from what the rule watches: a profile rule has no message to
 * block, and only a profile rule blocks someone from talking until they
 * change it.
 */
export function actionsFor(type: TriggerType) {
  return {
    block: type !== TRIGGER.MEMBER_PROFILE,
    alert: true,
    timeout: type === TRIGGER.KEYWORD || type === TRIGGER.MENTION_SPAM,
    blockInteractions: type === TRIGGER.MEMBER_PROFILE,
  };
}

// ---------------------------------------------------------------------------
// Discord's shape
// ---------------------------------------------------------------------------

export interface DiscordAutomodAction {
  type: number;
  metadata?: Record<string, unknown>;
}

export interface DiscordAutomodRule {
  id: string;
  guild_id: string;
  name: string;
  creator_id: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata?: Record<string, unknown>;
  actions: DiscordAutomodAction[];
  enabled: boolean;
  exempt_roles: string[];
  exempt_channels: string[];
}

// ---------------------------------------------------------------------------
// The dashboard's shape
// ---------------------------------------------------------------------------

/** What a person can set on a rule. Fields a rule's type doesn't use are ignored. */
export interface AutomodRuleInput {
  name: string;
  enabled: boolean;
  keywords: string[];
  regexPatterns: string[];
  allowList: string[];
  presets: number[];
  mentionLimit: number | null;
  mentionRaidProtection: boolean;
  /** Stop the message being posted. */
  block: boolean;
  /** Shown to the member when their message is blocked. Empty means Discord's default. */
  blockMessage: string;
  /** Post an alert to this channel. Null means no alert. */
  alertChannelId: string | null;
  /** Time the member out for this long. Null means no timeout. */
  timeoutSeconds: number | null;
  /** Profile rules: stop the member talking until they change their profile. */
  blockInteractions: boolean;
  exemptRoles: string[];
  exemptChannels: string[];
}

export interface AutomodRule extends AutomodRuleInput {
  id: string;
  /** A plain number, because Discord may add types this code has never seen. */
  triggerType: number;
  /** Only rules Appealy created count towards Discord's "Uses AutoMod" badge. */
  createdByAppealy: boolean;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function firstOfType(actions: DiscordAutomodAction[], type: number) {
  return actions.find((a) => a.type === type);
}

/** Discord's rule object, as the dashboard shows it. */
export function fromDiscord(raw: DiscordAutomodRule, appealyUserId: string): AutomodRule {
  const meta = raw.trigger_metadata ?? {};
  const actions = raw.actions ?? [];
  const block = firstOfType(actions, ACTION.BLOCK_MESSAGE);
  const alert = firstOfType(actions, ACTION.SEND_ALERT_MESSAGE);
  const timeout = firstOfType(actions, ACTION.TIMEOUT);

  return {
    id: raw.id,
    name: raw.name,
    triggerType: raw.trigger_type,
    enabled: raw.enabled,
    createdByAppealy: raw.creator_id === appealyUserId,
    keywords: strings(meta.keyword_filter),
    regexPatterns: strings(meta.regex_patterns),
    allowList: strings(meta.allow_list),
    presets: Array.isArray(meta.presets) ? meta.presets.map(Number) : [],
    mentionLimit: typeof meta.mention_total_limit === "number" ? meta.mention_total_limit : null,
    mentionRaidProtection: meta.mention_raid_protection_enabled === true,
    block: block !== undefined,
    blockMessage: typeof block?.metadata?.custom_message === "string" ? block.metadata.custom_message : "",
    alertChannelId: alert?.metadata?.channel_id != null ? String(alert.metadata.channel_id) : null,
    timeoutSeconds:
      typeof timeout?.metadata?.duration_seconds === "number" ? timeout.metadata.duration_seconds : null,
    blockInteractions: firstOfType(actions, ACTION.BLOCK_MEMBER_INTERACTION) !== undefined,
    exemptRoles: strings(raw.exempt_roles),
    exemptChannels: strings(raw.exempt_channels),
  };
}

/**
 * A word list as typed: trimmed, blanks dropped, and repeats removed.
 *
 * Repeats are compared without case because Discord matches keywords without
 * case, so "Scam" after "scam" would only use up one of the 1000 places.
 * Regex patterns go through cleanPatterns instead: case can matter there.
 */
export function cleanWords(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const word = raw.trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

export function cleanPatterns(list: readonly string[]): string[] {
  return [...new Set(list.map((p) => p.trim()).filter(Boolean))];
}

/**
 * The body to send Discord to create a rule, or to replace an existing one's
 * settings.
 *
 * When editing, `existing` is the rule as Discord has it now, and anything in
 * it that this code doesn't understand is kept. Discord adds trigger fields
 * and action types over time, and saving a rule from the dashboard must not
 * silently strip a setting that someone made in Discord. Two actions of a
 * type the dashboard knows are the exception: the dashboard shows one, so it
 * keeps one.
 */
export function toDiscord(
  type: TriggerType,
  input: AutomodRuleInput,
  existing?: Pick<DiscordAutomodRule, "trigger_metadata" | "actions">,
) {
  const can = actionsFor(type);
  const actions: DiscordAutomodAction[] = [];

  if (can.block && input.block) {
    const message = input.blockMessage.trim();
    actions.push({
      type: ACTION.BLOCK_MESSAGE,
      metadata: message ? { custom_message: message } : {},
    });
  }
  if (can.alert && input.alertChannelId) {
    actions.push({ type: ACTION.SEND_ALERT_MESSAGE, metadata: { channel_id: input.alertChannelId } });
  }
  if (can.timeout && input.timeoutSeconds) {
    actions.push({ type: ACTION.TIMEOUT, metadata: { duration_seconds: input.timeoutSeconds } });
  }
  if (can.blockInteractions && input.blockInteractions) {
    actions.push({ type: ACTION.BLOCK_MEMBER_INTERACTION, metadata: {} });
  }

  const known = new Set<number>(Object.values(ACTION));
  for (const action of existing?.actions ?? []) {
    if (!known.has(action.type)) actions.push(action);
  }

  const metadata: Record<string, unknown> = { ...(existing?.trigger_metadata ?? {}) };
  switch (type) {
    case TRIGGER.KEYWORD:
    case TRIGGER.MEMBER_PROFILE:
      metadata.keyword_filter = cleanWords(input.keywords);
      metadata.regex_patterns = cleanPatterns(input.regexPatterns);
      metadata.allow_list = cleanWords(input.allowList);
      break;
    case TRIGGER.KEYWORD_PRESET:
      metadata.presets = [...new Set(input.presets)].sort((a, b) => a - b);
      metadata.allow_list = cleanWords(input.allowList);
      break;
    case TRIGGER.MENTION_SPAM:
      if (input.mentionLimit !== null) metadata.mention_total_limit = input.mentionLimit;
      metadata.mention_raid_protection_enabled = input.mentionRaidProtection;
      break;
    case TRIGGER.SPAM:
      break;
  }

  return {
    name: input.name.trim(),
    enabled: input.enabled,
    trigger_metadata: metadata,
    actions,
    exempt_roles: [...new Set(input.exemptRoles)],
    exempt_channels: [...new Set(input.exemptChannels)],
  };
}

/** The extra fields Discord needs only when a rule is first created. */
export function createFields(type: TriggerType) {
  return {
    trigger_type: type,
    event_type: type === TRIGGER.MEMBER_PROFILE ? EVENT.MEMBER_UPDATE : EVENT.MESSAGE_SEND,
  };
}

// ---------------------------------------------------------------------------
// Checking against Discord's limits
// ---------------------------------------------------------------------------

export interface RuleProblem {
  field: keyof AutomodRuleInput;
  message: string;
}

function tooLong(list: readonly string[], max: number) {
  return list.findIndex((s) => s.length > max);
}

/**
 * Everything about a rule that Discord would refuse, in words a person can
 * act on. Checked before the request goes out, so the answer is "word 12 is
 * over 60 characters" rather than Discord's "Invalid Form Body".
 *
 * Only Discord's documented limits are checked. Anything else it refuses
 * still comes back through describeRejection below.
 */
export function checkRule(type: TriggerType, input: AutomodRuleInput): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const add = (field: keyof AutomodRuleInput, message: string) => problems.push({ field, message });

  if (!input.name.trim()) add("name", "Give the rule a name.");

  if (type === TRIGGER.KEYWORD || type === TRIGGER.MEMBER_PROFILE) {
    const words = cleanWords(input.keywords);
    if (words.length > LIMITS.keywords) {
      add("keywords", `Discord allows ${LIMITS.keywords} words in a list; this has ${words.length}.`);
    }
    const longWord = tooLong(words, LIMITS.keywordLength);
    if (longWord >= 0) {
      add("keywords", `"${words[longWord]}" is over Discord's ${LIMITS.keywordLength}-character limit.`);
    }

    const patterns = cleanPatterns(input.regexPatterns);
    if (patterns.length > LIMITS.regexPatterns) {
      add(
        "regexPatterns",
        `Discord allows ${LIMITS.regexPatterns} patterns in a rule; this has ${patterns.length}.`,
      );
    }
    const longPattern = tooLong(patterns, LIMITS.regexLength);
    if (longPattern >= 0) {
      add(
        "regexPatterns",
        `Pattern ${longPattern + 1} is over Discord's ${LIMITS.regexLength}-character limit.`,
      );
    }
  }

  if (type === TRIGGER.KEYWORD || type === TRIGGER.MEMBER_PROFILE || type === TRIGGER.KEYWORD_PRESET) {
    const allowed = cleanWords(input.allowList);
    const max = type === TRIGGER.KEYWORD_PRESET ? LIMITS.presetAllowList : LIMITS.allowList;
    if (allowed.length > max) {
      add("allowList", `Discord allows ${max} allowed words on this rule; this has ${allowed.length}.`);
    }
    const longAllowed = tooLong(allowed, LIMITS.allowLength);
    if (longAllowed >= 0) {
      add("allowList", `"${allowed[longAllowed]}" is over Discord's ${LIMITS.allowLength}-character limit.`);
    }
  }

  if (type === TRIGGER.KEYWORD_PRESET) {
    const valid = new Set<number>(Object.values(PRESET));
    if (input.presets.some((p) => !valid.has(p))) add("presets", "That isn't one of Discord's lists.");
  }

  if (type === TRIGGER.MENTION_SPAM && input.mentionLimit !== null) {
    const n = input.mentionLimit;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.mentionTotalLimit) {
      add("mentionLimit", `Discord allows a limit from 1 to ${LIMITS.mentionTotalLimit} mentions.`);
    }
  }

  const can = actionsFor(type);
  if (can.block && input.block && input.blockMessage.trim().length > LIMITS.customMessageLength) {
    add("blockMessage", `Discord allows ${LIMITS.customMessageLength} characters here.`);
  }
  if (can.timeout && input.timeoutSeconds !== null) {
    const s = input.timeoutSeconds;
    if (!Number.isInteger(s) || s < 1 || s > LIMITS.timeoutSeconds) {
      add("timeoutSeconds", "Discord allows a timeout of up to 4 weeks.");
    }
  }

  const roles = new Set(input.exemptRoles).size;
  if (roles > LIMITS.exemptRoles) {
    add("exemptRoles", `Discord allows ${LIMITS.exemptRoles} ignored roles on a rule; this has ${roles}.`);
  }
  const channels = new Set(input.exemptChannels).size;
  if (channels > LIMITS.exemptChannels) {
    add(
      "exemptChannels",
      `Discord allows ${LIMITS.exemptChannels} ignored channels on a rule; this has ${channels}.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Reading Discord's refusals
// ---------------------------------------------------------------------------

const FIELD_NAMES: Record<string, string> = {
  name: "Name",
  keyword_filter: "Word",
  regex_patterns: "Pattern",
  allow_list: "Allowed word",
  presets: "Lists",
  mention_total_limit: "Mention limit",
  custom_message: "Message shown to them",
  channel_id: "Alert channel",
  duration_seconds: "Timeout",
  exempt_roles: "Ignored role",
  exempt_channels: "Ignored channel",
  actions: "Actions",
};

/**
 * The first specific complaint in Discord's "Invalid Form Body" (50035).
 *
 * Discord nests these by field, e.g. trigger_metadata.regex_patterns.2 holding
 * `_errors: [{ message }]`. The top-level message only says the form body was
 * invalid, which nobody can act on. Returns null when there's nothing nested
 * to read.
 */
export function describeRejection(errors: unknown): string | null {
  const walk = (node: unknown, path: string[]): string | null => {
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    const list = record._errors;
    if (Array.isArray(list) && list.length > 0) {
      const message = String((list[0] as { message?: unknown }).message ?? "").trim();
      return `${label(path)}${message ? `: ${message}` : ""}`;
    }
    for (const [key, child] of Object.entries(record)) {
      const found = walk(child, [...path, key]);
      if (found) return found;
    }
    return null;
  };
  return walk(errors, []);
}

function label(path: string[]): string {
  // The last named field, plus the position in its list when there is one:
  // ["trigger_metadata", "keyword_filter", "3"] is "Word 4".
  let name = "";
  let index: number | null = null;
  for (const part of path) {
    if (/^\d+$/.test(part)) index = Number(part);
    else if (FIELD_NAMES[part]) {
      name = FIELD_NAMES[part];
      index = null;
    }
  }
  if (!name) return path.join(".") || "Rule";
  return index === null ? name : `${name} ${index + 1}`;
}
