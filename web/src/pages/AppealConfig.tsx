// web/src/pages/AppealConfig.tsx
//
// Settings for the guild's own appeal flows. When someone is banned, timed out,
// or given one of the server's restriction roles, DM them a button to appeal;
// if staff accept it, undo the punishment — unban, lift the timeout, or remove
// the role.
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
import { RolePicker } from "../components/RolePicker";

// Discord caps a timeout at 28 days. Shorter than the threshold and no notice
// is sent: a ten-minute timeout is over before anyone could read an appeal.
const TIMEOUT_THRESHOLDS: [number, string][] = [
  [0, "Any length"],
  [600, "10 minutes"],
  [3600, "1 hour"],
  [21600, "6 hours"],
  [86400, "1 day"],
  [604800, "1 week"],
];

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
        timeoutEnabled: config.timeoutEnabled,
        timeoutFormId: config.timeoutFormId,
        timeoutMinSeconds: config.timeoutMinSeconds,
        dmOnTimeoutNote: config.dmOnTimeoutNote,
        liftTimeoutOnAccept: config.liftTimeoutOnAccept,
        restrictionEnabled: config.restrictionEnabled,
        restrictionRoleIds: config.restrictionRoleIds,
        restrictionFormId: config.restrictionFormId,
        dmOnRestrictionNote: config.dmOnRestrictionNote,
        liftRestrictionOnAccept: config.liftRestrictionOnAccept,
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
  // The same trap for the other two: switched on, and nothing will ever send.
  const timeoutMissingForm = config.timeoutEnabled && !config.timeoutFormId;
  const restrictionIncomplete =
    config.restrictionEnabled && (!config.restrictionFormId || config.restrictionRoleIds.length === 0);
  const thresholds = TIMEOUT_THRESHOLDS.some(([s]) => s === config.timeoutMinSeconds)
    ? TIMEOUT_THRESHOLDS
    : [...TIMEOUT_THRESHOLDS, [config.timeoutMinSeconds, `${config.timeoutMinSeconds} seconds`] as [number, string]];
  const formOptions = appealForms.map((f) => (
    <option key={f.id} value={f.id}>
      {f.name}
    </option>
  ));

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Appeals</h1>
        <p className="dim">
          When someone is banned, timed out, or given a restriction role, send them a way to
          appeal. Accepting it can undo the punishment automatically.
        </p>
      </header>

      {appealForms.length === 0 && (
        <Banner level="watch" title="No appeal form yet">
          Create a form with kind "Appeal" and delivery "Direct
          message" first — a banned or timed-out member can’t reach a
          panel or /apply.
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

      {timeoutMissingForm && (
        <Banner level="act" title="Timeout appeals are on, but no form is selected">
          Nobody who is timed out will hear from Appealy until you choose one.
        </Banner>
      )}

      {restrictionIncomplete && (
        <Banner level="act" title="Restriction appeals aren't fully set up">
          {!config.restrictionFormId
            ? "Choose an appeal form — nothing is sent without one."
            : "Pick at least one restriction role — nothing is sent until one is given out."}
        </Banner>
      )}

      <Panel title="Ban appeals">
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
          <span className="eyebrow">What the ban notice says</span>
          <textarea
            rows={4}
            value={config.dmOnBanNote ?? ""}
            maxLength={1000}
            onChange={(e) => patch({ dmOnBanNote: e.target.value || null })}
            placeholder="Tells them they were banned. An 'Appeal this ban' button is added underneath."
          />
          <span className="dim">
            Sent on its own, with a button. Nobody is asked a question until they press it —
            being banned is not an agreement to fill in a form, and most people only want to
            know what happened.
          </span>
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

      <Panel title="Timeout appeals">
        <label className="row">
          <input
            type="checkbox"
            checked={config.timeoutEnabled}
            onChange={(e) => patch({ timeoutEnabled: e.target.checked })}
          />
          <span>
            <strong>Enable timeout appeals</strong>
            <span className="dim block">
              DMs a member a button to appeal when they're timed out. They're still in the
              server, so it reaches them unless they've closed their DMs.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Appeal form</span>
          <select
            value={config.timeoutFormId ?? ""}
            disabled={appealForms.length === 0}
            onChange={(e) => patch({ timeoutFormId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {formOptions}
          </select>
        </label>

        <label className="field">
          <span className="eyebrow">Only for timeouts of at least</span>
          <select
            value={config.timeoutMinSeconds}
            onChange={(e) => patch({ timeoutMinSeconds: Number(e.target.value) })}
          >
            {thresholds.map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {label}
              </option>
            ))}
          </select>
          <span className="dim">Shorter timeouts are over before anyone could read an appeal.</span>
        </label>

        <label className="field">
          <span className="eyebrow">What the timeout notice says</span>
          <textarea
            rows={3}
            value={config.dmOnTimeoutNote ?? ""}
            maxLength={1000}
            onChange={(e) => patch({ dmOnTimeoutNote: e.target.value || null })}
            placeholder="Tells them they were timed out, and until when. An 'Appeal this timeout' button is added underneath."
          />
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={config.liftTimeoutOnAccept}
            onChange={(e) => patch({ liftTimeoutOnAccept: e.target.checked })}
          />
          <span>
            <strong>Lift the timeout automatically when an appeal is accepted</strong>
            <span className="dim block">
              Needs the Timeout Members permission. A server that added Appealy before timeout
              appeals existed may have to grant it; the review post says so if it's missing.
            </span>
          </span>
        </label>
      </Panel>

      <Panel title="Restriction appeals">
        <label className="row">
          <input
            type="checkbox"
            checked={config.restrictionEnabled}
            onChange={(e) => patch({ restrictionEnabled: e.target.checked })}
          />
          <span>
            <strong>Enable restriction appeals</strong>
            <span className="dim block">
              For punishments that restrict instead of ban. DMs a member a button to appeal when
              they're given one of the roles below.
            </span>
          </span>
        </label>

        <RolePicker
          guildId={guildId}
          value={config.restrictionRoleIds}
          onChange={(ids) => patch({ restrictionRoleIds: ids })}
          label="Restriction roles"
          hint="The roles your punishment ladder hands out — no media, no pings, lost channels, a full lockout."
        />

        <label className="field">
          <span className="eyebrow">Appeal form</span>
          <select
            value={config.restrictionFormId ?? ""}
            disabled={appealForms.length === 0}
            onChange={(e) => patch({ restrictionFormId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {formOptions}
          </select>
        </label>

        <label className="field">
          <span className="eyebrow">What the restriction notice says</span>
          <textarea
            rows={3}
            value={config.dmOnRestrictionNote ?? ""}
            maxLength={1000}
            onChange={(e) => patch({ dmOnRestrictionNote: e.target.value || null })}
            placeholder="Tells them which role they were given. An 'Appeal this restriction' button is added underneath."
          />
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={config.liftRestrictionOnAccept}
            onChange={(e) => patch({ liftRestrictionOnAccept: e.target.checked })}
          />
          <span>
            <strong>Remove the restriction role automatically when an appeal is accepted</strong>
            <span className="dim block">
              Needs Manage Roles, with Appealy's role above the restriction roles. To step
              someone down a tier instead, give the form an accept outcome that grants the
              lower tier's role.
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
