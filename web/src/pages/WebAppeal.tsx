// web/src/pages/WebAppeal.tsx
//
// The web appeal link: appealy.app/appeal/<server id>. Someone banned from a
// server opens it, signs in with Discord, and fills in that server's ban
// appeal form here. Servers paste the link into their ban message or rules
// (pages/AppealConfig.tsx shows it to them).
//
// Not part of the console: no sidebar, no server picker, nothing that assumes
// the visitor manages anything. main.tsx renders this instead of App for these
// paths, from the same bundle.
//
// Sign-in is a plain redirect that comes back here (?next= on
// api/src/routes/auth.ts), not the console's popup. People arrive from a
// Discord message on their phone, where popups open as tabs with nowhere to
// report back to.
//
// The API and the bot decide everything (api/src/routes/webAppeals.ts,
// bot/src/services/webAppeal.ts). The answer checks here are the same function
// the bot runs, so the page can say what's wrong before sending.

import { useEffect, useState } from "react";
import { Banner, Loading, Panel } from "../components/ui";
import { answerProblem } from "../../../shared/schema/answers";

interface Question {
  id: string;
  label: string;
  placeholder: string | null;
  type: "short_text" | "paragraph" | "select";
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  validationType: "none" | "regex";
  validationPattern: string | null;
  validationErrorMessage: string | null;
}

interface AppealPage {
  guild: { id: string; name: string; iconUrl: string | null };
  form: { name: string; description: string; questions: Question[] };
}

