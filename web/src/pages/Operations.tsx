// web/src/pages/Operations.tsx
//
// Queued work and the audit trail.
//
// The scheduled-jobs table on this page is only possible because delayed
// work moved out of `setTimeout` and into a durable table. Before that
// change there was nothing to show: pending auto-kicks lived in the bot's
// heap, invisible to staff, uncancellable, and silently discarded on every
// deploy. A member could be kicked forty minutes after joining with no
// record anywhere of why, or not kicked at all because someone shipped a
// release — and both outcomes looked identical from outside.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ScheduledJob, type AuditEntry } from "../lib/api";
import { Panel, Pill, Empty, Loading, Banner, formatRelative } from "../components/ui";

const JOB_LABELS: Record<string, string> = {
  kick_unverified: "Remove member who hasn't verified",
  close_poll: "Close poll",
  end_giveaway: "End giveaway",
  purge_expired_history: "Delete history past retention",
};

export default function Operations({ guildId }: { guildId: string }) {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const r = await api.scheduledJobs(guildId);
      setJobs(r.jobs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [guildId]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    setAudit(null);
    api
      .audit(guildId, 50, offset)
      .then((r) => {
        setAudit(r.entries);
        setTotal(r.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [guildId, offset]);

  async function cancel(jobId: string) {
    setCancelling(jobId);
    try {
      await api.cancelJob(guildId, jobId);
      await loadJobs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCancelling(null);
    }
  }

  return (
    <>
      {error && (
        <Banner level="act" title="Something didn't load">
          {error}
        </Banner>
      )}

      <Panel
        eyebrow="Queue"
        title="Scheduled work"
        action={
          jobs && jobs.length > 0 ? (
            <Pill level={jobs.some((j) => j.attempts > 1) ? "watch" : "ok"}>
              {jobs.length} queued
            </Pill>
          ) : undefined
        }
      >
        {jobs === null ? (
          <Loading rows={3} />
        ) : jobs.length === 0 ? (
          <Empty
            title="Nothing queued"
            hint="Delayed actions — verification kicks, scheduled closes — will appear here before they run."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>Runs</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{JOB_LABELS[j.kind] ?? j.kind}</td>
                  <td className="mono dim">{j.subjectId ?? "—"}</td>
                  <td className="dim">{formatRelative(j.runAt)}</td>
                  <td>
                    {j.lastError ? (
                      <Pill level="act">failed ×{j.attempts}</Pill>
                    ) : j.claimed ? (
                      <Pill level="watch">running</Pill>
                    ) : (
                      <Pill>waiting</Pill>
                    )}
                    {j.lastError && (
                      <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>
                        {j.lastError.slice(0, 90)}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => cancel(j.id)}
                      disabled={cancelling === j.id}
                    >
                      {cancelling === j.id ? "Cancelling…" : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        eyebrow="Accountability"
        title="Audit log"
        action={
          total > 0 ? (
            <div className="row">
              <button
                className="btn btn-sm"
                onClick={() => setOffset(Math.max(0, offset - 50))}
                disabled={offset === 0}
              >
                Newer
              </button>
              <span className="dim mono" style={{ fontSize: 12 }}>
                {offset + 1}–{Math.min(offset + 50, total)} of {total}
              </span>
              <button
                className="btn btn-sm"
                onClick={() => setOffset(offset + 50)}
                disabled={offset + 50 >= total}
              >
                Older
              </button>
            </div>
          ) : undefined
        }
      >
        {audit === null ? (
          <Loading rows={8} />
        ) : audit.length === 0 ? (
          <Empty
            title="No changes recorded"
            hint="Every edit made from this dashboard is logged here with who made it."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Resource</th>
                <th>Changed by</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.action}</td>
                  <td>
                    <span className="dim">{e.resourceType}</span>
                    {e.resourceId && (
                      <span className="mono dim" style={{ fontSize: 11 }}>
                        {" "}
                        {e.resourceId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="mono dim">{e.userId}</td>
                  <td className="dim">{formatRelative(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
