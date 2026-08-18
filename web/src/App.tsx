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
import { api, ApiError, http, type GuildSummary } from "./lib/api";
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

/**
 * What the server says about itself.
 *
 * The console was written for the hosted platform and assumed it: billing
 * screens, tier ladders, an ops surface. A self-hosted instance has no account
 * behind any of that, and rendering it anyway is the same class of mistake as
 * showing a console for a server the bot was never invited to — a UI asserting
 * something untrue about the world it is running in.
 */
interface DeploymentConfig {
  mode: "platform" | "self" | "test";
  brandName: string;
  supportUrl: string;
  features: {
    billing: boolean;
    tieredRateLimits: boolean;
    bans: boolean;
    publicStatus: boolean;
  };
}

export default function App() {
  // Set by any API call that throws BannedError. Not a route — see the
  // comment on BannedError in lib/api.ts.
  const [platformBan, setPlatformBan] = useState<
    import("../../shared/types").PublicBan | null
  >(null);

  // Whether to show the Operator nav group. Cosmetic only — every /api/ops
  // route enforces requireOpsUser independently and 404s for everyone else,
  // so a wrong value here reveals nothing.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    api.opsAppeals().then(() => setIsOperator(true)).catch(() => setIsOperator(false));
  }, []);

  // Null until it arrives. Nothing that depends on the mode renders before
  // then, because guessing and correcting is worse than waiting a moment —
  // a billing tab that appears and vanishes reads as a bug.
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  useEffect(() => {
    http
      .get<DeploymentConfig>("/api/config")
      .then(setConfig)
      // A failure here is not fatal: an older server without this endpoint
      // still runs, and the console falls back to showing everything, which
      // is what it did before this existed.
      .catch(() => setConfig(null));
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
        // Prefer a server the bot is actually in. Opening on one it has never
        // joined means the first thing anyone sees is a wall telling them to
        // invite it, even when they have three working servers underneath.
        const remembered = localStorage.getItem(LAST_GUILD_KEY);
        const initial =
          (remembered && guilds.find((g) => g.id === remembered)?.id) ??
          guilds.find((g) => g.installed)?.id ??
          guilds[0]?.id ??
          null;
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

  if (platformBan) return <Banned ban={platformBan} />;


  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          {/* From the server. A self-hosted instance is not "Appealy" — it is
              whoever runs it, and BRAND_NAME is how they say so. Falls back
              only until the config arrives. */}
          <span className="brand-name">{config?.brandName ?? "Appealy"}</span>
          <span className="brand-tag">
            {config?.mode === "test" ? "test console" : "console"}
          </span>
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
                    {/* An <option> renders text and nothing else — no element
                        inside it survives, so the state has to be in the label.
                        The coloured tag next to the select carries it for the
                        selected server. */}
                    {g.installed ? g.name : `\u26A0 ${g.name} — UNINVITED`}
                  </option>
                ))}
              </select>
              {active && !active.installed && <Pill level="act">UNINVITED</Pill>}
              {active && active.installed && (
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
          {/* Persistent, not dismissible. The whole hazard of test mode is
              someone forgetting which deployment they are looking at and
              believing a real customer is being served by it. */}
          {config?.mode === "test" && (
            <Banner level="watch" title="Test deployment">
              Everything here behaves as production except billing, which is off — no payment
              can be taken and no plan can be bought. Do not point real users at this.
            </Banner>
          )}

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

          {/* Replaces the views rather than sitting above them. Showing an
              empty Overview next to this would be the same false claim in a
              smaller font: every request it made would fail, and the zeroes it
              rendered would read as "no applications yet" rather than "the bot
              is not here". */}
          {active && !active.installed ? (
            <Banner
              level="act"
              title={`Appealy isn't in ${active.name}`}
              action={
                <a className="btn" href={active.inviteUrl} target="_blank" rel="noreferrer">
                  Invite Appealy
                </a>
              }
            >
              You can manage this server, but the bot hasn't been added to it — so there is
              nothing here to configure yet. Inviting it opens Discord with this server already
              selected. Anything you configured before is kept and comes back with it.
            </Banner>
          ) : (
            <>
              {guildId && view === "overview" && <Overview guildId={guildId} />}
              {guildId && view === "submissions" && <Submissions guildId={guildId} />}
              {guildId && view === "operations" && <Operations guildId={guildId} />}
              {guildId && view === "appeals" && <AppealConfig guildId={guildId} />}
            </>
          )}
          {view === "ops-appeals" && <OpsAppeals />}
        </main>
      </div>
    </div>
  );
}
