// web/src/App.tsx
//
// Shell: guild switcher, navigation, page routing.
//
// Routing is a `useState` and a hash, not a router library. The console has
// four views and no nested or parameterised routes; adding react-router
// would be ~15KB and a set of concepts to carry for something a switch
// statement does exactly as well. The hash means a view survives a refresh
// and can be linked to, which is the only part of routing this actually
// needed.

import Banned from "./pages/Banned";
import AppealConfig from "./pages/AppealConfig";
import OpsAppeals from "./pages/OpsAppeals";
import { BannedError } from "./lib/api";
import { useEffect, useState } from "react";
import { api, ApiError, type GuildSummary } from "./lib/api";
import { Banner, Pill } from "./components/ui";
import Overview from "./pages/Overview";
import Submissions from "./pages/Submissions";
import Operations from "./pages/Operations";

type View = "overview" | "submissions" | "operations" | "appeals" | "ops-appeals";

const NAV: { id: View; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "Capacity, activity, and health" },
  { id: "submissions", label: "Applications", hint: "The review queue" },
  { id: "operations", label: "Operations", hint: "Queued work and audit log" },
  { id: "appeals", label: "Ban appeals", hint: "DM banned members a form" },
];

const LAST_GUILD_KEY = "appealy:lastGuild";

export default function App() {
  // Set by any API call that throws BannedError. Not a route — see the
  // comment on BannedError in lib/api.ts.
  const [platformBan, setPlatformBan] = useState<
    import("../../shared/schema/platformBans").PublicBan | null
  >(null);

  // Whether to show the Operator nav group. Cosmetic only — every /api/ops
  // route enforces requireOpsUser independently and 404s for everyone else,
  // so a wrong value here reveals nothing.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    api.opsAppeals().then(() => setIsOperator(true)).catch(() => setIsOperator(false));
  }, []);

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof BannedError) {
        setPlatformBan(e.reason.ban);
        e.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  const [guilds, setGuilds] = useState<GuildSummary[] | null>(null);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [discordReachable, setDiscordReachable] = useState(true);
  const [view, setView] = useState<View>(
    (window.location.hash.slice(1) as View) || "overview",
  );
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    api
      .myGuilds()
      .then(({ guilds, discordReachable }) => {
        setGuilds(guilds);
        setDiscordReachable(discordReachable);

        // Prefer the last server this browser was looking at. Someone who
        // manages twelve servers should not have to re-find theirs every
        // time they open the console.
        const remembered = localStorage.getItem(LAST_GUILD_KEY);
        const initial =
          (remembered && guilds.find((g) => g.id === remembered)?.id) ?? guilds[0]?.id ?? null;
        setGuildId(initial);
      })
      .catch((err) => {
        // 401 already redirects to login inside the client, so anything
        // reaching here is a real failure worth showing.
        if (err instanceof ApiError && err.status !== 401) setFatal(err.message);
      });
  }, []);

  useEffect(() => {
    window.location.hash = view;
  }, [view]);

  useEffect(() => {
    if (guildId) localStorage.setItem(LAST_GUILD_KEY, guildId);
  }, [guildId]);

  const active = guilds?.find((g) => g.id === guildId) ?? null;

  // Full takeover. A user-level ban means there is no dashboard to show, so

  // this replaces the shell entirely rather than rendering a disabled version

  // of it. Guild bans do NOT come through here — those decorate the server

  // list instead, via ServerBanned.tsx.

  if (platformBan) return <Banned ban={platformBan} username={user?.username ?? ""} />;


  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-name">Appealy</span>
          <span className="brand-tag">console</span>
        </div>

        <nav className="nav" aria-label="Sections">
          <div className="nav-group eyebrow">Server</div>
          {NAV.map((item) => (
            <button
              key={item.id}
              className="nav-item"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
              title={item.hint}
            >
              {item.label}
            </button>
          ))}
          {isOperator && (
            <>
              <div className="nav-group eyebrow">Operator</div>
              <button
                className="nav-item"
                aria-current={view === "ops-appeals" ? "page" : undefined}
                onClick={() => setView("ops-appeals")}
              >
                Appeal queue
              </button>
            </>
          )}
        </nav>

        <div style={{ marginTop: "auto", padding: "0 8px" }}>
          <button
            className="nav-item"
            onClick={() => api.logout().then(() => window.location.reload())}
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {guilds && guilds.length > 0 ? (
            <>
              <select
                className="input"
                value={guildId ?? ""}
                onChange={(e) => setGuildId(e.target.value)}
                aria-label="Choose a server"
                style={{ maxWidth: 280 }}
              >
                {guilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              {active && (
                <Pill level={active.access === "manager" ? "watch" : undefined}>
                  {active.access}
                </Pill>
              )}
            </>
          ) : (
            <span className="dim">Loading servers…</span>
          )}

          <span style={{ marginLeft: "auto" }} className="eyebrow">
            {NAV.find((n) => n.id === view)?.hint}
          </span>
        </header>

        <main className="content">
          {fatal && (
            <Banner level="act" title="Couldn't start">
              {fatal}
            </Banner>
          )}

          {/* Said plainly rather than silently showing a short list — a
              user who owns eight servers and sees three would otherwise
              assume they'd lost access to five of them. */}
          {!discordReachable && (
            <Banner level="watch" title="Server list may be incomplete">
              Discord didn't respond, so this list only includes servers where you have a
              delegated role. Refresh in a moment to see the full list.
            </Banner>
          )}

          {guilds?.length === 0 && (
            <Banner level="watch" title="No servers yet">
              Appealy isn't in any server you can manage. Invite the bot to a server where you
              have Manage Server, then come back.
            </Banner>
          )}

          {guildId && view === "overview" && <Overview guildId={guildId} />}
          {guildId && view === "submissions" && <Submissions guildId={guildId} />}
          {guildId && view === "operations" && <Operations guildId={guildId} />}
          {guildId && view === "appeals" && <AppealConfig guildId={guildId} />}
          {view === "ops-appeals" && <OpsAppeals />}
        </main>
      </div>
    </div>
  );
}
