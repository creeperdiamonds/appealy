// web/src/pages/AutoMod.tsx
//
// Discord's AutoMod, from any device.
//
// Discord's own apps can't edit AutoMod on a phone. Its FAQ: "Updates to your
// AutoMod rules cannot be made on mobile devices at this time." This page can,
// so it offers everything Discord's desktop settings do, with Discord's limits
// and no others of ours: six word lists, the ready-made lists, spam, mention
// spam and words in names.
//
// Discord keeps the rules and Appealy stores none of them. A rule changed in
// Discord's settings is what this page shows the next time it loads, and one
// changed here is what Discord's settings show.
//
// The conversions and the limit checks come from shared/services/automodRules.ts,
// the same code the API checks with, so a counter here and a refusal there
// can't disagree.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type AutomodRule,
  type AutomodRuleInput,
  type AutomodState,
} from "../lib/api";
import { Banner, Empty, Loading, Panel, Pill, Sheet } from "../components/ui";
import { RolePicker } from "../components/RolePicker";
import { PatternBuilder, PatternTester, type Offered } from "../components/RegexBuilder";
import {
  ChannelMultiPicker,
  OptionalChannelPicker,
  useGuildChannels,
} from "../components/ChannelPicker";
import {
  LIMITS,
  PRESET,
  TRIGGER,
  actionsFor,
  checkRule,
  cleanPatterns,
  cleanWords,
  isKnownTrigger,
  type TriggerType,
} from "../../../shared/services/automodRules";

/** The rules a server has one of, in the order the page lists them. */
const SINGLE_RULES: { type: TriggerType; title: string; blurb: string }[] = [
  {
    type: TRIGGER.KEYWORD_PRESET,
    title: "Commonly flagged words",
    blurb: "Swearing, sexual content and slurs, from lists Discord keeps up to date.",
  },
  {
    type: TRIGGER.SPAM,
    title: "Suspected spam",
    blurb: "Messages Discord's own systems think are spam.",
  },
  {
    type: TRIGGER.MENTION_SPAM,
    title: "Mention spam",
    blurb: "Messages that mention too many people or roles at once.",
  },
  {
    type: TRIGGER.MEMBER_PROFILE,
    title: "Words in names",
    blurb: "Blocked words in members' names.",
  },
];

const PRESETS = [
  { value: PRESET.PROFANITY, label: "Swearing and cursing", short: "swearing" },
  { value: PRESET.SEXUAL_CONTENT, label: "Sexual content", short: "sexual content" },
  { value: PRESET.SLURS, label: "Slurs and hate speech", short: "slurs" },
];

/** Discord's own timeout choices, plus its four-week maximum. */
const TIMEOUTS: [number, string][] = [
  [60, "60 seconds"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [3600, "1 hour"],
  [86400, "1 day"],
  [604800, "1 week"],
  [LIMITS.timeoutSeconds, "4 weeks"],
];

const UNITS: [number, string][] = [
  [1, "seconds"],
  [60, "minutes"],
  [3600, "hours"],
  [86400, "days"],
];

function titleFor(type: TriggerType): string {
  if (type === TRIGGER.KEYWORD) return "Word list";
  return SINGLE_RULES.find((r) => r.type === type)?.title ?? "Rule";
}

function timeoutLabel(seconds: number): string {
  const preset = TIMEOUTS.find(([s]) => s === seconds);
  if (preset) return preset[1];
  for (const [size, unit] of [...UNITS].reverse()) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
    }
  }
  return `${seconds} seconds`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** Words typed one per line or separated by commas, the way Discord's own editor takes them. */
function splitWords(text: string): string[] {
  return text.split(/[\n,]/);
}

function blankRule(type: TriggerType, name: string): AutomodRuleInput {
  return {
    name,
    enabled: true,
    keywords: [],
    regexPatterns: [],
    allowList: [],
    presets: type === TRIGGER.KEYWORD_PRESET ? PRESETS.map((p) => p.value) : [],
    mentionLimit: type === TRIGGER.MENTION_SPAM ? 20 : null,
    mentionRaidProtection: type === TRIGGER.MENTION_SPAM,
    block: type !== TRIGGER.MEMBER_PROFILE,
    blockMessage: "",
    alertChannelId: null,
    timeoutSeconds: null,
    blockInteractions: type === TRIGGER.MEMBER_PROFILE,
    exemptRoles: [],
    exemptChannels: [],
  };
}

