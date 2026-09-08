// shared/lib/emoji.ts
//
// Turning what someone typed into a box into the emoji object Discord's
// component API expects.
//
// Four call sites did this identically and wrongly:
//
//   emoji: config.buttonEmoji ? { name: config.buttonEmoji } : undefined
//
// (ticketPanelService, roleMenuService, and pollService twice.) That shape is
// correct for exactly one of the three things people actually type.

/** What a Discord component accepts for `emoji`. */
export interface ComponentEmoji {
  id?: string;
  name?: string;
  animated?: boolean;
}

/**
 * A custom emoji as Discord writes it into message content: `<:name:id>`, or
 * `<a:name:id>` when animated. This is what lands in the clipboard when
 * someone copies an emoji out of Discord, so it is what they paste.
 */
const CUSTOM = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;

/** Someone pasted only the id. Rare, but unambiguous, so it is worth taking. */
const BARE_ID = /^\d{15,25}$/;

/**
 * A shortcode like `:ticket:`.
 *
 * Discord's own message box turns these into a real emoji as you type, so
 * people reasonably expect a form field to do the same. It does not — the
 * string is stored literally, and `{ name: ":ticket:" }` renders as nothing.
 * Recognised here so callers can reject it with an explanation instead of
 * silently publishing a button with an invisible emoji on it.
 */
const SHORTCODE = /^:[a-z0-9_+-]+:$/i;

export type EmojiParse =
  | { ok: true; emoji: ComponentEmoji | undefined }
  | { ok: false; reason: "shortcode"; message: string };

/**
 * Parse, distinguishing "nothing set" from "set to something unusable".
 *
 * Empty is `ok` with no emoji: not setting one is a valid choice, and the
 * caller should omit the field rather than treat it as an error.
 */
export function parseEmoji(raw: string | null | undefined): EmojiParse {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, emoji: undefined };

  const custom = CUSTOM.exec(s);
  if (custom) {
    return {
      ok: true,
      emoji: { id: custom[3], name: custom[2], animated: custom[1] === "a" },
    };
  }

  if (BARE_ID.test(s)) return { ok: true, emoji: { id: s } };

  if (SHORTCODE.test(s)) {
    return {
      ok: false,
      reason: "shortcode",
      message:
        `"${s}" is a shortcode, not an emoji. Discord only converts those as you type in ` +
        `its own message box. Paste the emoji itself, or paste a custom one from Discord ` +
        `and it will arrive looking like <:name:123456789012345678>.`,
    };
  }

  // Anything else is taken as a literal unicode emoji. Deliberately not
  // validated against an emoji table: those go stale every time Unicode ships
  // a release, and the failure mode of being too strict here is refusing an
  // emoji that would have worked perfectly well.
  return { ok: true, emoji: { name: s } };
}

/** The common case: parse and take whatever is usable, ignoring the rest. */
export function emojiForComponent(raw: string | null | undefined): ComponentEmoji | undefined {
  const parsed = parseEmoji(raw);
  return parsed.ok ? parsed.emoji : undefined;
}
