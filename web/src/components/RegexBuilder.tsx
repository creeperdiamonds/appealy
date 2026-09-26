// web/src/components/RegexBuilder.tsx
//
// The AutoMod editor's pattern builder and pattern tester.
//
// Regex is how AutoMod catches what a word list can't: "fr33 n1tr0", invite
// links, phone numbers, zalgo. It's also where one typo quietly blocks half a
// server's messages, and Discord's own settings give no way to try a pattern
// before saving it. The builder turns plain choices into patterns; the tester
// runs every pattern on a message you type and shows what it catches.
//
// The patterns, and the translation that lets the browser run Discord's regex,
// come from shared/services/automodRegex.ts, where they're tested against
// messages they should and shouldn't catch.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ANY_LINK,
  DEFAULT_DISGUISE,
  EMAILS,
  INVISIBLE,
  INVITE_LINKS,
  IP_ADDRESSES,
  IP_GRABBER_SITES,
  PHONE_NUMBERS,
  SPELLED_EMAILS,
  ZALGO,
  blankLines,
  cleanDomain,
  disguiseExamples,
  emojiWall,
  findMatches,
  letterSpam,
  shouting,
  sitePatterns,
  toBrowserRegex,
  wordPatterns,
  type DisguiseOptions,
  type Preset,
} from "../../../shared/services/automodRegex";
import { LIMITS } from "../../../shared/services/automodRules";

type Mode = "words" | "links" | "personal" | "spam";

const MODES: { id: Mode; label: string }[] = [
  { id: "words", label: "Disguised words" },
  { id: "links", label: "Links" },
  { id: "personal", label: "Personal info" },
  { id: "spam", label: "Spam tricks" },
];

const DISGUISES: { key: keyof DisguiseOptions; label: string; hint: string }[] = [
  { key: "numbers", label: "Numbers and symbols for letters", hint: "fr33, $cam, n1tr0" },
  { key: "lookalikes", label: "Look-alike letters", hint: "Cyrillic “а” for “a”, which looks identical" },
  { key: "accents", label: "Accented letters", hint: "scám, frée" },
  { key: "repeats", label: "Stretched letters", hint: "sccaaam" },
  { key: "gaps", label: "Spaces or symbols between letters", hint: "s c a m, s.c.a.m, s_c_a_m" },
  { key: "wholeWord", label: "Only whole words", hint: "catches “scam”, not “scampi”" },
];

/** Past this, a counted repeat risks Discord's unpublished compile-size limit. */
const LARGE_COUNT = 50;

// Phones "fix" words as they're typed. See the same flags in pages/AutoMod.tsx.
const RAW_TEXT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

interface Candidate {
  key: string;
  label: string;
  pattern: string;
  detail?: string;
  caution?: string;
}

interface Counted {
  on: boolean;
  n: number;
}

/** A pattern the builder is offering, named the way the builder names it. */
export interface Offered {
  label: string;
  pattern: string;
}

function splitList(text: string): string[] {
  return text.split(/[\n,]/);
}

function fromPreset(p: Preset): Candidate {
  return { key: p.id, label: p.label, pattern: p.pattern, detail: `Catches ${p.example}`, caution: p.caution };
}

/**
 * Builds patterns from plain choices.
 *
 * Used in two places. Inside a rule's editor, `current` is what the rule
 * already has, so a pattern that's been added says so, and `room` is how many
 * more the rule can take. On its own on the AutoMod page there's no rule yet:
 * `onAdd` asks which word list to put a pattern in, or is left out when
 * Appealy can't edit AutoMod, and Copy is the way to use a pattern in
 * Discord's own settings. `onCandidates` hands what's on offer to the tester,
 * so a pattern can be tried before it goes anywhere.
 */