function toInput(rule: AutomodRule): AutomodRuleInput {
  const { id: _id, triggerType: _type, createdByAppealy: _mine, ...input } = rule;
  return input;
}

/** One line saying what a rule looks for and what it does. */
function summarise(rule: AutomodRule, channelName: (id: string) => string): string {
  const parts: string[] = [];
  switch (rule.triggerType) {
    case TRIGGER.KEYWORD:
    case TRIGGER.MEMBER_PROFILE:
      parts.push(plural(rule.keywords.length, "word"));
      if (rule.regexPatterns.length > 0) parts.push(plural(rule.regexPatterns.length, "pattern"));
      break;
    case TRIGGER.KEYWORD_PRESET:
      parts.push(
        PRESETS.filter((p) => rule.presets.includes(p.value))
          .map((p) => p.short)
          .join(", ") || "no lists chosen",
      );
      break;
    case TRIGGER.MENTION_SPAM:
      if (rule.mentionLimit !== null) parts.push(`over ${rule.mentionLimit} mentions`);
      if (rule.mentionRaidProtection) parts.push("raid protection");
      break;
  }
  if (rule.block) parts.push("blocks");
  if (rule.alertChannelId) parts.push(`alerts #${channelName(rule.alertChannelId)}`);
  if (rule.timeoutSeconds) parts.push(`times out for ${timeoutLabel(rule.timeoutSeconds)}`);
  if (rule.blockInteractions) parts.push("stops them talking");
  return parts.join(" · ");
}

/** Where the regex generator gets a column of its own (.automod-layout in index.css). */
const WIDE = "(min-width: 1280px)";

