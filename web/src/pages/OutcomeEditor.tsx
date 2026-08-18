// web/src/pages/OutcomeEditor.tsx
//
// Editor for a form's accept outcomes.
//
// This screen's real job is making a privilege decision legible. Someone
// configuring outcomes is deciding what roles the bot hands out and who may
// hand them out, and the failure mode isn't a validation error — it's a form
// that works exactly as configured and shouldn't have been configured that
// way. So the warnings below are inline and permanent, not toasts.
//
// Three states the API accepts and this screen has to argue with:
//
//   1. An outcome granting roles with minStaffLevel 0. Any reviewer can now
//      hand out those roles. Fine for @Trainee, not fine for @Moderator, and
//      the difference is invisible from the data — only the person editing
//      knows what those role ids mean.
//   2. An outcome that grants and removes nothing. Almost always someone who
//      meant to pick roles and didn't.
//   3. Deleting the last outcome, which silently reverts the form to a single
//      Accept button using the form's own roles.

import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type FormOutcomeDTO } from "../lib/api";
import { Panel, Banner, Loading, Empty } from "../components/ui";
import { RolePicker } from "../components/RolePicker";

type Draft = Omit<FormOutcomeDTO, "id"> & { id?: string; isNoop?: boolean };

const LEVELS = [
  { value: 0, label: "Any reviewer", hint: "Everyone who can review this form" },
  { value: 1, label: "Admins only", hint: "Excludes per-form managers" },
  { value: 2, label: "Owners only", hint: "Server owner and Administrators" },
];

const blank = (): Draft => ({
  // Required by FormOutcomeDTO and previously omitted, so this file never
  // compiled. "accept" is the safer default of the two: a new outcome that
  // silently defaulted to denying would be a bad surprise, and the editor
  // shows the field for changing it.
  decision: "accept",
  label: "",
  description: null,
  emoji: null,
  grantRoleIds: [],
  removeRoleIds: [],
  message: null,
  logChannelId: null,
  minStaffLevel: 0,
  position: 0,
  requiresConfirm: true,
});

