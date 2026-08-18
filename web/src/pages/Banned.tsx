// web/src/pages/Banned.tsx
//
// Rendered in place of the whole console when the API answers 403 with
// { error: "banned" }. Not a route — App swaps to it on that response, so
// there is no URL a banned account can be bounced between.
//
// Tone
// ----
// This is a status page, not a punishment. It says what happened, when,
// whether it ends, and what to do next, in that order. No scolding, no
// apologising, no "violation of our Terms of Service" — that phrase tells
// someone nothing and is the reason most ban appeals arrive empty.
//
// What it deliberately does not say: which rule fired, what the detection
// threshold was, or who reviewed it. Those live in bans.notes and stay there.

import { useState } from "react";
import { Panel } from "../components/ui";
import { api } from "../lib/api";
import type { PublicBan } from "../../../shared/types";

const MIN = 40;
const MAX = 2000;

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function AppealForm({
  ban,
  subject,
  onSubmitted,
}: {
  ban: PublicBan;
  subject: "user" | "guild";
  onSubmitted?: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(!!ban.openAppeal);

  const len = body.trim().length;

  if (sent) {
    return (
      <div className="appeal-sent">
        <div className="appeal-sent-title">Appeal under review</div>
        <p className="dim">
          Submitted {formatDay(ban.openAppeal?.createdAt ?? new Date().toISOString())}. Most are
          decided within a few days. The outcome shows up here — there's nothing else to do.
        </p>
      </div>
    );
  }

  async function submit() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/appeals", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banId: ban.id, body: body.trim() }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(payload.message ?? "That didn't send. Try again in a moment.");
        return;
      }
      setSent(true);
      onSubmitted?.();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="appeal-form">
      <label className="eyebrow" htmlFor="appeal-body">
        Your appeal
      </label>
      <textarea
        id="appeal-body"
        rows={6}
        value={body}
        onChange={(e) => {
          setBody(e.target.value.slice(0, MAX));
          setError(null);
        }}
        placeholder={
          subject === "guild"
            ? "What was happening in the server around this time, and what has changed since?"
            : "What were you doing when this happened, and why do you think the decision was wrong?"
        }
        aria-describedby="appeal-count"
      />

      <div className="appeal-meta">
        <span id="appeal-count" className={len > 0 && len < MIN ? "is-watch" : "dim"}>
          {len < MIN ? `${MIN - len} more characters` : `${len}/${MAX}`}
        </span>
        <span className="dim">one appeal at a time</span>
      </div>

      {error && (
        <div className="banner is-act" role="alert">
          <div className="banner-body">
            <div className="dim">{error}</div>
          </div>
        </div>
      )}

      <button className="btn-primary" disabled={len < MIN || sending} onClick={submit}>
        {sending ? "Sending…" : "Send appeal"}
      </button>

      <p className="dim appeal-rules">
        Appeals are read by a person, not a filter. There's a wait between attempts so the
        queue stays readable — but a ban is never closed off permanently, and you can always
        appeal again later if something changes.
      </p>
    </div>
  );
}

// `username` is optional because the console genuinely may not know it:
// GET /auth/me returns only a user id, and nothing else fetches the Discord
// profile. App.tsx referenced an undefined `user` binding here, so this file
// never compiled — rather than invent a lookup, the line is omitted when there
// is no name to show.
export default function Banned({ ban, username }: { ban: PublicBan; username?: string }) {
  return (
    <div className="banned-shell">
      <div className="banned-inner">
        <div className="banned-head">
          {username && <span className="dim">{username}</span>}
          {/* A button, not a link. This pointed at /api/auth/logout, which is
              not a route — logout is POST /auth/logout — so the one control on
              the one screen a banned user can reach did nothing but 404. They
              had no way to sign out of an account they had just been told they
              cannot use. */}
          <button
            type="button"
            className="dim btn btn-sm"
            onClick={() => api.logout().then(() => window.location.reload())}
          >
            Sign out
          </button>
        </div>

        <span className="ban-tag">Account banned</span>
        <h1 className="banned-title">You can't use Appealy</h1>

        <Panel>
          <dl className="ban-facts">
            {(
              [
                ["Reason", ban.reasonPublic],
                ["Banned on", formatDay(ban.createdAt)],
                ["Ends", ban.expiresAt ? formatDay(ban.expiresAt) : "Does not expire"],
                ["Decided by", ban.automated ? "Automated system" : "Moderator review"],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="ban-fact">
                <dt className="eyebrow">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <p className="banned-lede">
          If you think this is wrong, tell us what happened. Be specific — what you were doing,
          which server, roughly when. A person reads this, and{" "}
          {ban.automated
            ? "this ban was issued automatically, so nobody has looked at your side of it yet."
            : "they can lift the ban."}
        </p>

        <Panel>
          <AppealForm ban={ban} subject="user" />
        </Panel>

        <div className="dim ban-ref">ref {ban.id.slice(0, 8)}</div>
      </div>
    </div>
  );
}
