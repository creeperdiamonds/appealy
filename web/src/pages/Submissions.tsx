// web/src/pages/Submissions.tsx
//
// The review queue. Filtered server-side rather than client-side: a guild
// on a paid retention tier can hold two years of submissions, and shipping
// all of them to the browser to filter four of them into view is the kind
// of thing that works fine in development and falls over on the one
// customer who actually uses the product hard.

import { useEffect, useState } from "react";
import {
  api,
  ApiError,
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

const STATUSES = ["pending", "accepted", "denied", "withdrawn"] as const;

export default function Submissions({ guildId }: { guildId: string }) {
  const [status, setStatus] = useState<string>("pending");
  const [formId, setFormId] = useState<string>("");
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The application whose history is open in the sheet. Null = nothing open.
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
                  <th aria-label="History" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  // The whole row opens the history — there is one action per
                  // row and it is the reason this page exists, so the row is
                  // the target rather than a button hidden in one cell.
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
                    aria-label={`History for application ${s.id.slice(0, 8)}`}
                  >
                    <td data-cell="head">
                      <div className="mono">{s.applicantId}</div>
                      {/* Account age from the snowflake. When a wave of
                          applications arrives from accounts created the same
                          week, that is the single most useful column here. */}
                      <div className="dim" style={{ fontSize: 11 }}>
                        account created {snowflakeDate(s.applicantId).toLocaleDateString()}
                      </div>
                    </td>
                    <td data-label="Form">{formName(s.formId)}</td>
                    <td data-label="Status">
                      <Pill
                        level={
                          s.status === "accepted"
                            ? "ok"
                            : s.status === "denied"
                              ? "act"
                              : s.status === "pending"
                                ? "watch"
                                : undefined
                        }
                      >
                        {s.status}
                      </Pill>
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
                      History ›
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="dim" style={{ fontSize: 12, margin: 0 }}>
        Accept and deny happen in Discord, on the review embed posted to the form's log channel —
        that's where the buttons and the reviewer thread live. This view is for finding an
        application and seeing its history.
      </p>

      {open && (
        <Sheet title="Application history" onClose={() => setOpen(null)}>
          <SubmissionHistory guildId={guildId} submission={open} formName={formName(open.formId)} />
        </Sheet>
      )}
    </>
  );
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

function SubmissionHistory({
  guildId,
  submission,
  formName,
}: {
  guildId: string;
  submission: Submission;
  formName: string;
}) {
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

  return (
    <div>
      {/* Who it happened to. The applicant is the actor of the `created`
          event, so they are already in the resolved map without a second
          lookup. */}
      <div className="hist-subject">
        <Face id={submission.applicantId} actors={actors} />
        <div>
          <div className="dim" style={{ fontSize: 12 }}>
            {formName} · application {submission.id.slice(0, 8)}
          </div>
        </div>
      </div>

      {error ? (
        <Banner level="act" title="Couldn't load history">
          {error}
        </Banner>
      ) : events === null ? (
        <Loading rows={3} />
      ) : events.length === 0 ? (
        <Empty title="No history recorded" hint="Nothing has happened to this application yet." />
      ) : (
        <ol className="timeline">
          {events.map((e) => {
            const a = ACTION[e.action];
            const reason = typeof e.detail?.reason === "string" ? e.detail.reason : null;
            const outcomeLabel =
              typeof e.detail?.outcomeLabel === "string" ? e.detail.outcomeLabel : null;
            return (
              <li key={e.id} className="timeline-item">
                <Face id={e.actorId} actors={actors} />
                <div className="timeline-body">
                  <div>
                    <Actor id={e.actorId} actors={actors} /> {a.verb}
                    {outcomeLabel && (
                      <>
                        {" "}
                        <Pill level="ok">{outcomeLabel}</Pill>
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
      )}
    </div>
  );
}

/** The name of an actor — resolved username, "Appealy" for a system action
 *  (actorId null), or the raw id when Discord could not be asked. */
function Actor({ id, actors }: { id: string | null; actors: Record<string, Actor> }) {
  if (id === null) return <strong>Appealy</strong>;
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
