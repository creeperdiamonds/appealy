// web/src/pages/Moderation.tsx
//
// Settings for the moderation commands (/ban, /kick, /mute… and
// "@Appealy ban"): whether the mention form works, and which roles may use
// them. One row per guild (api/src/routes/moderation.ts); GET returns the
// defaults for a guild that never saved, so what's shown is what's in effect.
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
  allowedRoleIds: string[];
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

  async function save() {
    if (!config) return;
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
          Commands for your moderators: <span className="mono">/ban</span>, <span className="mono">/kick</span>,{" "}
          <span className="mono">/mute</span> and more. They can also be typed as a mention, like{" "}
          <span className="mono">@Appealy ban @user spamming</span>.
        </p>
      </header>

      <Banner level="watch" title="The ? commands are gone">
        <span className="mono">?ban</span>, <span className="mono">?kick</span> and the rest no longer work, because
        Discord asks bots to use slash commands instead. Use{" "}
        <span className="mono">/ban</span> or <span className="mono">@Appealy ban</span>. They take the same lengths and
        reasons.
      </Banner>

      <Panel title="Who can use them">
        <RolePicker
          guildId={guildId}
          label="Only these roles can use them"
          hint="Leave empty to let anyone with the right Discord permission use them (Ban Members for ban, Kick Members for kick, Timeout Members for mute). Choosing roles narrows that further; it never grants a permission. The server owner can always use them."
          value={config.allowedRoleIds}
          onChange={(ids) => patch({ allowedRoleIds: ids })}
        />

        <label className="row">
          <input
            type="checkbox"
            checked={config.textCommandsEnabled}
            onChange={(e) => patch({ textCommandsEnabled: e.target.checked })}
          />
          <span>
            <strong>Let moderators type them as a mention</strong>
            <span className="dim block">
              “@Appealy ban @user spamming”. Turning this off leaves the slash commands working. To hide those, use
              Server Settings → Integrations → Appealy in Discord.
            </span>
          </span>
        </label>
      </Panel>

      <Panel title="Commands">
        <ul className="plain stack" style={{ gap: 6 }}>
          <li>
            <span className="mono">/ban user [duration] [reason] [appeal]</span>
            <span className="dim block">
              A duration like <span className="mono">7d</span> makes the ban temporary; Appealy unbans when it ends.
              Set <span className="mono">appeal</span> to false to skip the appeal button.
            </span>
          </li>
          <li>
            <span className="mono">/unban user [reason]</span>
            <span className="dim block">Paste their user ID, since they aren't in the server.</span>
          </li>
          <li>
            <span className="mono">/kick user [reason]</span>
          </li>
          <li>
            <span className="mono">/mute user [duration] [reason]</span>
            <span className="dim block">A Discord timeout, up to 28 days. One hour if no length is given.</span>
          </li>
          <li>
            <span className="mono">/unmute user [reason]</span>
          </li>
        </ul>
        <p className="dim">
          As a mention: <span className="mono">@Appealy ban [noappeal] @user [7d] [reason]</span>, and the same for the
          others.
        </p>
      </Panel>

      {error && <Banner level="act" title="Couldn't save">{error}</Banner>}

      <div className="actions">
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <Pill level="ok">Saved</Pill>}
      </div>
    </div>
  );
}
