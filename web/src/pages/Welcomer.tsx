// web/src/pages/Welcomer.tsx
//
// Join announcements, the join DM, auto-roles, and leave announcements.
// One row per guild (welcomerConfigs), so this is a single form with one
// Save rather than a list — the schema keeps these together because they
// are almost always configured together.
//
// The page's real job is the same as AppealConfig's: refuse to let a switch
// sit in the "on" position while the thing it turns on cannot run. Every
// state below is accepted by the API without complaint and produces no
// error anyone will ever see — the admin just finds out in three months
// that nobody was ever welcomed:
//
//   1. join announcements on, no channel chosen
//   2. leave announcements on, no channel chosen
//   3. the join DM on with no DM text — the bot has nothing to send
//   4. an announcement enabled with an empty message body
//
// GET returns null for a guild that has never saved, so the defaults here
// mirror the zod defaults in api/src/routes/welcomer.ts character for
// character. If they drifted, the first save would quietly change settings
// nobody touched.

import { useEffect, useState, useCallback } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Pill } from "../components/ui";
import { RolePicker } from "../components/RolePicker";

interface WelcomerDTO {
  guildId: string;
  joinEnabled: boolean;
  joinChannelId: string | null;
  joinMessage: string;
  joinDmEnabled: boolean;
  joinDmMessage: string | null;
  joinEmbedColor: number;
  joinImageUrl: string | null;
  autoRoleIds: string[];
  leaveEnabled: boolean;
  leaveChannelId: string | null;
  leaveMessage: string;
}

/** The PUT body. guildId comes from the path, never the body. */
type WelcomerBody = Omit<WelcomerDTO, "guildId">;

interface GuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

const DEFAULT_COLOR = 0x5865f2;

const DEFAULTS: WelcomerBody = {
  joinEnabled: false,
  joinChannelId: null,
  joinMessage: "Welcome to {guild}, {username}! You are member #{membercount}.",
  joinDmEnabled: false,
  joinDmMessage: null,
  joinEmbedColor: DEFAULT_COLOR,
  joinImageUrl: null,
  autoRoleIds: [],
  leaveEnabled: false,
  leaveChannelId: null,
  leaveMessage: "{username} has left {guild}.",
};

// interpolateTemplate() in shared/types/index.ts also understands {form} and
// {reason}, but a join or leave event carries neither — they would render as
// an empty string and "No reason provided" respectively. Advertising a token
// that always expands to nothing is worse than not offering it.
const PLACEHOLDERS: { token: string; means: string }[] = [
  { token: "{username}", means: "display name, e.g. Ada" },
  { token: "{usertag}", means: "full tag, e.g. ada#0001" },
  { token: "{userid}", means: "numeric ID — for a real mention write <@{userid}>" },
  { token: "{guild}", means: "this server's name" },
  { token: "{membercount}", means: "member count including the join" },
];

/**
 * The API answers a rejected body with { error: "invalid_body", detail: <zod
 * flatten> }. lib/api.ts feeds `detail` to Error, and an object has already
 * become "[object Object]" by the time it arrives here — so that one code
 * gets its own words. Every other failure (502 bot_unreachable and friends)
 * sends a string worth showing verbatim.
 */
function apiMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === "invalid_body") {
    return "The server rejected these settings. Check that the image URL is a full https:// address and that no message is over 2000 characters.";
  }
  return e.message || fallback;
}

const hexOf = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/**
 * Channel select, sharing one fetch across the places that need it.
 *
 * Falls back to a raw ID field when the bot can't be reached, for the reason
 * RolePicker does: a degraded editor beats a blocked one, and the bot being
 * down shouldn't cost someone the rest of their edit.
 */
function ChannelField({
  label,
  hint,
  channels,
  failed,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  channels: GuildChannel[] | null;
  failed: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value ?? ""}
          placeholder="Channel ID"
          onChange={(e) => onChange(e.target.value.trim() || null)}
        />
        <span className="dim">
          Couldn't reach the bot to list channels, so this is an ID for now. The picker comes
          back on its own once the bot is up.
        </span>
      </label>
    );
  }

  // A channel that was deleted, or that the bot lost sight of, is still in the
  // database. Keeping it visible as an option rather than letting the select
  // snap to "none" is the only thing that explains why posts stopped.
  const missing = value !== null && channels !== null && !channels.some((c) => c.id === value);

  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <select
        value={value ?? ""}
        disabled={channels === null}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">— none —</option>
        {missing && <option value={value}>Unknown channel ({value})</option>}
        {(channels ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
      {channels === null && <span className="dim">Loading channels…</span>}
      {missing && (
        <span className="dim">
          I can't see this channel any more — it was deleted, or I lost access to it. Nothing
          posts there.
        </span>
      )}
      {hint && <span className="dim">{hint}</span>}
    </label>
  );
}

