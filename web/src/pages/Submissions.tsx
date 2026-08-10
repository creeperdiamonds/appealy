// web/src/pages/Submissions.tsx
//
// The review queue. Filtered server-side rather than client-side: a guild
// on a paid retention tier can hold two years of submissions, and shipping
// all of them to the browser to filter four of them into view is the kind
// of thing that works fine in development and falls over on the one
// customer who actually uses the product hard.

import { useEffect, useState } from "react";
import { api, ApiError, type Submission, type FormSummary } from "../lib/api";
import { Panel, Pill, Empty, Loading, Banner, formatRelative, formatDuration, snowflakeDate } from "../components/ui";

const STATUSES = ["pending", "accepted", "denied", "withdrawn"] as const;

export default function Submissions({ guildId }: { guildId: string }) {
  const [status, setStatus] = useState<string>("pending");
  const [formId, setFormId] = useState<string>("");
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <table className="table">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Form</th>
                <th>Status</th>
                <th>Took</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="mono">{s.applicantId}</div>
                    {/* Account age from the snowflake. When a wave of
                        applications arrives from accounts created the same
                        week, that is the single most useful column here. */}
                    <div className="dim" style={{ fontSize: 11 }}>
                      account created {snowflakeDate(s.applicantId).toLocaleDateString()}
                    </div>
                  </td>
                  <td>{formName(s.formId)}</td>
                  <td>
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
                  <td className="mono dim">
                    {s.completionSeconds ? formatDuration(s.completionSeconds) : "—"}
                  </td>
                  <td className="dim">{formatRelative(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="dim" style={{ fontSize: 12, margin: 0 }}>
        Accept and deny happen in Discord, on the review embed posted to the form's log channel —
        that's where the buttons and the reviewer thread live. This view is for finding an
        application and seeing its history.
      </p>
    </>
  );
}