interface LatestAppeal {
  id: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

type Me =
  | { status: "signed_out" }
  | { status: "platform_banned" }
  | { status: "unavailable" }
  | { status: "cant_check" }
  | { status: "banned" | "not_banned"; latest: LatestAppeal | null };

type Load = { state: "loading" } | { state: "unavailable" } | { state: "error" } | { state: "ready"; page: AppealPage; me: Me };

async function getJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

export default function WebAppeal({ guildId }: { guildId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  async function refresh() {
    try {
      const page = await getJson(`/api/appeal/${guildId}`);
      if (page.status === 404) return setLoad({ state: "unavailable" });
      if (page.status !== 200) return setLoad({ state: "error" });
      const me = await getJson(`/api/appeal/${guildId}/me`);
      const meState: Me | null = me.status === 401
        ? { status: "signed_out" }
        : me.status === 403 && me.body?.error === "banned"
        ? { status: "platform_banned" }
        : me.status === 200
        ? me.body
        : null;
      // The bot unreachable mid-deploy, or too many reloads: try again later,
      // not a claim about the server's setup.
      if (!meState) return setLoad({ state: "error" });
      setLoad({ state: "ready", page: page.body, me: meState });
    } catch {
      setLoad({ state: "error" });
    }
  }

  useEffect(() => {
    document.title = "Appeal a ban · Appealy";
    void refresh();
  }, [guildId]);

  return (
    <main className="appeal-page">
      <a className="appeal-brand" href="/">Appealy</a>
      {load.state === "loading" && <Loading rows={4} />}
      {load.state === "unavailable" && (
        <Panel title="Appeals aren't open here">
          <p className="dim">
            This server doesn't take ban appeals through Appealy, or the link is wrong. Check the
            link with the server's staff.
          </p>
        </Panel>
      )}
      {load.state === "error" && (
        <Banner level="act" title="Couldn't load this page">
          Something went wrong on our side. Try again in a minute.
        </Banner>
      )}
      {load.state === "ready" && <AppealBody guildId={guildId} page={load.page} me={load.me} onChange={refresh} />}
    </main>
  );
}

function AppealBody({ guildId, page, me, onChange }: { guildId: string; page: AppealPage; me: Me; onChange: () => void }) {
  const { guild, form } = page;
  const header = (
    <header className="appeal-head">
      {guild.iconUrl
        ? <img className="appeal-icon" src={guild.iconUrl} alt="" width={48} height={48} />
        : <span className="appeal-icon appeal-icon-blank" aria-hidden="true">{guild.name.slice(0, 1)}</span>}
      <div>
        <span className="eyebrow">Ban appeal</span>
        <h1>{guild.name}</h1>
      </div>
    </header>
  );

  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    onChange();
  };
  const signedIn = me.status !== "signed_out";

  let body;
  if (me.status === "signed_out") {
    body = (
      <Panel>
        <p>
          Banned from <strong>{guild.name}</strong>? You can ask its staff to lift the ban here.
          Sign in with Discord so they know who's asking. Signing in shares your Discord profile and
          the list of servers you're in with Appealy, nothing else.
        </p>
        <a className="btn btn-primary appeal-signin" href={`/auth/discord/login?next=${encodeURIComponent(`/appeal/${guildId}`)}`}>
          Sign in with Discord
        </a>
      </Panel>
    );
  } else if (me.status === "platform_banned") {
    body = (
      <Banner level="act" title="Your account can't use Appealy">
        Your account is banned from Appealy, so it can't send appeals to any server.
      </Banner>
    );
  } else if (me.status === "unavailable") {
    body = (
      <Panel title="Appeals aren't open here">
        <p className="dim">This server stopped taking ban appeals through Appealy.</p>
      </Panel>
    );
  } else if (me.status === "cant_check") {
    body = (
      <Banner level="watch" title="Appealy can't check bans in this server">
        The server hasn't given Appealy permission to see its bans, so appeals can't be sent from
        here. Let its staff know.
      </Banner>
    );
  } else if (me.latest?.status === "pending") {
    body = (
      <Panel title="Your appeal is with the staff">
        <p className="dim">
          You sent it on {when(me.latest.createdAt)}. Staff will accept or deny it. Check back here
          to see the answer.
        </p>
      </Panel>
    );
  } else if (me.status === "not_banned") {
    body = me.latest?.status === "accepted"
      ? (
        <Panel title="Your appeal was accepted">
          <p className="dim">You're no longer banned from {guild.name}. You can join it again.</p>
        </Panel>
      )
      : (
        <Panel title="You aren't banned here">
          <p className="dim">
            Your account isn't banned from {guild.name}, so there's nothing to appeal. If you're on
            the wrong account, sign out and sign in with the banned one.
          </p>
        </Panel>
      );
  } else {
    body = (
      <>
        {me.latest?.status === "denied" && (
          <Banner level="watch" title="Your last appeal was denied">
            Staff denied the appeal you sent on {when(me.latest.createdAt)}. You can send another if
            this server allows it.
          </Banner>
        )}
        <AppealForm guildId={guildId} form={form} onSent={onChange} />
      </>
    );
  }

  return (
    <div className="stack">
      {header}
      {body}
      {signedIn && (
        <p className="dim appeal-foot">
          Wrong account? <button className="link-button" onClick={() => void signOut()}>Sign out</button>
        </p>
      )}
    </div>
  );
}

function AppealForm({ guildId, form, onSent }: { guildId: string; form: AppealPage["form"]; onSent: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [openedAt] = useState(() => Date.now());

  const problems = Object.fromEntries(
    form.questions.map((q) => [q.id, answerProblem(q, answers[q.id] ?? "")]).filter(([, p]) => p),
  ) as Record<string, string>;

  async function send() {
    setTouched(true);
    setError(null);
    if (Object.keys(problems).length) return;
    setSending(true);
    try {
      const res = await getJson(`/api/appeal/${guildId}`, {
        method: "POST",
        body: JSON.stringify({
          answers,
          completionSeconds: Math.min(86_400, Math.round((Date.now() - openedAt) / 1000)),
        }),
      });
      if (res.status === 201) return onSent();
      if (res.body?.status === "invalid") return setServerProblems(res.body.problems ?? {});
      if (res.status === 401 || res.body?.status === "not_banned" || res.body?.status === "unavailable") return onSent();
      setError(res.body?.message ?? "Your appeal couldn't be sent. Try again in a minute.");
    } catch {
      setError("Your appeal couldn't be sent. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel title={form.name}>
      {form.description.trim() && <p className="dim appeal-description">{form.description}</p>}
      {form.questions.map((q, i) => {
        const value = answers[q.id] ?? "";
        const problem = serverProblems[q.id] ?? (touched ? problems[q.id] : null);
        const set = (v: string) => {
          setAnswers((a) => ({ ...a, [q.id]: v }));
          setServerProblems((p) => {
            const { [q.id]: _, ...rest } = p;
            return rest;
          });
        };
        const id = `q-${q.id}`;
        return (
          <label className="field" key={q.id} htmlFor={id}>
            <span className="eyebrow">
              {i + 1}. {q.label}
              {!q.required && " (optional)"}
            </span>
            {q.type === "paragraph"
              ? (
                <textarea
                  id={id}
                  rows={5}
                  value={value}
                  maxLength={q.maxLength ?? 4000}
                  placeholder={q.placeholder ?? ""}
                  onChange={(e) => set(e.target.value)}
                />
              )
              : (
                <input
                  id={id}
                  value={value}
                  maxLength={q.maxLength ?? 4000}
                  placeholder={q.placeholder ?? ""}
                  onChange={(e) => set(e.target.value)}
                />
              )}
            {problem && <span className="appeal-problem">{problem}</span>}
          </label>
        );
      })}
      {error && (
        <Banner level="act" title="Not sent">
          {error}
        </Banner>
      )}
      <div className="actions">
        <button className="btn btn-primary" onClick={() => void send()} disabled={sending}>
          {sending ? "Sending…" : "Send appeal"}
        </button>
      </div>
    </Panel>
  );
}