export default function Welcomer({ guildId }: { guildId: string }) {
  const [config, setConfig] = useState<WelcomerBody | null>(null);
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await http.get<WelcomerDTO | null>(`/api/guilds/${guildId}/welcomer`);
      // null means the guild has never saved, not a failure. Seeding from
      // DEFAULTS makes the form show exactly what a first save would store.
      setConfig(c ? stripId(c) : { ...DEFAULTS });
    } catch (e) {
      setError(apiMessage(e, "Couldn't load welcomer settings."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Separate request, separate failure: the picker being unavailable must not
  // stop the settings themselves from loading.
  useEffect(() => {
    http
      .get<GuildChannel[]>(`/api/guilds/${guildId}/resources/channels`)
      .then(setChannels)
      .catch(() => setChannelsFailed(true));
  }, [guildId]);

  if (error && !config) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!config) return <Loading rows={5} />;

  const patch = (next: Partial<WelcomerBody>) => {
    setConfig({ ...config, ...next });
    setSaved(false);
  };

  async function save() {
    if (!config) return;

    // joinImageUrl goes through z.string().url(), and "" fails it. Catching a
    // malformed URL here keeps a typo from coming back as a 400 whose detail
    // this client can't unpack into a field name.
    const image = (config.joinImageUrl ?? "").trim();
    if (image && !/^https?:\/\/\S+$/i.test(image)) {
      setError("The image URL has to be a full address starting with http:// or https://.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const body: WelcomerBody = {
        ...config,
        joinImageUrl: image || null,
        joinDmMessage: config.joinDmMessage?.trim() ? config.joinDmMessage : null,
      };
      const updated = await http.put<WelcomerDTO>(`/api/guilds/${guildId}/welcomer`, body);
      setConfig(stripId(updated));
      setSaved(true);
    } catch (e) {
      setError(apiMessage(e, "Couldn't save."));
    } finally {
      setSaving(false);
    }
  }

  // The silently-broken states: saved, valid, and doing nothing at runtime.
  const joinNoChannel = config.joinEnabled && !config.joinChannelId;
  const joinNoMessage = config.joinEnabled && !config.joinMessage.trim();
  const dmNoMessage = config.joinDmEnabled && !config.joinDmMessage?.trim();
  const leaveNoChannel = config.leaveEnabled && !config.leaveChannelId;
  const nothingOn = !config.joinEnabled && !config.leaveEnabled && !config.joinDmEnabled;
  const joinWorks = config.joinEnabled && !joinNoChannel && !joinNoMessage;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Welcomer</h1>
        <p className="dim">
          What happens when someone joins or leaves: a message in a channel, a DM, and the
          roles they start with.
        </p>
      </header>

      {joinNoChannel && (
        <Banner level="act" title="Join messages are on, but there's no channel">
          Nothing is posted when someone joins until you pick one.
        </Banner>
      )}

      {joinNoMessage && (
        <Banner level="act" title="The join message is empty">
          The channel is set but there's nothing to say, so nothing gets posted.
        </Banner>
      )}

      {dmNoMessage && (
        <Banner level="act" title="The join DM is on with no text">
          There's nothing to send. Write the DM, or turn it off.
        </Banner>
      )}

      {leaveNoChannel && (
        <Banner level="act" title="Leave messages are on, but there's no channel">
          Nothing is posted when someone leaves until you pick one.
        </Banner>
      )}

      {nothingOn && (
        <Banner level="watch" title="Welcomer is off">
          Joins and leaves pass silently. Auto-roles below are still granted on join — they
          don't depend on any of these switches.
        </Banner>
      )}

      <Panel title="When someone joins">
        <label className="row">
          <input
            type="checkbox"
            checked={config.joinEnabled}
            onChange={(e) => patch({ joinEnabled: e.target.checked })}
          />
          <span>
            <strong>Post a welcome message in a channel</strong>
            <span className="dim block">Sent as an embed, so links and the banner render.</span>
          </span>
        </label>

        <ChannelField
          label="Welcome channel"
          channels={channels}
          failed={channelsFailed}
          value={config.joinChannelId}
          onChange={(id) => patch({ joinChannelId: id })}
        />

        <label className="field">
          <span className="eyebrow">Welcome message</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={config.joinMessage}
            placeholder={DEFAULTS.joinMessage}
            onChange={(e) => patch({ joinMessage: e.target.value })}
          />
          <span className="dim">{config.joinMessage.length} / 2000</span>
        </label>

        <Placeholders />

        <div className="field">
          <span className="eyebrow">Embed colour</span>
          <div className="actions">
            <input
              type="color"
              value={hexOf(config.joinEmbedColor)}
              onChange={(e) => patch({ joinEmbedColor: parseInt(e.target.value.slice(1), 16) })}
              aria-label="Embed colour"
            />
            <span className="mono dim">{hexOf(config.joinEmbedColor)}</span>
            {config.joinEmbedColor !== DEFAULT_COLOR && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => patch({ joinEmbedColor: DEFAULT_COLOR })}
              >
                Reset to blurple
              </button>
            )}
          </div>
        </div>

        <label className="field">
          <span className="eyebrow">Banner image</span>
          <input
            value={config.joinImageUrl ?? ""}
            placeholder="https://…/welcome.png"
            onChange={(e) => patch({ joinImageUrl: e.target.value || null })}
          />
          <span className="dim">
            Shown at the bottom of the embed. Discord fetches it itself, so anything behind a
            login or an IP allowlist renders as a broken image for everyone.
          </span>
        </label>
      </Panel>

      <Panel title="Welcome DM">
        <label className="row">
          <input
            type="checkbox"
            checked={config.joinDmEnabled}
            onChange={(e) => patch({ joinDmEnabled: e.target.checked })}
          />
          <span>
            <strong>Also DM the new member</strong>
            <span className="dim block">
              Best-effort. Anyone with DMs from server members turned off gets nothing, and
              there's no way to tell — so don't put anything here that exists nowhere else.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">DM text</span>
          <textarea
            rows={4}
            maxLength={2000}
            value={config.joinDmMessage ?? ""}
            placeholder="Thanks for joining {guild} — start in #rules."
            onChange={(e) => patch({ joinDmMessage: e.target.value || null })}
          />
          <span className="dim">
            Same placeholders as above. {(config.joinDmMessage ?? "").length} / 2000
          </span>
        </label>
      </Panel>

      <Panel title="Roles granted on join">
        <RolePicker
          guildId={guildId}
          label="Auto-roles"
          value={config.autoRoleIds}
          onChange={(ids) => patch({ autoRoleIds: ids })}
          hint="Given to everyone who joins, with no choice involved. For roles members pick for themselves, use Role menus instead."
        />
        {config.autoRoleIds.length > 0 && (
          <p className="dim">
            Needs Manage Roles, and every one of these has to sit below my highest role.
            Discord refuses the rest per member, silently, with nothing in the audit log to
            explain it.
          </p>
        )}
      </Panel>

      <Panel title="When someone leaves">
        <label className="row">
          <input
            type="checkbox"
            checked={config.leaveEnabled}
            onChange={(e) => patch({ leaveEnabled: e.target.checked })}
          />
          <span>
            <strong>Post a goodbye message</strong>
            <span className="dim block">
              Fires on a kick and a ban as well as a voluntary leave — Discord reports all
              three the same way, so word it for all three.
            </span>
          </span>
        </label>

        <ChannelField
          label="Goodbye channel"
          channels={channels}
          failed={channelsFailed}
          value={config.leaveChannelId}
          onChange={(id) => patch({ leaveChannelId: id })}
          hint="Usually a staff channel — a leave is more often a moderation signal than something the server wants announced."
        />

        <label className="field">
          <span className="eyebrow">Goodbye message</span>
          <textarea
            rows={2}
            maxLength={2000}
            value={config.leaveMessage}
            placeholder={DEFAULTS.leaveMessage}
            onChange={(e) => patch({ leaveMessage: e.target.value })}
          />
          <span className="dim">
            {"{membercount}"} is the count after they left. {config.leaveMessage.length} / 2000
          </span>
        </label>
      </Panel>

      {error && <Banner level="act" title="Couldn't save">{error}</Banner>}

      <div className="actions">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="dim">Saved.</span>}
        <Pill level={joinWorks ? "ok" : "watch"}>
          {joinWorks ? "Welcoming new members" : "Not welcoming anyone"}
        </Pill>
      </div>
    </div>
  );
}

function Placeholders() {
  return (
    <div className="field">
      <span className="eyebrow">Placeholders</span>
      <div className="actions wrap">
        {PLACEHOLDERS.map((p) => (
          <span key={p.token} className="dim" style={{ fontSize: 12 }}>
            <span className="mono">{p.token}</span> — {p.means}
          </span>
        ))}
      </div>
      <span className="dim">
        Anything else in braces is left exactly as typed, so a typo shows up in the message
        instead of vanishing.
      </span>
    </div>
  );
}

/** The API echoes guildId back on every write; the form never sends it. */
function stripId(dto: WelcomerDTO): WelcomerBody {
  const { guildId: _guildId, ...body } = dto;
  return body;
}