export default function OutcomeEditor({ guildId, formId }: { guildId: string; formId: string }) {
  const [outcomes, setOutcomes] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.outcomes(guildId, formId);
      setOutcomes(res.outcomes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't load outcomes.");
    }
  }, [guildId, formId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !outcomes) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!outcomes) return <Loading rows={3} />;

  const patch = (i: number, next: Partial<Draft>) =>
    setOutcomes(outcomes.map((o, n) => (n === i ? { ...o, ...next } : o)));

  async function save(i: number) {
    const o = outcomes![i];
    if (!o.label.trim()) {
      setError("An outcome needs a name — it's what reviewers pick from the menu.");
      return;
    }
    setSaving(i);
    setError(null);
    try {
      const saved = o.id
        ? await api.updateOutcome(guildId, formId, o.id, o)
        : await api.createOutcome(guildId, formId, o);
      setOutcomes(outcomes!.map((x, n) => (n === i ? saved.outcome : x)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setSaving(null);
    }
  }

  async function remove(i: number) {
    const o = outcomes![i];
    if (!o.id) return setOutcomes(outcomes!.filter((_, n) => n !== i));
    try {
      const res = await api.deleteOutcome(guildId, formId, o.id);
      setOutcomes(outcomes!.filter((_, n) => n !== i));
      if (res.revertedToSingleAccept) {
        setError(
          "That was the last outcome. This form is back to a single Accept button using the form's own roles.",
        );
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't delete.");
    }
  }

  // Reviewers see these in position order. Preview the actual menu so the
  // person editing sees what a reviewer will see, not a list of database rows.
  const sorted = [...outcomes].sort((a, b) => a.position - b.position);

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Accept outcomes</h1>
        <p className="dim">
          Reviewers pick one instead of a single Accept. Leave this empty and the form keeps
          its current single-Accept behaviour.
        </p>
      </header>

      {error && <Banner level="act" title="Heads up">{error}</Banner>}

      {outcomes.length > 0 && (
        <Panel title="What reviewers will see">
          <div className="menu-preview">
            <div className="menu-preview-bar">Accept as… ▾</div>
            {sorted.map((o) => (
              <div key={o.id ?? o.label} className="menu-preview-option">
                <span>{o.emoji ? `${o.emoji} ` : ""}{o.label || <em className="dim">unnamed</em>}</span>
                {o.description && <span className="dim block">{o.description}</span>}
              </div>
            ))}
            <div className="menu-preview-deny">Deny</div>
          </div>
        </Panel>
      )}

      {outcomes.length === 0 && (
        <Empty
          title="No outcomes yet"
          hint="Add one to let reviewers choose what someone is accepted as."
        />
      )}

      {outcomes.map((o, i) => {
        const grantsRoles = o.grantRoleIds.length > 0;
        const openToEveryone = grantsRoles && o.minStaffLevel === 0;
        const noop = o.grantRoleIds.length === 0 && o.removeRoleIds.length === 0;

        return (
          <Panel key={o.id ?? `new-${i}`}>
            <label className="field">
              <span className="eyebrow">Name</span>
              <input
                value={o.label}
                maxLength={100}
                placeholder="Moderator"
                onChange={(e) => patch(i, { label: e.target.value })}
              />
            </label>

            <label className="field">
              <span className="eyebrow">Description</span>
              <input
                value={o.description ?? ""}
                maxLength={100}
                placeholder="full permissions, can ban members"
                onChange={(e) => patch(i, { description: e.target.value || null })}
              />
              <span className="dim">
                Shown under the name in the menu. This is where the consequence goes — it's the
                last thing a reviewer reads before granting it.
              </span>
            </label>

            <RolePicker
              guildId={guildId}
              label="Roles granted"
              value={o.grantRoleIds}
              onChange={(ids) => patch(i, { grantRoleIds: ids })}
            />

            <RolePicker
              guildId={guildId}
              label="Roles removed"
              value={o.removeRoleIds}
              onChange={(ids) => patch(i, { removeRoleIds: ids })}
              hint="On top of any roles the form already removes on every decision."
            />

            <label className="field">
              <span className="eyebrow">Who can pick this</span>
              <select
                value={o.minStaffLevel}
                onChange={(e) => patch(i, { minStaffLevel: Number(e.target.value) })}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label} — {l.hint}
                  </option>
                ))}
              </select>
            </label>

            {/* The warning that matters. Inline and permanent, because it
                describes a working configuration rather than an error. */}
            {openToEveryone && (
              <Banner level="watch" title="Any reviewer can grant these roles">
                If this outcome hands out real power,
                restrict it. A trainee who can review
                trainee applications could otherwise use
                this to promote someone — including
                themselves, via a friend.
              </Banner>
            )}

            {noop && (
              <Banner level="watch" title="This outcome doesn't do anything">
                No roles granted or removed. Fine if you're
                handling roles manually and just want the
                decision recorded — otherwise you probably
                meant to pick some.
              </Banner>
            )}

            <label className="row">
              <input
                type="checkbox"
                checked={o.requiresConfirm || o.minStaffLevel > 0}
                disabled={o.minStaffLevel > 0}
                onChange={(e) => patch(i, { requiresConfirm: e.target.checked })}
              />
              <span>
                <strong>Confirm before applying</strong>
                <span className="dim block">
                  {o.minStaffLevel > 0
                    ? "Always on for restricted outcomes — the guard can't be disabled where it matters most."
                    : "Shows what will be granted and removed before anything happens."}
                </span>
              </span>
            </label>

            <div className="actions">
              <button className="btn-primary" disabled={saving === i} onClick={() => save(i)}>
                {saving === i ? "Saving…" : o.id ? "Save" : "Create"}
              </button>
              <button className="btn-secondary" onClick={() => remove(i)}>
                Delete
              </button>
            </div>
          </Panel>
        );
      })}

      <div className="actions">
        <button
          className="btn-secondary"
          onClick={() => setOutcomes([...outcomes, { ...blank(), position: outcomes.length }])}
        >
          Add outcome
        </button>
        {outcomes.length >= 20 && (
          <span className="dim">
            Discord allows 25 options in a menu. Past that they simply won't appear.
          </span>
        )}
      </div>
    </div>
  );
}
