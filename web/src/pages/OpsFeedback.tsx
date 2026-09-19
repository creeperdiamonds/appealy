// web/src/pages/OpsFeedback.tsx
//
// What people answered when the dashboard asked how Appealy is working out.
//
// Read-only, deliberately. There is nothing to click because there is nothing
// to decide: the value is in reading them, and a queue with Accept/Deny
// buttons would turn "someone told you what annoys them" into a chore with a
// zero state to chase.
//
// Not a security boundary. /api/ops/* returns 404 to anyone not in
// OPS_USER_IDS regardless of what this renders — same as OpsAppeals.
//
// Grouped by answer rather than by person on purpose. Three people saying the
// forms page confused them is one finding, and it only looks like one finding
// if their three sentences sit next to each other.

import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type OpsFeedback as Entry } from "../lib/api";
import { Panel, Banner, Loading, Empty, formatRelative } from "../components/ui";

/** The three questions, in the order the sheet asks them. */
const QUESTIONS: { key: "usedFor" | "annoyance" | "missing"; label: string }[] = [
  { key: "usedFor", label: "What they use it for" },
  { key: "annoyance", label: "Most annoying thing" },
  { key: "missing", label: "Expected and didn't find" },
];

export default function OpsFeedback() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.opsFeedback();
      setEntries(res.feedback);
    } catch (e) {
      // 404 means "not an operator", which is the intended answer for most
      // visitors — show nothing rather than implying something is broken.
      if (e instanceof ApiError && e.status === 404) setEntries([]);
      else setError(e instanceof ApiError ? e.message : "Couldn't load the answers.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !entries) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!entries) return <Loading rows={3} />;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Feedback</h1>
        <p className="dim">
          {entries.length === 0
            ? "Nothing yet."
            : `${entries.length} ${entries.length === 1 ? "answer" : "answers"}, newest first.`}
        </p>
      </header>

      {entries.length === 0 && (
        <Empty
          title="No answers yet"
          hint="The dashboard asks once per browser. Quiet here is normal early on — it is not evidence the form is broken."
        />
      )}

      {entries.map((f) => (
        <Panel key={f.id}>
          <div className="ops-appeal-head">
            <div>
              <strong>{f.guildName ?? `Server ${f.guildId}`}</strong>
              <span className="dim block">
                {formatRelative(f.createdAt)} · from {f.authorId}
              </span>
            </div>
          </div>

          <dl className="ban-facts">
            {QUESTIONS.filter((q) => f[q.key]).map((q) => (
              <div className="ban-fact" key={q.key}>
                <dt className="eyebrow">{q.label}</dt>
                <dd>
                  {/* Their words, not a summary of them. */}
                  <blockquote className="appeal-body">{f[q.key]}</blockquote>
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      ))}
    </div>
  );
}