export function PatternBuilder({
  current = [],
  room,
  onAdd,
  addLabel = "Add to rule",
  onCandidates,
}: {
  current?: string[];
  room?: number;
  onAdd?: (patterns: string[]) => void;
  addLabel?: string;
  onCandidates: (offered: Offered[]) => void;
}) {
  const [mode, setMode] = useState<Mode>("words");
  const [wordsText, setWordsText] = useState("");
  const [disguise, setDisguise] = useState<DisguiseOptions>(DEFAULT_DISGUISE);
  const [links, setLinks] = useState({ invites: true, any: false, grabbers: false });
  const [sitesText, setSitesText] = useState("");
  const [personal, setPersonal] = useState({ emails: true, spelled: false, phones: false, ips: false });
  const [tricks, setTricks] = useState({ zalgo: true, invisible: false });
  const [emoji, setEmoji] = useState<Counted>({ on: false, n: 8 });
  const [letters, setLetters] = useState<Counted>({ on: false, n: 10 });
  const [caps, setCaps] = useState<Counted>({ on: false, n: 10 });
  const [lines, setLines] = useState<Counted>({ on: false, n: 8 });

  const { candidates, problems, notes } = useMemo(() => {
    const candidates: Candidate[] = [];
    const problems: string[] = [];
    const notes: string[] = [];

    if (mode === "words") {
      const built = wordPatterns(splitList(wordsText), disguise);
      built.patterns.forEach((pattern, i) => {
        const examples = disguiseExamples(built.groups[i][0], disguise);
        candidates.push({
          key: `w${i}`,
          label: built.groups[i].join(", "),
          pattern,
          detail: examples.length
            ? `Catches ${examples.map((e) => `“${e}”`).join(", ")}${disguise.lookalikes ? " and look-alike letters" : ""}`
            : undefined,
        });
      });
      for (const word of built.tooLong) {
        problems.push(
          `“${word}” doesn't fit in one pattern with these options. Turn some off, or add it to the word list instead.`,
        );
      }
      const words = built.groups.flat();
      if (!disguise.wholeWord && words.some((w) => w.replace(/\s/g, "").length <= 3)) {
        notes.push("Short words match inside lots of ordinary words while “Only whole words” is off.");
      }
      if (disguise.gaps && words.length > 0) {
        notes.push(
          "Spaced-out letters now and then catch an innocent phrase (“it's cam” for “scam”). Try a few messages below before adding.",
        );
      }
    }

    if (mode === "links") {
      if (links.invites) candidates.push(fromPreset(INVITE_LINKS));
      if (links.any) candidates.push(fromPreset(ANY_LINK));
      if (links.grabbers) {
        const [pattern] = sitePatterns(IP_GRABBER_SITES).patterns;
        candidates.push({
          key: "grabbers",
          label: "Known IP-grabber sites",
          pattern,
          detail: `Links that log the IP address of whoever opens them: ${IP_GRABBER_SITES.join(", ")}`,
        });
      }
      const sites = splitList(sitesText).filter((s) => s.trim());
      const built = sitePatterns(sites);
      built.patterns.forEach((pattern, i) => {
        candidates.push({
          key: `s${i}`,
          label: built.groups[i].join(", "),
          pattern,
          detail: "Also catches their subdomains, with or without https://",
        });
      });
      for (const site of sites) {
        if (!cleanDomain(site)) problems.push(`“${site.trim()}” doesn't look like a website address.`);
      }
      for (const site of built.tooLong) problems.push(`“${site}” is too long for a pattern.`);
    }

    if (mode === "personal") {
      if (personal.emails) candidates.push(fromPreset(EMAILS));
      if (personal.spelled) candidates.push(fromPreset(SPELLED_EMAILS));
      if (personal.phones) candidates.push(fromPreset(PHONE_NUMBERS));
      if (personal.ips) candidates.push(fromPreset(IP_ADDRESSES));
    }

    if (mode === "spam") {
      if (tricks.zalgo) candidates.push(fromPreset(ZALGO));
      if (tricks.invisible) candidates.push(fromPreset(INVISIBLE));
      const counted: [Counted, string, (n: number) => string, (n: number) => string][] = [
        [emoji, "emoji", emojiWall, (n) => `${n} or more emoji in a row`],
        [letters, "letters", letterSpam, (n) => `The same letter ${n} or more times`],
        [caps, "caps", shouting, (n) => `${n} or more capitals, and no lowercase`],
        [lines, "lines", blankLines, (n) => `${n} or more line breaks in a row`],
      ];
      for (const [c, key, build, label] of counted) {
        if (!c.on) continue;
        if (!Number.isInteger(c.n) || c.n < 2) {
          problems.push(`${label(c.n)}: use a whole number of 2 or more.`);
          continue;
        }
        candidates.push({
          key,
          label: label(c.n),
          pattern: build(c.n),
          caution:
            c.n > LARGE_COUNT ? "Counts this high can be too complex for Discord to accept." : undefined,
        });
      }
    }

    return { candidates, problems, notes };
  }, [mode, wordsText, disguise, links, sitesText, personal, tricks, emoji, letters, caps, lines]);

  // Compared as text, so the tester only hears about a real change and not
  // about every render's new array.
  const offered = JSON.stringify(candidates.map(({ label, pattern }) => ({ label, pattern })));
  useEffect(() => {
    onCandidates(JSON.parse(offered) as Offered[]);
  }, [offered, onCandidates]);

  const fresh = candidates.filter((c) => !current.includes(c.pattern) && c.pattern.length <= LIMITS.regexLength);
  const full = room !== undefined && room <= 0;

  return (
    <div className="regex-builder">
      <div className="regex-modes" role="group" aria-label="What to catch">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={mode === m.id ? "btn-toggle is-on" : "btn-toggle"}
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "words" && (
        <>
          <label className="field">
            <span className="eyebrow">Words or phrases</span>
            <textarea
              rows={3}
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
              placeholder="free nitro, scam"
              {...RAW_TEXT}
            />
            <span className="dim">Type them normally. The pattern takes care of the disguises.</span>
          </label>
          <div className="regex-options">
            {DISGUISES.map((d) => (
              <Check
                key={d.key}
                checked={disguise[d.key]}
                onChange={(on) => setDisguise({ ...disguise, [d.key]: on })}
                label={d.label}
                hint={d.hint}
              />
            ))}
          </div>
        </>
      )}

      {mode === "links" && (
        <>
          <div className="regex-options">
            <Check
              checked={links.invites}
              onChange={(on) => setLinks({ ...links, invites: on })}
              label="Discord server invites"
              hint="including ones spelled out to get past filters"
            />
            <Check
              checked={links.any}
              onChange={(on) => setLinks({ ...links, any: on })}
              label="Any link"
              hint="anything starting http:// or www."
            />
            <Check
              checked={links.grabbers}
              onChange={(on) => setLinks({ ...links, grabbers: on })}
              label="Known IP-grabber sites"
              hint="links that log the IP address of whoever opens them"
            />
          </div>
          <label className="field">
            <span className="eyebrow">Other sites</span>
            <textarea
              rows={2}
              value={sitesText}
              onChange={(e) => setSitesText(e.target.value)}
              placeholder="example.com, one per line"
              {...RAW_TEXT}
            />
          </label>
        </>
      )}

      {mode === "personal" && (
        <div className="regex-options">
          <Check
            checked={personal.emails}
            onChange={(on) => setPersonal({ ...personal, emails: on })}
            label="Email addresses"
            hint="name@example.com"
          />
          <Check
            checked={personal.spelled}
            onChange={(on) => setPersonal({ ...personal, spelled: on })}
            label="Spelled-out email addresses"
            hint="name at gmail dot com"
          />
          <Check
            checked={personal.phones}
            onChange={(on) => setPersonal({ ...personal, phones: on })}
            label="Phone numbers"
            hint="+1 (555) 123-4567, 07700 900123"
          />
          <Check
            checked={personal.ips}
            onChange={(on) => setPersonal({ ...personal, ips: on })}
            label="IP addresses"
            hint="192.168.0.1"
          />
        </div>
      )}

      {mode === "spam" && (
        <div className="regex-options">
          <Check
            checked={tricks.zalgo}
            onChange={(on) => setTricks({ ...tricks, zalgo: on })}
            label="Zalgo text"
            hint="letters buried under stacked accent marks"
          />
          <Check
            checked={tricks.invisible}
            onChange={(on) => setTricks({ ...tricks, invisible: on })}
            label="Invisible characters"
            hint="blank messages, or hidden characters splitting a blocked word"
          />
          <CountedCheck value={emoji} onChange={setEmoji} label="Walls of emoji" unit="emoji in a row" />
          <CountedCheck value={letters} onChange={setLetters} label="Letter spam" unit="of the same letter" />
          <CountedCheck value={caps} onChange={setCaps} label="Shouting" unit="capitals, no lowercase" />
          <CountedCheck value={lines} onChange={setLines} label="Walls of blank lines" unit="line breaks in a row" />
        </div>
      )}

      {problems.map((p) => (
        <span key={p} className="automod-problem">
          {p}
        </span>
      ))}
      {notes.map((n) => (
        <span key={n} className="dim regex-note">
          {n}
        </span>
      ))}

      {candidates.length === 0 ? (
        <span className="dim">
          {mode === "words" ? "Type a word to see its pattern." : "Choose something to catch."}
        </span>
      ) : (
        <div className="regex-out">
          {candidates.map((c) => {
            const added = current.includes(c.pattern);
            const tooLong = c.pattern.length > LIMITS.regexLength;
            return (
              <div key={c.key} className="regex-item">
                <div className="regex-item-head">
                  <strong>{c.label}</strong>
                  <span className={`automod-count${tooLong ? " is-over" : ""}`}>
                    {c.pattern.length} / {LIMITS.regexLength}
                  </span>
                </div>
                <code className="regex-code">{c.pattern}</code>
                {c.detail && <span className="dim">{c.detail}</span>}
                {c.caution && <span className="regex-caution">{c.caution}</span>}
                <div className="actions">
                  {onAdd && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={added || tooLong || full}
                      onClick={() => onAdd([c.pattern])}
                    >
                      {added ? "Added" : addLabel}
                    </button>
                  )}
                  <CopyButton text={c.pattern} />
                </div>
              </div>
            );
          })}
          {onAdd && fresh.length > 1 && (
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={room !== undefined && fresh.length > room}
                onClick={() => onAdd(fresh.map((c) => c.pattern))}
              >
                Add all {fresh.length}
              </button>
            </div>
          )}
          {onAdd && room !== undefined && fresh.length > 0 && fresh.length > room && (
            <span className="automod-problem">
              {room <= 0
                ? `This rule already has Discord's ${LIMITS.regexPatterns} patterns. Remove one, or use another word list.`
                : `This rule has room for ${room} more ${room === 1 ? "pattern" : "patterns"}. Discord allows ${LIMITS.regexPatterns}.`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Copies a pattern, for pasting into Discord's own AutoMod settings. The code
 * block above it is selectable in one tap too, for when the clipboard isn't
 * available (an embedded browser, or permission refused).
 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="btn btn-sm btn-secondary"
      onClick={() =>
        // navigator.clipboard is missing outright on pages that aren't secure.
        (navigator.clipboard?.writeText(text) ?? Promise.reject())
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
      }
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select it to copy" : "Copy"}
    </button>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <label className="row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        {hint && <span className="dim block">{hint}</span>}
      </span>
    </label>
  );
}

function CountedCheck({
  value,
  onChange,
  label,
  unit,
}: {
  value: Counted;
  onChange: (next: Counted) => void;
  label: string;
  unit: string;
}) {
  return (
    <div className="row">
      <input
        type="checkbox"
        checked={value.on}
        onChange={(e) => onChange({ ...value, on: e.target.checked })}
        aria-label={label}
      />
      <span>
        <strong>{label}</strong>
        <span className="dim block regex-count">
          <input
            type="number"
            inputMode="numeric"
            min={2}
            value={Number.isNaN(value.n) ? "" : value.n}
            onChange={(e) => onChange({ on: true, n: e.target.value === "" ? NaN : Number(e.target.value) })}
            aria-label={`${label}: how many`}
          />{" "}
          or more {unit}
        </span>
      </span>
    </div>
  );
}

/**
 * Runs every pattern on a message typed here and shows what gets caught.
 *
 * `candidates` are the builder's patterns not added yet, tried alongside the
 * rule's own so the effect of adding one is visible first.
 */
export function PatternTester({
  patterns,
  candidates,
  candidateNote = "(not added)",
}: {
  patterns: string[];
  candidates: Offered[];
  /** After a candidate's name, to tell it apart from the rule's own patterns. */
  candidateNote?: string;
}) {
  const [text, setText] = useState("");

  const compiled = useMemo(
    () =>
      [
        ...patterns.map((pattern, i) => ({ label: `Pattern ${i + 1}`, pattern })),
        ...candidates
          .filter((c) => !patterns.includes(c.pattern))
          .map((c) => ({ label: `${c.label} ${candidateNote}`.trim(), pattern: c.pattern })),
      ].map((p) => ({ ...p, regex: toBrowserRegex(p.pattern) })),
    [patterns, candidates],
  );

  const results = useMemo(
    () =>
      text
        ? compiled.map((p) => ({ ...p, matches: p.regex.ok ? findMatches(p.regex.regex, text) : null }))
        : [],
    [compiled, text],
  );

  if (compiled.length === 0) return null;

  const caught = results.some((r) => r.matches && r.matches.length > 0);
  const ranges = merge(
    results.flatMap((r) => (r.matches ?? []).map((m) => [m.index, m.index + m.text.length] as [number, number])),
  );

  return (
    <div className="field regex-tester">
      <span className="eyebrow">Try a message</span>
      <textarea
        rows={2}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type or paste a message to see what these patterns catch"
        {...RAW_TEXT}
      />
      {text && (
        <>
          <strong className={caught ? "regex-verdict is-caught" : "regex-verdict is-clear"}>
            {caught ? "Caught" : "Not caught"}
          </strong>
          {caught && <p className="regex-highlight">{highlight(text, ranges)}</p>}
          <ul className="regex-results">
            {results.map((r) => (
              <li key={`${r.label}:${r.pattern}`}>
                <strong>{r.label}</strong>{" "}
                {r.matches === null ? (
                  <span className="dim">
                    can't be tried here ({r.regex.ok ? "" : r.regex.reason}). Discord still checks it
                    when you save.
                  </span>
                ) : r.matches.length > 0 ? (
                  <span>
                    catches “{r.matches[0].text.trim() || r.matches[0].text}”
                    {r.matches.length > 1 ? ` and ${r.matches.length - 1} more` : ""}
                  </span>
                ) : (
                  <span className="dim">no match</span>
                )}
              </li>
            ))}
          </ul>
          <span className="dim">
            Tried in your browser, which behaves like Discord for everything the generator makes.
          </span>
        </>
      )}
    </div>
  );
}

/** Overlapping and touching ranges joined, in order. */
function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function highlight(text: string, ranges: [number, number][]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
