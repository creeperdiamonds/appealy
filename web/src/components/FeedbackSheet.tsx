// web/src/components/FeedbackSheet.tsx
//
// The three questions, asked where the person already is.
//
// This replaced a link to the Discord server. A link asks someone to leave the
// dashboard, join a server, find a channel and write a post, which is four
// steps to say "the forms page confused me" — and almost nobody spends them.
//
// Every field is optional on purpose. One sentence in one box is the most
// common useful answer, and demanding all three turns a small favour into a
// form to abandon. The submit button is disabled only when all three are
// empty, because that is a misclick rather than an opinion.

import { useState } from "react";

import { http } from "../lib/api";
import { Sheet } from "./ui";

interface FeedbackSheetProps {
  guildId: string;
  onClose: () => void;
  /** Called once an answer is stored, so the caller can stop asking. */
  onSent: () => void;
}

export default function FeedbackSheet({ guildId, onClose, onSent }: FeedbackSheetProps) {
  const [usedFor, setUsedFor] = useState("");
  const [annoyance, setAnnoyance] = useState("");
  const [missing, setMissing] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const empty = !usedFor.trim() && !annoyance.trim() && !missing.trim();

  async function send() {
    setSending(true);
    setError(null);
    try {
      await http.post(`/api/guilds/${guildId}/feedback`, {
        usedFor: usedFor.trim() || undefined,
        annoyance: annoyance.trim() || undefined,
        missing: missing.trim() || undefined,
      });
      setSent(true);
      onSent();
    } catch (e) {
      // Kept open with the text intact. Losing what someone just wrote because
      // the network blinked is how you make sure they never write again.
      setError(e instanceof Error ? e.message : "Couldn't send that. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Sheet title="Thank you" onClose={onClose}>
        <p className="dim">
          That goes straight to the person who builds this, and it is read. If you left something
          that needs a reply, the Discord server is the quickest way to get one.
        </p>
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title="How is Appealy working out?" onClose={onClose}>
      <p className="dim">
        Answer whichever of these you have an opinion about — one is plenty. It goes to the person
        who builds this, and it decides what gets built next.
      </p>

      <label className="field">
        <span>What do you use Appealy for?</span>
        <textarea
          rows={2}
          value={usedFor}
          onChange={(e) => setUsedFor(e.target.value)}
          maxLength={2000}
          placeholder="Applications, ban appeals, tickets, giveaways…"
        />
      </label>

      <label className="field">
        <span>What is the most annoying thing about it right now?</span>
        <textarea
          rows={3}
          value={annoyance}
          onChange={(e) => setAnnoyance(e.target.value)}
          maxLength={2000}
          placeholder="The thing you sighed at most recently."
        />
      </label>

      <label className="field">
        <span>What did you expect to find and didn&rsquo;t?</span>
        <textarea
          rows={2}
          value={missing}
          onChange={(e) => setMissing(e.target.value)}
          maxLength={2000}
          placeholder="Something you went looking for and gave up on."
        />
      </label>

      {error && <p className="dim">{error}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" onClick={send} disabled={sending || empty}>
          {sending ? "Sending…" : "Send"}
        </button>
        <button className="btn" onClick={onClose} disabled={sending}>
          Not now
        </button>
      </div>
    </Sheet>
  );
}
