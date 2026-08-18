// web/src/components/ChannelPicker.tsx
//
// Single-select for Discord channels.
//
// Ten pages need one of these and six of them grew their own, which is how
// the same field ended up under three names with three different answers to
// "what happens when the bot is down". This is the union of what those copies
// got right rather than a pick of one of them, because each of them was right
// about something the others weren't.
//
// Four things this does that a bare `<select>` over the channel list wouldn't:
//
// **Degrades instead of blocking.** The list only exists because the bot's
// REST session went and got it, so when the bot is unreachable there is no
// list — and an empty select is a field nobody can fill. It falls back to a
// raw ID box, which is the same bargain RolePicker makes: a degraded editor
// beats a blocked one, and an outage someone can't fix shouldn't cost them
// the rest of their edit.
//
// **Keeps a saved id that no longer resolves.** A channel that was deleted,
// or that the bot lost sight of, is still in the database and still what the
// bot will try to use. Dropping it from the list would snap the select to
// "none" — and then the next save, which the person made for an unrelated
// reason, quietly erases a setting nobody touched. It stays as
// "Unknown channel (id)", with a line saying why.
//
// **Takes the list rather than fetching it.** Pages put several of these on
// screen at once and also want to name the channel a row posts to, so the
// request belongs to the page: `useGuildChannels` once at the top, the result
// passed down. A picker that fetched for itself would fan out one request per
// field and hand nothing back to the page around it.
//
// **Filters by channel type where a call site needs it.** /resources/channels
// already only returns text and announcement channels — bot/src/core/
// controlServer.ts filters it there — so `types` is a guard for the day that
// widens, not something today's list needs. Categories in particular are not
// in it, which is why the pages that want one still ask for an ID.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";

export interface GuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

/** Text, announcement and forum. Anywhere else, a message the bot tries to
 *  post is a message Discord refuses to send. */
export const POSTABLE_CHANNEL_TYPES = [0, 5, 15];

/**
 * The guild's channels, fetched once for the whole page.
 *
 * `channels` is null while the request is in flight, which is deliberately
 * not the same state as `failed`: one means "wait", the other means "this is
 * never arriving, give them the ID box". Conflating the two is what made one
 * of the old copies wait four seconds on a timer before it would admit the
 * bot was down.
 *
 * Never throws. A page's own data failing is an error screen; the picker list
 * failing is a smaller field, and it must not take the page with it.
 */
export function useGuildChannels(guildId: string): {
  channels: GuildChannel[] | null;
  failed: boolean;
} {
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setChannels(null);
    setFailed(false);

    api
      .channels(guildId)
      // Position order, matching the sidebar someone is picking from. Discord
      // hands them back in no order anyone would recognise.
      .then((list) => {
        if (live) setChannels([...list].sort((a, b) => a.position - b.position));
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [guildId]);

  return { channels, failed };
}

interface SharedProps {
  /** From `useGuildChannels`. Null means still loading. */
  channels: GuildChannel[] | null;
  /** From `useGuildChannels`. True means the list is not coming. */
  failed: boolean;
  label: string;
  hint?: ReactNode;
  /** Discord channel types to offer. Omit to offer everything the bot lists. */
  types?: number[];
  /** Ids to flag in the list with `markedNote` — marked rather than hidden,
   *  because hiding a channel someone knows exists makes the picker look
   *  broken instead of explaining itself. */
  markedIds?: string[];
  markedNote?: string;
}

/**
 * A channel the field can't do without: "" is the unpicked state, and the
 * page's own validation is what insists on it being filled.
 */
export function ChannelPicker({
  value,
  onChange,
  ...rest
}: SharedProps & {
  value: string;
  onChange: (id: string) => void;
}) {
  return <Picker {...rest} value={value} emptyLabel="— pick a channel —" onChange={onChange} />;
}

/**
 * A channel the field can genuinely do without, and that has to be clearable
 * once set — a goodbye channel, a transcript channel, a raid alert channel.
 * Null rather than "", because that's what these columns are in the database
 * and a round-trip through "" would write the wrong thing back.
 */
export function OptionalChannelPicker({
  value,
  onChange,
  ...rest
}: SharedProps & {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Picker
      {...rest}
      value={value ?? ""}
      emptyLabel="— none —"
      onChange={(id) => onChange(id || null)}
    />
  );
}

/** Both variants, with "" standing in for "nothing picked". */
function Picker({
  channels,
  failed,
  label,
  hint,
  types,
  markedIds,
  markedNote,
  value,
  emptyLabel,
  onChange,
}: SharedProps & {
  value: string;
  emptyLabel: string;
  onChange: (id: string) => void;
}) {
  const options = useMemo(
    () => (types ? (channels ?? []).filter((c) => types.includes(c.type)) : (channels ?? [])),
    [channels, types],
  );

  // An empty list that arrived successfully is as unusable as one that never
  // arrived — a select with nothing in it can't be filled either — so both go
  // to the ID box. Loading is not either of those, and must not land here.
  const unusable = failed || (channels !== null && options.length === 0);

  if (unusable) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value}
          placeholder="Channel ID"
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <span className="dim">
          Couldn't reach the bot to list channels, so this is an ID for now. The picker comes
          back on its own once the bot is up.
        </span>
      </label>
    );
  }

  const loading = channels === null;

  // Only meaningful once the list is actually here. Asked while loading,
  // every saved id looks deleted and the field would accuse a perfectly good
  // config of being broken.
  const missing = !loading && value !== "" && !options.some((c) => c.id === value);

  return (
    <label className="field">
      <span className="eyebrow">{label}</span>

      <select value={value} disabled={loading} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {missing && <option value={value}>Unknown channel ({value})</option>}
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
            {markedIds?.includes(c.id) && markedNote ? ` — ${markedNote}` : ""}
          </option>
        ))}
      </select>

      {loading && <span className="dim">Loading channels…</span>}

      {missing && (
        <span className="dim">
          The bot can't see this channel any more — it was deleted, or it lost access to it.
          Anything sent there will fail.
        </span>
      )}

      {hint && <span className="dim">{hint}</span>}
    </label>
  );
}