function useWideLayout(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

interface Editing {
  type: TriggerType;
  /** Null when creating. */
  rule: AutomodRule | null;
  defaultName: string;
  /** Patterns from the regex generator, put in the editor for saving. */
  addPatterns?: string[];
}

/**
 * `focus` names a section to scroll to once the page loads, for links from
 * "What's new" to the regex generator.
 */
export default function AutoMod({
  guildId,
  focus,
  onFocused,
}: {
  guildId: string;
  focus?: string | null;
  onFocused?: () => void;
}) {
  const [state, setState] = useState<AutomodState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [checking, setChecking] = useState(false);
  // The page-level regex generator: what it's offering, for the tester, and
  // the patterns waiting for a word list to be chosen.
  const [generated, setGenerated] = useState<Offered[]>([]);
  const [adding, setAdding] = useState<string[] | null>(null);
  // The open editor's patterns, and a way to add to them, so that on a wide
  // screen the generator beside the editor adds straight into it.
  const [editorPatterns, setEditorPatterns] = useState<string[]>([]);
  const editorAdd = useRef<((patterns: string[]) => void) | null>(null);
  const registerEditorAdd = useCallback((add: ((patterns: string[]) => void) | null) => {
    editorAdd.current = add;
  }, []);
  const wide = useWideLayout();
  const genRef = useRef<HTMLDivElement>(null);
  const { channels } = useGuildChannels(guildId);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await api.automod(guildId));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "unknown_error", "Couldn't load AutoMod."));
    }
  }, [guildId]);

  useEffect(() => {
    setState(null);
    setEditing(null);
    void load();
  }, [load]);

  const closeEditor = useCallback(() => setEditing(null), []);
  const closeAdding = useCallback(() => setAdding(null), []);

  useEffect(() => {
    if (!focus || !state) return;
    document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
    onFocused?.();
  }, [focus, state, onFocused]);

  useEffect(() => {
    if (!editing) setEditorPatterns([]);
  }, [editing]);

  // Popups centre in the space left of the generator column instead of under
  // it (.sheet-backdrop in index.css). Measured rather than worked out, because
  // the column's width and where the page sits both depend on the window.
  const loaded = state !== null;
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const left = genRef.current?.getBoundingClientRect().left;
      if (!wide || left === undefined) root.style.removeProperty("--sheet-reserve-right");
      else root.style.setProperty("--sheet-reserve-right", `${Math.round(window.innerWidth - left + 16)}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      root.style.removeProperty("--sheet-reserve-right");
    };
  }, [wide, loaded]);

  if (error && !state) {
    if (error.code === "admin_access_required") {
      return (
        <Banner level="watch" title="Only server admins can change AutoMod">
          Discord only lets people with Manage Server or Administrator see or change AutoMod,
          so Appealy does the same.
        </Banner>
      );
    }
    return (
      <Banner
        level="act"
        title="Couldn't load AutoMod"
        action={
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
        }
      >
        {error.message}
      </Banner>
    );
  }
  if (!state) return <Loading rows={5} />;

  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name ?? "channel";
  const lists = state.rules.filter((r) => r.triggerType === TRIGGER.KEYWORD);
  const unknown = state.rules.filter((r) => !isKnownTrigger(r.triggerType));
  const maxLists = LIMITS.perGuild[TRIGGER.KEYWORD];

  const nextListName = () => {
    const taken = new Set(lists.map((r) => r.name));
    if (!taken.has("Blocked words")) return "Blocked words";
    for (let n = 2; ; n++) if (!taken.has(`Blocked words ${n}`)) return `Blocked words ${n}`;
  };

  const onSaved = (saved: AutomodRule) => {
    setState((s) => {
      if (!s) return s;
      const exists = s.rules.some((r) => r.id === saved.id);
      return {
        ...s,
        rules: exists ? s.rules.map((r) => (r.id === saved.id ? saved : r)) : [...s.rules, saved],
      };
    });
    setEditing(null);
  };

  const onDeleted = (id: string) => {
    setState((s) => (s ? { ...s, rules: s.rules.filter((r) => r.id !== id) } : s));
    setEditing(null);
  };

  async function checkAgain() {
    setChecking(true);
    await load();
    setChecking(false);
  }

  // Rules that take regex: the word lists, and the one for names.
  const regexRules = state.rules.filter(
    (r) => r.triggerType === TRIGGER.KEYWORD || r.triggerType === TRIGGER.MEMBER_PROFILE,
  );

  // On the page itself, not only inside a rule, so it can be found, and so it
  // works before Appealy has permission: Copy puts a pattern into Discord's own
  // settings on a computer.
  // With a word list's editor open, the generator adds straight into it. The
  // other editors take no regex, so while one of them is open there's only Copy.
  const editorTakesRegex =
    editing !== null && (editing.type === TRIGGER.KEYWORD || editing.type === TRIGGER.MEMBER_PROFILE);
  const addFromGenerator = state.missingPermission
    ? undefined
    : editorTakesRegex
    ? (patterns: string[]) => editorAdd.current?.(patterns)
    : editing
    ? undefined
    : setAdding;

  const generator = (
    <div id="regex-generator" ref={genRef} className="automod-anchor automod-area-gen">
      <Panel title="Regex generator">
        <p className="dim automod-lead">
          Catch disguised words, invite links, personal info and spam tricks without writing regex,
          and try any message to see what gets caught.{" "}
          {state.missingPermission
            ? "Copy a pattern into Discord's own AutoMod settings, or give Appealy permission " +
              "above to add it to a word list here."
            : "Then add a pattern to a word list, or copy it."}
        </p>
        <PatternBuilder
          current={editorTakesRegex ? editorPatterns : undefined}
          room={editorTakesRegex ? LIMITS.regexPatterns - editorPatterns.length : undefined}
          onCandidates={setGenerated}
          onAdd={addFromGenerator}
          addLabel={editorTakesRegex ? "Add to this rule" : "Add to a word list"}
        />
        <PatternTester patterns={[]} candidates={generated} candidateNote="" />
      </Panel>
    </div>
  );

  return (
    <div className="stack">
      <header className="page-head">
        <h1>AutoMod</h1>
        <p className="dim">
          Discord's own filters. They stop a message before anyone sees it, and keep working even
          when Appealy is offline. Discord's app can't change them on a phone. This page can.
        </p>
      </header>

      {/* A failed "Check again" leaves the last good state on screen, so say why nothing changed. */}
      {error && (
        <Banner level="act" title="Couldn't check with Discord">
          {error.message}
        </Banner>
      )}

      {/* Grid areas rather than DOM order decide where things go: see
          .automod-layout in index.css for the one- and two-column arrangements. */}
      <div className="automod-layout">
        {state.missingPermission ? (
          <div className="automod-grant automod-area-lists">
            <Banner
              level="act"
              title="Appealy needs Manage Server for this"
              action={
                <div className="actions">
                  <a className="btn btn-primary" href={state.grantUrl} target="_blank" rel="noreferrer">
                    Give permission
                  </a>
                  <button className="btn" onClick={() => void checkAgain()} disabled={checking}>
                    {checking ? "Checking…" : "Check again"}
                  </button>
                </div>
              }
            >
              Discord only lets apps with Manage Server see or change AutoMod. The button opens Discord
              to add it to Appealy's role. You can also switch it on for that role yourself, under
              Server Settings → Roles.
            </Banner>
          </div>
        ) : (
          <>
            <Panel
              className="automod-area-lists"
              title="Word lists"
              action={
                <button
                  className="btn btn-sm"
                  disabled={lists.length >= maxLists}
                  onClick={() =>
                    setEditing({ type: TRIGGER.KEYWORD, rule: null, defaultName: nextListName() })
                  }
                >
                  New list
                </button>
              }
            >
              {lists.length === 0 ? (
                <Empty
                  title="No word lists yet"
                  hint="Block words and phrases, like scam links or spoilers."
                />
              ) : (
                <div className="automod-rules">
                  {lists.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      title={rule.name}
                      summary={summarise(rule, channelName)}
                      enabled={rule.enabled}
                      onOpen={() => setEditing({ type: TRIGGER.KEYWORD, rule, defaultName: rule.name })}
                    />
                  ))}
                </div>
              )}
              <p className="dim automod-foot">
                {lists.length} of {maxLists} lists. Discord allows {maxLists} per server, each with up
                to {LIMITS.keywords.toLocaleString()} words.
              </p>
            </Panel>

            <Panel className="automod-area-filters" title="Discord's other filters">
              <div className="automod-rules">
                {SINGLE_RULES.map(({ type, title, blurb }) => {
                  const rule = state.rules.find((r) => r.triggerType === type) ?? null;
                  return rule ? (
                    <RuleRow
                      key={type}
                      title={title}
                      summary={summarise(rule, channelName)}
                      enabled={rule.enabled}
                      onOpen={() => setEditing({ type, rule, defaultName: rule.name })}
                    />
                  ) : (
                    <button
                      key={type}
                      type="button"
                      className="automod-rule"
                      onClick={() => setEditing({ type, rule: null, defaultName: title })}
                    >
                      <span className="automod-rule-text">
                        <strong>{title}</strong>
                        <span className="dim">{blurb}</span>
                      </span>
                      <span className="btn btn-sm">Set up</span>
                    </button>
                  );
                })}
              </div>
            </Panel>

            {unknown.length > 0 && (
              <Panel className="automod-area-other" title="Other rules">
                <p className="dim">
                  These use a kind of AutoMod Appealy doesn't know yet. They still work; change them
                  in Discord's own settings.
                </p>
                <div className="automod-rules">
                  {unknown.map((rule) => (
                    <div key={rule.id} className="automod-rule">
                      <span className="automod-rule-text">
                        <strong>{rule.name}</strong>
                      </span>
                      <Pill level={rule.enabled ? "ok" : undefined}>{rule.enabled ? "On" : "Off"}</Pill>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            <p className="dim automod-area-note">
              AutoMod never applies to members with Administrator or Manage Server, including you. Test
              a rule from an account without them.
            </p>
          </>
        )}
        {generator}
      </div>

      {adding && (
        <Sheet title="Add to which word list?" onClose={closeAdding} modal={!wide}>
          <div className="automod-rules">
            {regexRules.map((rule) => (
              <button
                key={rule.id}
                type="button"
                className="automod-rule"
                onClick={() => {
                  setAdding(null);
                  setEditing({
                    type: rule.triggerType as TriggerType,
                    rule,
                    defaultName: rule.name,
                    addPatterns: adding,
                  });
                }}
              >
                <span className="automod-rule-text">
                  <strong>
                    {rule.name}
                    {rule.triggerType === TRIGGER.MEMBER_PROFILE ? " (names)" : ""}
                  </strong>
                  <span className="dim">
                    {rule.regexPatterns.length} of {LIMITS.regexPatterns} patterns used
                  </span>
                </span>
                <Pill level={rule.enabled ? "ok" : undefined}>{rule.enabled ? "On" : "Off"}</Pill>
              </button>
            ))}
            {lists.length < maxLists && (
              <button
                type="button"
                className="automod-rule"
                onClick={() => {
                  setAdding(null);
                  setEditing({
                    type: TRIGGER.KEYWORD,
                    rule: null,
                    defaultName: nextListName(),
                    addPatterns: adding,
                  });
                }}
              >
                <span className="automod-rule-text">
                  <strong>New word list</strong>
                  <span className="dim">
                    Start one with just {adding.length === 1 ? "this pattern" : "these patterns"}.
                  </span>
                </span>
                <span className="btn btn-sm">Create</span>
              </button>
            )}
          </div>
        </Sheet>
      )}

      {editing && (
        <Sheet
          title={editing.rule ? editing.rule.name : `New: ${titleFor(editing.type)}`}
          onClose={closeEditor}
          modal={!wide}
        >
          <RuleEditor
            guildId={guildId}
            editing={editing}
            timeoutAppeals={state.timeoutAppeals}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onCancel={closeEditor}
            registerAdd={registerEditorAdd}
            onPatternsChange={setEditorPatterns}
          />
        </Sheet>
      )}
    </div>
  );
}

function RuleRow({
  title,
  summary,
  enabled,
  onOpen,
}: {
  title: string;
  summary: string;
  enabled: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="automod-rule" onClick={onOpen}>
      <span className="automod-rule-text">
        <strong>{title}</strong>
        <span className="dim">{summary}</span>
      </span>
      <Pill level={enabled ? "ok" : undefined}>{enabled ? "On" : "Off"}</Pill>
    </button>
  );
}

function Count({ n, max }: { n: number; max: number }) {
  return (
    <span className={`automod-count${n > max ? " is-over" : ""}`}>
      {n.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
}

function failure(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Try again.";
}

function Problem({ message }: { message?: string }) {
  return message ? <span className="automod-problem">{message}</span> : null;
}

// Phones "fix" words as they're typed, which turns a blocked word into a
// different, harmless one. Every list box turns that off.
const RAW_TEXT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

function RuleEditor({
  guildId,
  editing,
  timeoutAppeals,
  onSaved,
  onDeleted,
  onCancel,
  registerAdd,
  onPatternsChange,
}: {
  guildId: string;
  editing: Editing;
  timeoutAppeals: AutomodState["timeoutAppeals"];
  onSaved: (rule: AutomodRule) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
  /** Hands the page a way to add patterns here, from the generator beside this. */
  registerAdd?: (add: ((patterns: string[]) => void) | null) => void;
  /** Tells the page this rule's patterns, so that generator can say what's added. */
  onPatternsChange?: (patterns: string[]) => void;
}) {
  const { type, rule } = editing;
  const [draft, setDraft] = useState<AutomodRuleInput>(() =>
    rule ? toInput(rule) : blankRule(type, editing.defaultName),
  );
  // The list boxes keep what was typed, commas and blank lines included, and
  // are only turned into lists for counting and saving. Rewriting the text on
  // every keystroke would eat a comma the moment it was typed.
  const [wordsText, setWordsText] = useState(() => (rule?.keywords ?? []).join("\n"));
  const [allowText, setAllowText] = useState(() => (rule?.allowList ?? []).join("\n"));
  const [patternsText, setPatternsText] = useState(() =>
    [...new Set([...(rule?.regexPatterns ?? []), ...(editing.addPatterns ?? [])])].join("\n"),
  );
  const [showPatterns, setShowPatterns] = useState(
    () => (rule?.regexPatterns.length ?? 0) > 0 || (editing.addPatterns?.length ?? 0) > 0,
  );
  const [builderOpen, setBuilderOpen] = useState(false);
  // What the builder is offering, so the tester can try it before it's added.
  const [candidates, setCandidates] = useState<Offered[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const { channels, failed } = useGuildChannels(guildId);

  const can = actionsFor(type);
  const usesWords = type === TRIGGER.KEYWORD || type === TRIGGER.MEMBER_PROFILE;
  const usesAllowList = usesWords || type === TRIGGER.KEYWORD_PRESET;
  const allowMax = type === TRIGGER.KEYWORD_PRESET ? LIMITS.presetAllowList : LIMITS.allowList;

  const input: AutomodRuleInput = {
    ...draft,
    keywords: cleanWords(splitWords(wordsText)),
    allowList: cleanWords(splitWords(allowText)),
    regexPatterns: cleanPatterns(patternsText.split("\n")),
  };
  const problems = checkRule(type, input);
  const problem = (field: keyof AutomodRuleInput) => problems.find((p) => p.field === field)?.message;

  // Rules Discord would take but that would never do anything.
  const doesSomething =
    (can.block && input.block) ||
    (can.alert && input.alertChannelId !== null) ||
    (can.timeout && input.timeoutSeconds !== null) ||
    (can.blockInteractions && input.blockInteractions);
  const unfinished = !doesSomething
    ? "Choose at least one thing for the rule to do."
    : usesWords && input.keywords.length === 0 && input.regexPatterns.length === 0
    ? "Add at least one word."
    : type === TRIGGER.KEYWORD_PRESET && input.presets.length === 0
    ? "Choose at least one list."
    : type === TRIGGER.MENTION_SPAM && input.mentionLimit === null
    ? "Enter how many mentions are allowed."
    : null;

  const patch = (next: Partial<AutomodRuleInput>) => setDraft((d) => ({ ...d, ...next }));

  // From the state setter's own argument rather than the render's patternsText,
  // because the page keeps hold of this to add from the generator beside it.
  const addPatterns = useCallback((list: string[]) => {
    setPatternsText((text) => {
      const existing = cleanPatterns(text.split("\n"));
      return [...existing, ...list.filter((p) => !existing.includes(p))].join("\n");
    });
    setShowPatterns(true);
  }, []);

  useEffect(() => {
    registerAdd?.(addPatterns);
    return () => registerAdd?.(null);
  }, [registerAdd, addPatterns]);

  const patternsKey = input.regexPatterns.join("\n");
  useEffect(() => {
    onPatternsChange?.(patternsKey ? patternsKey.split("\n") : []);
  }, [patternsKey, onPatternsChange]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = rule
        ? await api.saveAutomodRule(guildId, rule.id, type, input)
        : await api.createAutomodRule(guildId, type, input);
      onSaved(saved);
    } catch (e) {
      setError({ title: "Couldn't save", message: failure(e) });
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteAutomodRule(guildId, rule.id);
      onDeleted(rule.id);
    } catch (e) {
      setError({ title: "Couldn't delete", message: failure(e) });
      setSaving(false);
    }
  }

  const appealNote =
    input.timeoutSeconds === null
      ? null
      : timeoutAppeals === null
      ? "They can't appeal it: timeout appeals are off on the Appeals page."
      : // The same minute of slack the bot allows (shared/services/appealTriggers.ts).
      input.timeoutSeconds >= timeoutAppeals.minSeconds - 60
      ? "They'll get an “Appeal this timeout” button in their DMs."
      : `Shorter than the ${timeoutLabel(timeoutAppeals.minSeconds)} your Appeals page asks for, ` +
        "so there's no appeal button.";

  const incoming = editing.addPatterns?.length ?? 0;

  return (
    <div className="automod-editor">
      {incoming > 0 && (
        <Banner
          level="watch"
          title={incoming === 1 ? "Pattern added below" : `${incoming} patterns added below`}
        >
          {rule ? "Save" : "Create the rule"} to keep {incoming === 1 ? "it" : "them"}.
        </Banner>
      )}

      <label className="field">
        <span className="eyebrow">Name</span>
        <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        <Problem message={problem("name")} />
        <span className="dim">Shown in Discord's AutoMod settings and in alerts.</span>
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span>
          <strong>Turned on</strong>
          <span className="dim block">Off keeps the rule in Discord without it doing anything.</span>
        </span>
      </label>

      {usesWords && (
        <>
          <label className="field">
            <span className="eyebrow automod-label">
              {type === TRIGGER.MEMBER_PROFILE ? "Words to block in names" : "Words and phrases"}
              <Count n={input.keywords.length} max={LIMITS.keywords} />
            </span>
            <textarea
              rows={6}
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
              placeholder="One per line, or separated by commas"
              {...RAW_TEXT}
            />
            <Problem message={problem("keywords")} />
            <span className="dim">
              Capitals don't matter. <code>scam</code> matches the whole word, <code>scam*</code>{" "}
              words starting with it, <code>*scam</code> words ending with it, and{" "}
              <code>*scam*</code> anywhere, even inside other words. Up to{" "}
              {LIMITS.keywordLength} characters each.
            </span>
          </label>

          {showPatterns ? (
            <>
              <label className="field">
                <span className="eyebrow automod-label">
                  Patterns (regex)
                  <Count n={input.regexPatterns.length} max={LIMITS.regexPatterns} />
                </span>
                <textarea
                  className="regex-input"
                  rows={4}
                  value={patternsText}
                  onChange={(e) => setPatternsText(e.target.value)}
                  placeholder="One per line"
                  {...RAW_TEXT}
                />
                <Problem message={problem("regexPatterns")} />
                <span className="dim">
                  For what a word list can't express. Discord uses Rust-style regex, up to{" "}
                  {LIMITS.regexLength} characters each. The regex generator writes them for you.
                </span>
              </label>
              {/* On a wide screen the page's generator is beside this, so the
                  editor's own is for phones (index.css). */}
              <p className="dim automod-side-hint">
                The regex generator beside this adds patterns straight into this rule.
              </p>
              <div className="actions automod-inline-gen">
                <button type="button" className="btn btn-sm" onClick={() => setBuilderOpen(!builderOpen)}>
                  {builderOpen ? "Close the regex generator" : "Regex generator"}
                </button>
              </div>
              {builderOpen && (
                <div className="automod-inline-gen">
                  <PatternBuilder
                    current={input.regexPatterns}
                    room={LIMITS.regexPatterns - input.regexPatterns.length}
                    onAdd={addPatterns}
                    onCandidates={setCandidates}
                  />
                </div>
              )}
              <PatternTester patterns={input.regexPatterns} candidates={builderOpen ? candidates : []} />
            </>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn-sm automod-inline-gen"
                onClick={() => {
                  setShowPatterns(true);
                  setBuilderOpen(true);
                }}
              >
                Regex generator
              </button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowPatterns(true)}>
                Write regex
              </button>
              <span className="dim automod-side-hint">
                Or add patterns from the regex generator beside this.
              </span>
            </div>
          )}
        </>
      )}

      {type === TRIGGER.KEYWORD_PRESET && (
        <div className="field">
          <span className="eyebrow">Lists to use</span>
          {PRESETS.map((p) => (
            <label key={p.value} className="row">
              <input
                type="checkbox"
                checked={draft.presets.includes(p.value)}
                onChange={(e) =>
                  patch({
                    presets: e.target.checked
                      ? [...draft.presets, p.value]
                      : draft.presets.filter((x) => x !== p.value),
                  })
                }
              />
              <span>{p.label}</span>
            </label>
          ))}
          <Problem message={problem("presets")} />
        </div>
      )}

      {type === TRIGGER.MENTION_SPAM && (
        <>
          <label className="field">
            <span className="eyebrow">Most mentions allowed in one message</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={LIMITS.mentionTotalLimit}
              value={draft.mentionLimit ?? ""}
              onChange={(e) =>
                patch({ mentionLimit: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
            <Problem message={problem("mentionLimit")} />
            <span className="dim">
              Counts different people and roles. Discord allows 1 to {LIMITS.mentionTotalLimit}.
            </span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.mentionRaidProtection}
              onChange={(e) => patch({ mentionRaidProtection: e.target.checked })}
            />
            <span>
              <strong>Also catch mention raids</strong>
              <span className="dim block">
                Discord watches for lots of mentions arriving in a short time.
              </span>
            </span>
          </label>
        </>
      )}

      {type === TRIGGER.SPAM && (
        <p className="dim">
          Discord decides what counts as spam, so there's nothing to tune. Just choose what happens.
        </p>
      )}

      {usesAllowList && (
        <label className="field">
          <span className="eyebrow automod-label">
            Never block
            <Count n={input.allowList.length} max={allowMax} />
          </span>
          <textarea
            rows={2}
            value={allowText}
            onChange={(e) => setAllowText(e.target.value)}
            placeholder="Optional. One per line, or separated by commas"
            {...RAW_TEXT}
          />
          <Problem message={problem("allowList")} />
          <span className="dim">Exceptions, like “scampi” when “scam*” is blocked.</span>
        </label>
      )}

      <h3 className="eyebrow automod-section">When it's triggered</h3>

      {can.block && (
        <>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.block}
              onChange={(e) => patch({ block: e.target.checked })}
            />
            <span>
              <strong>Block the message</strong>
              <span className="dim block">It's never posted. Only the sender sees why.</span>
            </span>
          </label>
          {draft.block && (
            <label className="field">
              <span className="eyebrow automod-label">
                What they're told
                <Count n={draft.blockMessage.trim().length} max={LIMITS.customMessageLength} />
              </span>
              <input
                value={draft.blockMessage}
                placeholder="Optional. Leave empty for Discord's own message"
                onChange={(e) => patch({ blockMessage: e.target.value })}
              />
              <Problem message={problem("blockMessage")} />
            </label>
          )}
        </>
      )}

      {can.blockInteractions && (
        <label className="row">
          <input
            type="checkbox"
            checked={draft.blockInteractions}
            onChange={(e) => patch({ blockInteractions: e.target.checked })}
          />
          <span>
            <strong>Stop them talking until they change it</strong>
            <span className="dim block">No messages, voice or reactions until the name is fixed.</span>
          </span>
        </label>
      )}

      <OptionalChannelPicker
        channels={channels}
        failed={failed}
        label="Send an alert to"
        value={draft.alertChannelId}
        onChange={(id) => patch({ alertChannelId: id })}
        hint="Posts what was caught, and who, for your mods."
      />

      {can.timeout && (
        <div className="field">
          <span className="eyebrow">Time them out</span>
          <TimeoutField value={draft.timeoutSeconds} onChange={(s) => patch({ timeoutSeconds: s })} />
          <Problem message={problem("timeoutSeconds")} />
          {appealNote && <span className="dim">{appealNote}</span>}
        </div>
      )}

      <h3 className="eyebrow automod-section">Doesn't apply to</h3>

      <RolePicker
        guildId={guildId}
        value={draft.exemptRoles}
        onChange={(ids) => patch({ exemptRoles: ids })}
        label={`Roles (${draft.exemptRoles.length} / ${LIMITS.exemptRoles})`}
        hint="Members with any of these roles are never checked."
      />
      <Problem message={problem("exemptRoles")} />

      {type !== TRIGGER.MEMBER_PROFILE && (
        <>
          <ChannelMultiPicker
            guildId={guildId}
            value={draft.exemptChannels}
            onChange={(ids) => patch({ exemptChannels: ids })}
            label={`Channels (${draft.exemptChannels.length} / ${LIMITS.exemptChannels})`}
            hint="Choosing a category covers every channel in it."
          />
          <Problem message={problem("exemptChannels")} />
        </>
      )}

      {error && (
        <Banner level="act" title={error.title}>
          {error.message}
        </Banner>
      )}

      <div className="automod-footer">
        {confirmDelete ? (
          <>
            <span>Delete this rule? It's removed from Discord too.</span>
            <button className="btn btn-danger" onClick={() => void remove()} disabled={saving}>
              {saving ? "Deleting…" : "Delete"}
            </button>
            <button className="btn" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={saving || problems.length > 0 || unfinished !== null}
            >
              {saving ? "Saving…" : rule ? "Save" : "Create rule"}
            </button>
            <button className="btn" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            {rule && (
              <button
                className="btn btn-secondary automod-delete"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                Delete
              </button>
            )}
            {(unfinished ?? (problems.length > 0 ? "Fix the problems above to save." : null)) && (
              <span className="dim automod-why">
                {unfinished ?? "Fix the problems above to save."}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** A timeout length: Discord's own choices, or any length up to its four-week limit. */
function TimeoutField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (seconds: number | null) => void;
}) {
  const isPreset = value === null || TIMEOUTS.some(([s]) => s === value);
  const [custom, setCustom] = useState(!isPreset);
  const startUnit = value === null ? 60 : [...UNITS].reverse().find(([size]) => value % size === 0)?.[0] ?? 1;
  const [unit, setUnit] = useState(startUnit);
  const [amount, setAmount] = useState(value === null ? "" : String(value / startUnit));

  const choice = custom ? "custom" : value === null ? "" : String(value);

  return (
    <>
      <select
        value={choice}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") {
            setCustom(true);
            if (value !== null) {
              setUnit(startUnit);
              setAmount(String(value / startUnit));
            }
            return;
          }
          setCustom(false);
          onChange(v === "" ? null : Number(v));
        }}
      >
        <option value="">Don't time them out</option>
        {TIMEOUTS.map(([s, label]) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
        <option value="custom">Another length…</option>
      </select>
      {custom && (
        <div className="automod-duration">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              onChange(e.target.value === "" ? null : Math.round(Number(e.target.value) * unit));
            }}
            aria-label="How long"
          />
          <select
            value={unit}
            onChange={(e) => {
              const next = Number(e.target.value);
              setUnit(next);
              if (amount !== "") onChange(Math.round(Number(amount) * next));
            }}
            aria-label="Unit"
          >
            {UNITS.map(([size, label]) => (
              <option key={size} value={size}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
