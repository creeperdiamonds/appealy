// web/src/components/DedicatedBotPanel.tsx
//
// Where the owner of a server on dedicated hosting supplies their bot token.
//
// Only rendered when hosting is already active — the API refuses a token
// otherwise, and offering a field that will be rejected is a worse experience
// than not offering it.
//
// The token is WRITE-ONLY end to end. No route returns it, so this shows
// whether one is set and never what it is. That is why there is no "current
// value" here to edit: replacing it means typing a new one, which matches how
// Discord itself treats the token.

import { useCallback, useEffect, useState } from "react";
import { Panel, Pill } from "./ui";
import { http, ApiError } from "../lib/api";

type Status = "stopped" | "starting" | "running" | "failed";

interface State {
  hostingMode: "shared" | "custom";
  tokenSet: boolean;
  status: Status;
  error: string | null;
  lastSeenAt: string | null;
}

/** Maps runner state to something a person can act on. */
const EXPLAIN: Record<Status, string> = {
  stopped:
    "Not running. If you have just saved a token it will connect within a minute — this page does not refresh on its own.",
  starting: "Claimed by a host and connecting to Discord.",
  running: "Connected and handling events for your server.",
  failed: "Could not start. The reason is below.",
};

const LEVEL: Record<Status, "ok" | "watch" | "act" | undefined> = {
  stopped: undefined,
  starting: "watch",
  running: "ok",
  failed: "act",
};

export function DedicatedBotPanel({ guildId }: { guildId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    http
      .get<State>(`/api/guilds/${guildId}/dedicated-bot`)
      .then(setState)
      // A failure here is not worth a banner: the panel simply does not render,
      // and the billing page around it still works.
      .catch(() => setState(null));
  }, [guildId]);

  useEffect(load, [load]);

  if (!state || state.hostingMode !== "custom") return null;

  async function save() {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await http.put(`/api/guilds/${guildId}/dedicated-bot`, { token: token.trim() });
      // Cleared immediately. Leaving a token sitting in a form field is how it
      // ends up in a screenshot or a shared screen.
      setToken("");
      setSaved(true);
      load();
    } catch (err) {
      // ApiError already turns the server's payload into a readable sentence —
      // the routes here return a plain `message`, so reaching into `detail`
      // (which is shaped for zod field errors) would find nothing useful.
      setProblem(
        err instanceof ApiError ? err.message : "Could not save that. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setProblem(null);
    try {
      await http.del(`/api/guilds/${guildId}/dedicated-bot`);
      setSaved(false);
      load();
    } catch {
      setProblem("Could not remove the token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Your dedicated bot"
      action={<Pill level={LEVEL[state.status]}>{state.status}</Pill>}
    >
      <p className="dim">{EXPLAIN[state.status]}</p>

      {state.status === "failed" && state.error && (
        <div className="banner is-act" role="alert">
          <div className="banner-body">
            <div className="dim">{state.error}</div>
          </div>
        </div>
      )}

      {state.lastSeenAt && state.status === "running" && (
        <p className="dim">Last heartbeat {new Date(state.lastSeenAt).toLocaleTimeString()}.</p>
      )}

      <label className="field">
        <span>{state.tokenSet ? "Replace bot token" : "Bot token"}</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={state.tokenSet ? "A token is saved — type a new one to replace it" : "Paste your bot token"}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="dim">
          From the Discord Developer Portal, your application → <strong>Bot</strong> →{" "}
          <strong>Token</strong>. Not the Client Secret, which is a different value on a
          different page and the usual mistake. We store it encrypted and never show it
          again — Discord will not show it twice either, so keep your own copy.
        </span>
      </label>

      {problem && (
        <div className="banner is-act" role="alert">
          <div className="banner-body">
            <div className="dim">{problem}</div>
          </div>
        </div>
      )}
      {saved && <p className="dim">Saved. Your bot should connect within a minute.</p>}

      <div className="btn-row">
        <button className="btn-primary" disabled={busy || token.trim().length === 0} onClick={save}>
          {busy ? "Saving…" : state.tokenSet ? "Replace token" : "Save token"}
        </button>
        {state.tokenSet && (
          <button className="btn" disabled={busy} onClick={clear}>
            Remove token
          </button>
        )}
        <button className="btn" disabled={busy} onClick={load}>
          Refresh status
        </button>
      </div>

      <p className="dim">
        Removing the token stops your dedicated bot. Your forms, submissions and settings are
        untouched — the shared bot takes over again, and nothing is deleted.
      </p>
    </Panel>
  );
}
