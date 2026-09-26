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
/** Retries after the first failed load, at 2s and then 4s. */
const CHANNEL_LIST_RETRIES = 2;

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

    // A couple of quiet retries before giving up on the list. One failed
    // request used to leave the field as an ID box for the rest of the visit,
    // and a form needs a log channel to save — so a single blip on page load
    // was enough to make a first form impossible to create.
    const load = (attempt: number) => {
      api
        .channels(guildId)
        // Position order, matching the sidebar someone is picking from. Discord
        // hands them back in no order anyone would recognise.
        .then((list) => {
          if (live) setChannels([...list].sort((a, b) => a.position - b.position));
        })
        .catch(() => {
          if (!live) return;
          if (attempt < CHANNEL_LIST_RETRIES) {
            setTimeout(() => {
              if (live) load(attempt + 1);
            }, 2_000 * (attempt + 1));
          } else {
            setFailed(true);
          }
        });
    };
    load(0);

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
          Couldn't load the channel list, so this takes a channel ID for now — right-click the
          channel in Discord and choose Copy Channel ID. Reloading the page tries the list again.
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

/** What a channel is, for lists that offer every kind. Text channels go unlabelled. */
const CHANNEL_KIND: Record<number, string> = {
  2: "voice",
  4: "category",
  5: "announcement",
  13: "stage",
  15: "forum",
  16: "media",
};

function channelLabel(c: GuildChannel): string {
  const kind = CHANNEL_KIND[c.type];
  return c.type === 4 ? c.name.toUpperCase() : kind ? `${c.name} (${kind})` : `#${c.name}`;
}

/**
 * Several channels, of any kind: the channels an AutoMod rule ignores, which
 * Discord lets be categories, voice and forum channels as well as text ones.
 *
 * Fetches its own list, the way RolePicker does, because it wants every
 * channel and the page's shared list is only the ones a message can go to.
 */
export function ChannelMultiPicker({
  guildId,
  value,
  onChange,
  label,
  hint,
}: {
  guildId: string;
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  hint?: ReactNode;
}) {
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setChannels(null);
    setFailed(false);
    api
      .allChannels(guildId)
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = channels ?? [];
    return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
  }, [channels, query]);

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  // Same fallback as RolePicker: an unreachable bot costs the list, not the edit.
  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value.join(", ")}
          placeholder="Channel IDs, comma separated"
          onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))}
        />
        <span className="dim">
          Couldn't load the channel list, so this takes channel IDs for now. Reloading the page
          tries the list again.
        </span>
      </label>
    );
  }

  return (
    <div className="field">
      <span className="eyebrow">{label}</span>

      <div className="role-chips">
        {value.length === 0 && <span className="dim">None</span>}
        {value.map((id) => {
          const c = channels?.find((x) => x.id === id);
          const name = c ? channelLabel(c) : channels ? `Unknown channel (${id})` : id;
          return (
            <button
              key={id}
              type="button"
              className="role-chip"
              onClick={() => toggle(id)}
              aria-label={`Remove ${name}`}
            >
              {name}
              <span className="role-chip-x">×</span>
            </button>
          );
        })}
      </div>

      <button type="button" className="btn-secondary role-add" onClick={() => setOpen(!open)}>
        {open ? "Done" : "Choose channels"}
      </button>

      {open && (
        <div className="role-list">
          <input
            className="role-search"
            placeholder="Search channels…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {!channels && <span className="dim">Loading channels…</span>}
          {channels && filtered.length === 0 && <span className="dim">No channels match “{query}”.</span>}
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`role-option${value.includes(c.id) ? " is-selected" : ""}`}
              onClick={() => toggle(c.id)}
            >
              <span className="role-name">{channelLabel(c)}</span>
              {value.includes(c.id) && <span className="role-check">✓</span>}
            </button>
          ))}
        </div>
      )}

      {hint && <span className="dim">{hint}</span>}
    </div>
  );
}
