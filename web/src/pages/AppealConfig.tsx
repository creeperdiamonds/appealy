// web/src/pages/AppealConfig.tsx
//
// Settings for the guild's own ban-appeal flow: when someone is banned from
// this server, DM them a form, and unban them if staff accept it.
//
// Nothing here touches platform bans (see APPEALS.md). Guild staff can't see
// those and shouldn't be given a control that looks like they can.
//
// The page's real job is stopping a silently-broken config. There are three
// ways to enable this feature and have it do nothing:
//
//   1. enabled, but no form chosen
//   2. a form chosen that isn't kind = "appeal"
//   3. dmOnBanEnabled off, which leaves no entry point at all
//
// The API rejects (2). This page has to surface (1) and (3), because both are
// valid states the server accepts and neither produces an error an admin would
// ever see — they'd just find out months later that nobody ever appealed.

import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type AppealConfigDTO, type FormSummary } from "../lib/api";
import { Panel, Banner, Loading, Empty } from "../components/ui";

export default function AppealConfig({ guildId }: { guildId: string }) {
  const [config, setConfig] = useState<AppealConfigDTO | null>(null);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([api.appealConfig(guildId), api.forms(guildId)]);
      setConfig(c);
      setForms(f);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load appeal settings.");
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !config) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!config) return <Loading rows={4} />;

  // Only appeal-kind forms are selectable. A normal application form would be
  // accepted by neither the API nor the bot, and offering it here would make
  // the rejection look like a bug rather than a rule.
  const appealForms = forms.filter((f) => f.kind === "appeal");
  const chosen = appealForms.find((f) => f.id === config.formId) ?? null;

  const patch = (next: Partial<AppealConfigDTO>) => {
    setConfig({ ...config, ...next });
    setSaved(false);
  };

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.saveAppealConfig(guildId, {
        enabled: config.enabled,
        formId: config.formId,
        dmOnBanEnabled: config.dmOnBanEnabled,
        dmOnBanNote: config.dmOnBanNote,
        autoUnbanOnAccept: config.autoUnbanOnAccept,
      });
      setConfig(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  // The two silently-broken states.
  const missingForm = config.enabled && !config.formId;
  const noEntryPoint = config.enabled && !!config.formId && !config.dmOnBanEnabled;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Ban appeals</h1>
        <p className="dim">
          When someone is banned from this server, send them a form. Accepting their
          appeal can unban them automatically.
        </p>
      </header>

      {appealForms.length === 0 && (
        <Banner level="watch" title="No appeal form yet">
          Create a form with kind "Appeal" and delivery "Direct
          message" first — a banned member can’t reach a panel or
          /apply.
        </Banner>
      )}

      {missingForm && (
        <Banner level="act" title="Enabled, but no form selected">
          Nothing will be sent to banned members until you choose
          one.
        </Banner>
      )}

      {noEntryPoint && (
        <Banner level="watch" title="Nobody can start an appeal">
          The form is set but the ban-time DM is off, and there's
          no other way in. Turn the DM back on, or tell members in
          your ban message how to reach you.
        </Banner>
      )}

      <Panel title="Settings">
        <label className="row">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>
            <strong>Enable ban appeals</strong>
            <span className="dim block">Off means banned members are never contacted.</span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Appeal form</span>
          <select
            value={config.formId ?? ""}
            disabled={appealForms.length === 0}
            onChange={(e) => patch({ formId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {appealForms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {chosen && !chosen.active && (
            <span className="dim">
              This form is currently inactive, so nothing will send until you activate it.
            </span>
          )}
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={config.dmOnBanEnabled}
            onChange={(e) => patch({ dmOnBanEnabled: e.target.checked })}
          />
          <span>
            <strong>DM the form when someone is banned</strong>
            <span className="dim block">
              Best-effort. Discord may close the DM channel at the moment of the ban, so
              some members won't receive it — worth saying so in your ban message.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Note sent before the form</span>
          <textarea
            rows={4}
            value={config.dmOnBanNote ?? ""}
            maxLength={1000}
            onChange={(e) => patch({ dmOnBanNote: e.target.value || null })}
            placeholder="Explains why someone who was just banned is getting a DM from this bot."
          />
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={config.autoUnbanOnAccept}
            onChange={(e) => patch({ autoUnbanOnAccept: e.target.checked })}
          />
          <span>
            <strong>Unban automatically when an appeal is accepted</strong>
            <span className="dim block">
              Off means staff accept the appeal and then unban by hand. Requires the bot to
              have Ban Members either way.
            </span>
          </span>
        </label>
      </Panel>

      {error && <Banner level="act" title="Couldn't save">{error}</Banner>}

      <div className="actions">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="dim">Saved.</span>}
      </div>

      {appealForms.length === 0 && forms.length === 0 && (
        <Empty title="No forms in this server yet" hint="Create one under Forms to get started." />
      )}
    </div>
  );
}
