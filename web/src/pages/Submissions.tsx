// web/src/pages/Submissions.tsx
//
// The review queue. Opening an application shows what they answered, Accept
// and Deny for someone allowed to decide it, and its history. A decision made
// here is carried out by the bot, by the same code as the buttons in Discord
// (bot/src/services/reviewDecision.ts): same roles, DMs and review post edit.
//
// Filtered server-side rather than client-side: a guild on a paid retention
// tier can hold two years of submissions, and shipping all of them to the
// browser to filter four of them into view is the kind of thing that works
// fine in development and falls over on the one customer who actually uses
// the product hard.

import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  type ReviewOptions,
  type ReviewOutcomeOption,
  type Submission,
  type SubmissionEvent,
  type FormSummary,
} from "../lib/api";
import {
  Panel,
  Pill,
  Empty,
  Loading,
  Banner,
  Sheet,
  formatRelative,
  formatDuration,
  snowflakeDate,
} from "../components/ui";
import { loadRoles, type GuildRole } from "../components/RolePicker";

const STATUSES = ["pending", "accepted", "denied", "withdrawn"] as const;

export default function Submissions({ guildId }: { guildId: string }) {
  const [status, setStatus] = useState<string>("pending");
  const [formId, setFormId] = useState<string>("");
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The application open in the sheet. Null = nothing open.
  const [open, setOpen] = useState<Submission | null>(null);

  useEffect(() => {
    api.forms(guildId).then(setForms).catch(() => setForms([]));
  }, [guildId]);

  useEffect(() => {
    setRows(null);
    api
      .submissions(guildId, { status, formId: formId || undefined })
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [guildId, status, formId]);

  const formName = (id: string) => forms.find((f) => f.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      {error && (
        <Banner level="act" title="Couldn't load applications">
          {error}
        </Banner>
      )}

      <Panel
        eyebrow="Queue"
        title="Applications"
        action={
          <div className="row">
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              aria-label="Filter by form"
            >
              <option value="">All forms</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {rows === null ? (
          <Loading rows={6} />
        ) : rows.length === 0 ? (
          <Empty
            title={status === "pending" ? "Nothing waiting" : `No ${status} applications`}
            hint={
              status === "pending"
                ? "Every application has been reviewed."
                : "Try a different status or form."
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Form</th>
                  <th>Status</th>
                  <th>Took</th>
                  <th>Submitted</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  // The whole row opens the application — there is one action
                  // per row, so the row is the target rather than a button
                  // hidden in one cell.
                  <tr
                    key={s.id}
                    className="row-clickable"
                    onClick={() => setOpen(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(s);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open application from ${s.applicant?.username ?? s.applicantId}`}
                  >
                    <td data-cell="head">
                      <div className="row" style={{ gap: 8 }}>
                        <Face id={s.applicantId} actors={applicantMap(s)} />
                        <div>
                          {s.applicant && <strong>{s.applicant.username}</strong>}
                          <div className="dim mono" style={{ fontSize: 11 }}>
                            {s.applicantId}
                          </div>
                          {/* Account age from the snowflake. When a wave of
                              applications arrives from accounts created the
                              same week, that is the most useful thing here. */}
                          <div className="dim" style={{ fontSize: 11 }}>
                            account created {snowflakeDate(s.applicantId).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Form">{formName(s.formId)}</td>
                    <td data-label="Status">
                      <Pill level={statusLevel(s.status)}>{s.status}</Pill>
                      {s.reviewerId && (
                        <div className="dim mono" style={{ fontSize: 11, marginTop: 3 }}>
                          by {s.reviewerId}
                        </div>
                      )}
                    </td>
                    <td data-label="Took" className="mono dim">
                      {s.completionSeconds ? formatDuration(s.completionSeconds) : "—"}
                    </td>
                    <td data-label="Submitted" className="dim">{formatRelative(s.createdAt)}</td>
                    <td className="dim" aria-hidden style={{ textAlign: "right" }}>
                      Open ›
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="dim" style={{ fontSize: 12, margin: 0 }}>
        Open an application to read the answers and accept or deny it. Deciding here does the same
        as the buttons in Discord: roles, the applicant's DM and the review post are all updated.
      </p>

      {open && (
        <Sheet title="Application" onClose={() => setOpen(null)}>
          <ApplicationSheet
            guildId={guildId}
            submission={open}
            formName={formName(open.formId)}
            onDecided={(next) => {
              const id = open.id;
              // The list is filtered by status, so a decided application leaves it.
              setRows((r) => r && r.filter((x) => x.id !== id || next === status));
              setOpen({ ...open, status: next });
            }}
          />
        </Sheet>
      )}
    </>
  );
}

function statusLevel(status: Submission["status"]): Parameters<typeof Pill>[0]["level"] {
  return status === "accepted" ? "ok" : status === "denied" ? "act" : status === "pending" ? "watch" : undefined;
}

function applicantMap(s: Submission): Record<string, Actor> {
  return s.applicant ? { [s.applicantId]: s.applicant } : {};
}

/* ------------------------------------------------------------------ *
 * One application: who, what they answered, the decision, the history.
 * ------------------------------------------------------------------ */

function ApplicationSheet({
  guildId,
  submission,
  formName,
  onDecided,
}: {
  guildId: string;
  submission: Submission;
  formName: string;
  onDecided: (status: "accepted" | "denied") => void;
}) {
  // Bumped when a decision lands, so the history is read again with it in.
  const [historyKey, setHistoryKey] = useState(0);
  const applicant = applicantMap(submission);

  return (
    <div>
      <div className="hist-subject">
        <Face id={submission.applicantId} actors={applicant} />
        <div>
          <div>
            <Actor id={submission.applicantId} actors={applicant} />
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            {formName} · sent {formatRelative(submission.createdAt)}
            {submission.completionSeconds ? ` · took ${formatDuration(submission.completionSeconds)}` : ""}
            {` · account created ${snowflakeDate(submission.applicantId).toLocaleDateString()}`}
          </div>
        </div>
      </div>

      <h3 className="eyebrow sheet-heading">Answers</h3>
      {submission.answers.length === 0 ? (
        <p className="dim">No answers were recorded for this application.</p>
      ) : (
        <dl className="answers">
          {submission.answers.map((a) => (
            <div key={a.questionId} className="answer">
              <dt>{a.label}</dt>
              <dd>{a.value || <span className="dim">(left blank)</span>}</dd>
            </div>
          ))}
        </dl>
      )}

      {submission.status === "pending" ? (
        <ReviewBox
          guildId={guildId}
          submissionId={submission.id}
          onDecided={(next) => {
            onDecided(next);
            setHistoryKey((k) => k + 1);
          }}
        />
      ) : (
        <p className="dim" style={{ marginTop: "1rem" }}>
          <Pill level={statusLevel(submission.status)}>{submission.outcomeLabel ?? submission.status}</Pill>
          {submission.status === "denied" && submission.reviewReason && (
            <span className="timeline-reason" style={{ display: "block", marginTop: ".5rem" }}>
              {submission.reviewReason}
            </span>
          )}
        </p>
      )}

      <h3 className="eyebrow sheet-heading" style={{ marginTop: "1.5rem" }}>History</h3>
      <SubmissionHistory key={historyKey} guildId={guildId} submission={submission} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Accept and Deny.
 *
 * Asks first what this person may do. The bot answers from their roles in
 * the server, with the same checks as the buttons in Discord, so a button
 * shown here is one that will work. It checks again when one is pressed,
 * since the page can be out of date.
 * ------------------------------------------------------------------ */

function ReviewBox({
  guildId,
  submissionId,
  onDecided,
}: {
  guildId: string;
  submissionId: string;
  onDecided: (status: "accepted" | "denied") => void;
}) {
  const [options, setOptions] = useState<ReviewOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [mode, setMode] = useState<null | "accept" | "deny">(null);
  const [acceptOutcome, setAcceptOutcome] = useState("");
  const [denyOutcome, setDenyOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .reviewOptions(guildId, submissionId)
      .then((o) => live && setOptions(o))
      .catch((err) => live && setLoadError(err instanceof ApiError ? err.message : String(err)));
    loadRoles(guildId)
      .then((r) => live && setRoles(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [guildId, submissionId]);

  const roleNames = (ids: string[]) =>
    ids.map((id) => `@${roles.find((r) => r.id === id)?.name ?? id}`).join(", ");

  async function decide(decision: "accept" | "deny") {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.decideSubmission(guildId, submissionId, {
        decision,
        outcomeId: (decision === "accept" ? acceptOutcome : denyOutcome) || undefined,
        reason: decision === "deny" ? reason : undefined,
      });
      setResult(r);
      if (r.ok) onDecided(decision === "accept" ? "accepted" : "denied");
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const box = (children: ReactNode) => (
    <section className="review-box" aria-label="Review">
      <h3 className="eyebrow sheet-heading">Review</h3>
      {children}
    </section>
  );

  if (result?.ok) return box(<p className="review-done">{stripMarkdown(result.message)}</p>);
  if (loadError) return box(<p className="dim">Couldn't check what you can do: {loadError}</p>);
  if (!options) return box(<p className="dim">Checking what you can do…</p>);
  if (!options.canReview) return box(<p className="dim">{stripMarkdown(options.reason)}</p>);

  const accepts = options.acceptOutcomes;
  const chosen: ReviewOutcomeOption | undefined = accepts?.find((o) => o.id === acceptOutcome);
  const canAccept = accepts === null || !!chosen;
  const gives = !canAccept
    ? null
    : chosen === undefined
    ? "Gives the roles this form grants on accept, and sends the acceptance DM."
    : chosen.grantRoleIds.length
    ? `Gives ${roleNames(chosen.grantRoleIds)}, and sends the acceptance DM.`
    : "Gives no roles, and sends the acceptance DM.";

  return box(
    <>
      {result && !result.ok && (
        <Banner level="act" title="That didn't go through">
          {stripMarkdown(result.message)}
        </Banner>
      )}

      {mode === null && (
        <div className="actions">
          {accepts !== null && accepts.length === 0 ? (
            <span className="dim">You can review this form but can't grant any of its outcomes.</span>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setMode("accept")}>
              Accept…
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={() => setMode("deny")}>
            Deny…
          </button>
        </div>
      )}

      {mode === "accept" && (
        <div>
          {accepts && (
            <fieldset className="outcome-pick">
              <legend className="dim">Accept as</legend>
              {accepts.map((o) => (
                <label key={o.id} className="row">
                  <input
                    type="radio"
                    name="accept-outcome"
                    value={o.id}
                    checked={acceptOutcome === o.id}
                    onChange={() => setAcceptOutcome(o.id)}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    {o.description && <span className="dim"> · {o.description}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {gives && <p className="dim" style={{ fontSize: 13 }}>{gives}</p>}
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canAccept || busy}
              onClick={() => decide("accept")}
            >
              {busy ? "Accepting…" : chosen ? `Accept as ${chosen.label}` : "Accept"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "deny" && (
        <div>
          {options.denyOutcomes.length > 0 && (
            <label className="field">
              <span className="eyebrow">Deny because</span>
              <select value={denyOutcome} onChange={(e) => setDenyOutcome(e.target.value)}>
                <option value="">No particular reason</option>
                {options.denyOutcomes.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="eyebrow">Reason, sent to the applicant</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional. Leave blank to send no reason."
            />
          </label>
          <div className="actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => decide("deny")}>
              {busy ? "Denying…" : "Deny application"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>,
  );
}

/** The bot's messages are written for Discord, where **bold** renders. */
function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

/* ------------------------------------------------------------------ *
 * The per-application timeline.
 *
 * Every state change is recorded server-side as its own row (see the bot's
 * submissionEvents service), so this is the full story, not just the current
 * status: who submitted it, who accepted or denied it and when, a withdrawal,
 * or the system auto-denying it because the applicant left.
 *
 * Names and avatars are resolved live rather than stored — the events carry
 * only Discord ids, and the API turns the distinct ones into `actors` at read
 * time. An id missing from that map (a deleted account, or Discord declining)
 * renders as the raw id, which is honest about what is knowable.
 * ------------------------------------------------------------------ */

const ACTION: Record<SubmissionEvent["action"], { verb: string; level: Parameters<typeof Pill>[0]["level"] }> = {
  created: { verb: "submitted the application", level: undefined },
  accepted: { verb: "accepted it", level: "ok" },
  denied: { verb: "denied it", level: "act" },
  auto_denied: { verb: "was auto-denied", level: "act" },
  withdrawn: { verb: "withdrew it", level: undefined },
};

type Actor = { username: string; avatarUrl: string };

function SubmissionHistory({ guildId, submission }: { guildId: string; submission: Submission }) {
  const [events, setEvents] = useState<SubmissionEvent[] | null>(null);
  const [actors, setActors] = useState<Record<string, Actor>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setError(null);
    api
      .submissionEvents(guildId, submission.id)
      .then((r) => {
        if (!live) return;
        setEvents(r.events);
        setActors(r.actors);
      })
      .catch((err) => {
        if (!live) return;
        setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [guildId, submission.id]);

  if (error) {
    return (
      <Banner level="act" title="Couldn't load history">
        {error}
      </Banner>
    );
  }
  if (events === null) return <Loading rows={3} />;
  if (events.length === 0) {
    return <Empty title="No history recorded" hint="Nothing has happened to this application yet." />;
  }
  return (
    <ol className="timeline">
      {events.map((e) => {
        const a = ACTION[e.action];
        const reason = typeof e.detail?.reason === "string" ? e.detail.reason : null;
        const outcomeLabel = typeof e.detail?.outcomeLabel === "string" ? e.detail.outcomeLabel : null;
        return (
          <li key={e.id} className="timeline-item">
            <Face id={e.actorId} actors={actors} />
            <div className="timeline-body">
              <div>
                <Actor id={e.actorId} actors={actors} /> {a.verb}
                {outcomeLabel && (
                  <>
                    {" "}
                    <Pill level={a.level}>{outcomeLabel}</Pill>
                  </>
                )}
              </div>
              {reason && <div className="timeline-reason">“{reason}”</div>}
              <time className="dim" style={{ fontSize: 11 }} dateTime={e.createdAt}>
                {formatRelative(e.createdAt)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The name of an actor — resolved username, "Appealy" for a system action
 *  (actorId null), "Deleted user" for an ID removed on request (0), or the
 *  raw id when Discord could not be asked. */
function Actor({ id, actors }: { id: string | null; actors: Record<string, Actor> }) {
  if (id === null) return <strong>Appealy</strong>;
  if (id === "0") return <strong>Deleted user</strong>;
  const a = actors[id];
  if (a) return <strong>{a.username}</strong>;
  return <strong className="mono">{id}</strong>;
}

/** The avatar for an actor. A real face when resolved; a neutral system badge
 *  for a system action; the default Discord silhouette otherwise. */
function Face({ id, actors }: { id: string | null; actors: Record<string, Actor> }) {
  if (id === null) {
    return (
      <span className="face face-system" aria-hidden>
        A
      </span>
    );
  }
  const a = actors[id];
  if (a) {
    return <img className="face" src={a.avatarUrl} alt="" width={32} height={32} loading="lazy" />;
  }
  // Unresolved: Discord's default silhouette, chosen by the modern (id >> 22) % 6
  // rule so it is at least a stable, valid image rather than a broken one.
  const variant = (BigInt(id) >> 22n) % 6n;
  return (
    <img
      className="face"
      src={`https://cdn.discordapp.com/embed/avatars/${variant}.png`}
      alt=""
      width={32}
      height={32}
      loading="lazy"
    />
  );
}
