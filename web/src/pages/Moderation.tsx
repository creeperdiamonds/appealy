// web/src/pages/Moderation.tsx
//
// Settings for the text moderation commands (?ban, ?kick, ?mute…): whether
// they work at all, the prefix, and which roles may use them. One row per
// guild (api/src/routes/moderation.ts); GET returns the defaults for a guild
// that never saved, so what's shown is what's in effect.
//
// The commands themselves still need the matching Discord permission (Ban
// Members, Kick Members, Timeout Members). The role list here narrows who can
// use them further; it never grants anything.

import { useCallback, useEffect, useState } from "react";
import { ApiError, http } from "../lib/api";
import { Banner, Loading, Panel, Pill } from "../components/ui";
import { RolePicker } from "../components/RolePicker";

interface ModerationConfig {
  textCommandsEnabled: boolean;
  prefix: string;
  allowedRoleIds: string[];
}

/** The same rule as the API and the bot (bot/src/services/modCommands.ts validPrefix). */
const PREFIX = /^[^\s/@<#:`][^\s`]{0,4}$/;

function prefixProblem(prefix: string): string | null {
  if (!prefix) return "The prefix can't be empty.";
  if (prefix.length > 5) return "Keep the prefix to 5 characters or fewer.";
  if (/[\s`]/.test(prefix)) return "The prefix can't contain spaces or backticks.";
  if (!PREFIX.test(prefix)) return "The prefix can't start with / @ < # or :, which Discord uses itself.";
  return null;
}

export default function Moderation({ guildId }: { guildId: string }) {
  const [config, setConfig] = useState<ModerationConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfig(await http.get<ModerationConfig>(`/api/guilds/${guildId}/moderation`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load moderation settings.");
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !config) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!config) return <Loading rows={4} />;

  const patch = (next: Partial<ModerationConfig>) => {
    setConfig({ ...config, ...next });
    setSaved(false);
  };
  const problem = prefixProblem(config.prefix);
  const p = config.prefix || "?";

  async function save() {
    if (!config || problem) return;
    setSaving(true);
    setError(null);
    try {
      setConfig(await http.put<ModerationConfig>(`/api/guilds/${guildId}/moderation`, config));
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Moderation</h1>
        <p className="dim">
          Text commands for your moderators: <span className="mono">{p}ban</span>,{" "}
          <span className="mono">{p}kick</span>, <span className="mono">{p}mute</span> and more,
          typed straight into chat.
        </p>
      </header>

      {!config.textCommandsEnabled && (
        <Banner level="watch" title="Text commands are off">
          Appealy ignores {p}ban, {p}mute and the rest, including “@Appealy ban”. Discord's own
          ban and timeout menus still work, and still send appeal buttons.
        </Banner>
      )}

      <Panel title="Text commands">
        <label className="row">
          <input
            type="checkbox"
            checked={config.textCommandsEnabled}
            onChange={(e) => patch({ textCommandsEnabled: e.target.checked })}
          />
          <span>
            <strong>Let moderators use text commands</strong>
            <span className="dim block">
              Turn this off if another bot already uses the same commands in your server.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Prefix</span>
          <input
            className="mono"
            value={config.prefix}
            maxLength={5}
            placeholder="?"
            disabled={!config.textCommandsEnabled}
            onChange={(e) => patch({ prefix: e.target.value.trim() })}
            style={{ maxWidth: 120 }}
          />
          <span className="dim">
            {problem ??
              `Commands start with ${p}, as in ${p}ban. Mentioning Appealy (“@Appealy ban …”) always works too.`}
          </span>
        </label>

        <RolePicker
          guildId={guildId}
          label="Only these roles can use them"
          hint="Leave empty to let anyone with the right Discord permission use them (Ban Members for ban, Kick Members for kick, Timeout Members for mute). Choosing roles narrows that further; it never grants a permission. The server owner can always use them."
          value={config.allowedRoleIds}
          onChange={(ids) => patch({ allowedRoleIds: ids })}
        />
      </Panel>

      <Panel title="Commands">
        <ul className="plain stack" style={{ gap: 6 }}>
          <li>
            <span className="mono">{p}ban [noappeal] @user [7d] [reason]</span>
            <span className="dim block">
              A length makes the ban temporary; Appealy unbans when it ends. <span className="mono">noappeal</span> skips
              the appeal button.
            </span>
          </li>
          <li>
            <span className="mono">{p}unban &lt;user id&gt; [reason]</span>
          </li>
          <li>
            <span className="mono">{p}kick @user [reason]</span>
          </li>
          <li>
            <span className="mono">{p}mute @user [10m, 2h, 1d] [reason]</span>
            <span className="dim block">A Discord timeout, up to 28 days. One hour if no length is given.</span>
          </li>
          <li>
            <span className="mono">{p}unmute @user [reason]</span>
          </li>
        </ul>
      </Panel>

      {error && <Banner level="act" title="Couldn't save">{error}</Banner>}

      <div className="actions">
        <button className="btn btn-primary" disabled={saving || Boolean(problem)} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <Pill level="ok">Saved</Pill>}
      </div>
    </div>
  );
}
