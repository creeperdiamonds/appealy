// web/src/pages/OpsAppeals.tsx
//
// Operator review queue for PLATFORM ban appeals. Nothing to do with the guild
// ban-appeal feature (see APPEALS.md) — this is people appealing bans we
// issued, and it's the only place `notes` and `evidence` are ever shown.
//
// Not a security boundary. `/api/ops/*` returns 404 to anyone not in
// OPS_USER_IDS regardless of what the client renders; this page just doesn't
// bother rendering if the request comes back empty.
//
// Two things the design is trying to enforce
// ------------------------------------------
// 1. Automated bans surface first. The API sorts them there, and the badge
//    repeats it, because a heuristic false positive waiting four days is a
//    much worse outcome than a reviewed ban waiting four days.
//
// 2. A decision requires a written note, and the note goes to the appellant.
//    The API rejects an empty one — enforced here too so the reviewer finds
//    out before they've typed nothing and clicked. Deciding someone's access
//    without telling them why is how you generate the next three appeals.

import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type OpsAppeal } from "../lib/api";
import { Panel, Banner, Loading, Empty, formatRelative } from "../components/ui";

export default function OpsAppeals() {
  const [appeals, setAppeals] = useState<OpsAppeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.opsAppeals();
      setAppeals(res.appeals);
    } catch (e) {
      // A 404 here means "not an operator", which is the intended answer for
      // most visitors — show nothing rather than an error that implies
      // something is broken.
      if (e instanceof ApiError && e.status === 404) setAppeals([]);
      else setError(e instanceof ApiError ? e.message : "Couldn't load the queue.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "accept" | "deny") {
    const note = (notes[id] ?? "").trim();
    if (!note) {
      setError("Write what you're telling them before deciding.");
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await api.decideAppeal(id, decision, note);
      setAppeals((prev) => (prev ?? []).filter((a) => a.id !== id));
      setNotes(({ [id]: _drop, ...rest }) => rest);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't record the decision.");
    } finally {
      setBusy(null);
    }
  }

  if (error && !appeals) return <Banner level="act" title="Couldn't load" body={error} />;
  if (!appeals) return <Loading rows={3} />;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Appeal queue</h1>
        <p className="dim">
          {appeals.length === 0
            ? "Nothing waiting."
            : `${appeals.length} open. Automated bans first.`}
        </p>
      </header>

      {error && <Banner level="act" title="Couldn't save" body={error} />}

      {appeals.length === 0 && (
        <Empty title="Queue is clear" hint="New appeals appear here as they're submitted." />
      )}

      {appeals.map((a) => (
        <Panel key={a.id}>
          <div className="ops-appeal-head">
            <div>
              <strong>
                {a.ban.subject === "guild" ? "Server" : "User"} {a.ban.subjectId}
              </strong>
              <span className="dim block">
                banned {formatRelative(a.ban.createdAt)} · appealed {formatRelative(a.createdAt)} ·
                filed by {a.appellantId}
              </span>
            </div>
            {a.ban.automated && <span className="pill is-watch">Automated</span>}
          </div>

          <dl className="ban-facts">
            <div className="ban-fact">
              <dt className="eyebrow">Told them</dt>
              <dd>{a.ban.reasonPublic}</dd>
            </div>
            <div className="ban-fact">
              <dt className="eyebrow">Internal</dt>
              {/* The only place these ever render. */}
              <dd className="dim">{a.ban.notes || "—"}</dd>
            </div>
            {a.ban.evidence && (
              <div className="ban-fact">
                <dt className="eyebrow">Evidence</dt>
                <dd>
                  <pre className="evidence">{JSON.stringify(a.ban.evidence, null, 2)}</pre>
                </dd>
              </div>
            )}
          </dl>

          <div className="field">
            <span className="eyebrow">What they wrote</span>
            <blockquote className="appeal-body">{a.body}</blockquote>
          </div>

          <label className="field">
            <span className="eyebrow">Your reply — they will read this</span>
            <textarea
              rows={3}
              value={notes[a.id] ?? ""}
              onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
              placeholder={
                a.ban.automated
                  ? "If this was a false positive, say so plainly — it's the most useful thing they can hear."
                  : "What you decided and why."
              }
            />
          </label>

          <div className="actions">
            <button
              className="btn-primary"
              disabled={busy === a.id}
              onClick={() => decide(a.id, "accept")}
            >
              {busy === a.id ? "Saving…" : "Accept and lift the ban"}
            </button>
            <button
              className="btn-secondary"
              disabled={busy === a.id}
              onClick={() => decide(a.id, "deny")}
            >
              Deny
            </button>
            <span className="dim">
              Denying starts a 30-day wait before they can appeal again.
            </span>
          </div>
        </Panel>
      ))}
    </div>
  );
}
