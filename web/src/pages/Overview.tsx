// web/src/pages/Overview.tsx
//
// The landing view. Its single job: tell an operator whether anything needs
// their attention, and let them act on it without navigating away.
//
// Everything here comes from ONE request (`GET /overview`). That's not an
// optimisation detail, it's the reason this page can poll: nine parallel
// requests each paying their own permission check is what made the API's
// guildAccess middleware the bottleneck in the first place, and a page that
// refreshes every 15 seconds would have made it permanent.
//
// Ordering is by urgency, not by category. A raid lockdown is a banner
// above everything; capacity pressure comes before activity counts; the
// bot's own health sits below both, because a bot that's unhealthy usually
// announces itself through the numbers above it first.

import { useEffect, useState, useCallback } from "react";
import { api, ApiError, type Overview as OverviewData } from "../lib/api";
import {
  Panel,
  Stat,
  Pill,
  Banner,
  CapacityRail,
  Sparkline,
  Empty,
  Loading,
  levelFor,
  formatDuration,
  formatRelative,
} from "../components/ui";

const POLL_MS = 15_000;

export default function Overview({ guildId }: { guildId: string }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.overview(guildId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    // Polling stops when the tab is hidden. A console left open on a second
    // monitor overnight would otherwise burn ~5,700 requests against a
    // 60/min free-tier cap that the same user's real work also needs.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function clearLockdown() {
    setClearing(true);
    try {
      await api.clearLockdown(guildId);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setClearing(false);
    }
  }

  if (error?.isUnavailable) {
    return (
      <Banner level="watch" title="Can't confirm your permissions">
        Discord didn't respond, so we can't verify your access to this server right now. This
        usually clears in a few seconds — the page will keep retrying.
      </Banner>
    );
  }

  if (error) {
    return (
      <Banner level="act" title="Couldn't load this server">
        {error.message}
      </Banner>
    );
  }

  if (!data) {
    return (
      <Panel eyebrow="Loading" title="Reading server state">
        <Loading rows={5} />
      </Panel>
    );
  }

  const { capacity, activity, security, bot } = data;

  // Which caps are under pressure, computed once and reused by the banner
  // and the rail so they can't contradict each other.
  const pressured = (
    ["submissionsPerDay", "ticketsPerDay", "giveawayEntriesPerDay", "formsPerGuild", "panelsPerGuild"] as const
  )
    .map((key) => ({
      key,
      level: levelFor(capacity.used[key] ?? 0, capacity.caps[key]),
      used: capacity.used[key] ?? 0,
      limit: capacity.caps[key],
    }))
    .filter((c) => c.level !== "ok");

  const worst = pressured.find((c) => c.level === "act") ?? pressured[0];

  return (
    <>
      {security.lockdown.active && (
        <Banner
          level="act"
          title="Raid lockdown is active"
          action={
            <button className="btn btn-danger" onClick={clearLockdown} disabled={clearing}>
              {clearing ? "Clearing…" : "Clear lockdown"}
            </button>
          }
        >
          Triggered by {security.lockdown.triggeredByJoinCount} joins{" "}
          {formatRelative(security.lockdown.triggeredAt)}. New joins are being handled with{" "}
          <span className="mono">{security.antiRaidAction}</span>. Clears automatically{" "}
          {formatRelative(security.lockdown.expiresAt)}.
        </Banner>
      )}

      {worst && (
        <Banner
          level={worst.level === "act" ? "act" : "watch"}
          title={
            worst.level === "act"
              ? "You're about to hit a limit"
              : "One limit is filling up"
          }
        >
          {worst.used.toLocaleString()} of {worst.limit.toLocaleString()} used
          {worst.key.endsWith("PerDay")
            ? `, resetting in ${formatDuration(capacity.resetsInSeconds)}`
            : ""}
          . Raise it on the Plan page, or leave it — the bot will tell members the limit was
          reached rather than failing silently.
        </Banner>
      )}

      {!bot && (
        <Banner level="act" title="Can't reach the bot">
          The API is running but the bot's control server didn't answer. Panels and giveaways
          can't be published until it's back. Check the bot container's logs.
        </Banner>
      )}

      <div className="grid grid-4">
        <Stat
          label="Awaiting review"
          value={activity.pendingSubmissions}
          sub={activity.pendingSubmissions === 0 ? "Queue is clear" : "Applications in the queue"}
          alert={activity.pendingSubmissions > 25}
        />
        <Stat
          label="Applications 24h"
          value={activity.submissions24h}
          sub={`${capacity.used.submissionsPerDay ?? 0} counted against today's limit`}
        />
        <Stat label="Open tickets" value={activity.openTickets} sub="Currently unresolved" />
        <Stat
          label="Running giveaways"
          value={activity.runningGiveaways}
          sub="Accepting entries now"
        />
      </div>

      <div className="grid grid-2">
        <Panel
          eyebrow="Capacity"
          title="What you're using"
          action={<Pill level={worst ? worst.level : "ok"}>{data.guild?.tier ?? "free"} plan</Pill>}
        >
          <CapacityRail
            caps={capacity.caps}
            used={capacity.used}
            resetsInSeconds={capacity.resetsInSeconds}
          />
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Panel eyebrow="Volume" title="Applications, last 14 days">
            <Sparkline points={activity.submissionsByDay} />
            <div className="row wrap" style={{ marginTop: 13, gap: 7 }}>
              {Object.entries(activity.statusBreakdown7d).map(([status, n]) => (
                <span key={status} className="pill">
                  {status} <strong className="mono">{n}</strong>
                </span>
              ))}
              {Object.keys(activity.statusBreakdown7d).length === 0 && (
                <span className="dim" style={{ fontSize: 12 }}>
                  Nothing submitted in the last 7 days.
                </span>
              )}
            </div>
          </Panel>

          <Panel eyebrow="Runtime" title="Bot">
            {bot ? <BotHealthGrid bot={bot} /> : <Empty title="Bot unreachable" hint="No response from the control server." />}
          </Panel>
        </div>
      </div>

      <Panel
        eyebrow="Protection"
        title="Raid detection"
        action={
          <Pill
            level={security.lockdown.active ? "act" : security.antiRaidEnabled ? "ok" : undefined}
            live={security.lockdown.active}
          >
            {security.lockdown.active
              ? "Lockdown active"
              : security.antiRaidEnabled
                ? "Watching"
                : "Off"}
          </Pill>
        }
      >
        {security.antiRaidEnabled ? (
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>
            Triggers when{" "}
            <strong className="mono" style={{ color: "var(--text)" }}>
              {security.joinThreshold}
            </strong>{" "}
            members join within{" "}
            <strong className="mono" style={{ color: "var(--text)" }}>
              {security.windowSeconds}s
            </strong>
            , then applies <span className="mono">{security.antiRaidAction}</span> to joins that
            happen during the lockdown. Members who joined before it triggered are never
            touched.
          </p>
        ) : (
          <Empty
            title="Raid detection is off"
            hint="Turn it on to get alerted when a burst of members joins at once."
          />
        )}
      </Panel>

      <Panel eyebrow="Changes" title="Recent dashboard activity">
        {data.recentActivity.length === 0 ? (
          <Empty title="No changes yet" hint="Edits made here will be listed for accountability." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Resource</th>
                <th>By</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.recentActivity.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.action}</td>
                  <td className="dim">{e.resourceType}</td>
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

function BotHealthGrid({ bot }: { bot: NonNullable<OverviewData["bot"]> }) {
  const shards = bot.shards.shards;
  const worstRtt = shards.reduce((max, s) => Math.max(max, s.rttMs ?? 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row wrap">
        <Pill level={bot.status === "ok" ? "ok" : "watch"}>{bot.status}</Pill>
        <Pill level={bot.redis === "up" ? "ok" : "act"}>Redis {bot.redis}</Pill>
        <Pill>Up {formatDuration(bot.uptimeSeconds)}</Pill>
        <Pill>{bot.memoryMb} MB</Pill>
      </div>

      <div className="row spread" style={{ fontSize: 12 }}>
        <span className="dim">Guilds held in cache</span>
        <span className="mono">
          {bot.guildsCached.toLocaleString()}
          {bot.inFlightCacheLoads > 0 && (
            <span className="dim"> · {bot.inFlightCacheLoads} loading</span>
          )}
        </span>
      </div>

      {/* Shard state is the honest measure of whether the bot is connected.
          A process can be up, answering health checks, and completely
          detached from Discord — which looks fine everywhere except here. */}
      {shards.length > 0 ? (
        <div className="row spread" style={{ fontSize: 12 }}>
          <span className="dim">
            {shards.length} shard{shards.length === 1 ? "" : "s"}
          </span>
          <span className="mono">
            {worstRtt > 0 ? `${worstRtt}ms worst heartbeat` : "connected"}
          </span>
        </div>
      ) : (
        <span className="dim" style={{ fontSize: 12 }}>
          Shard details unavailable — the bot runs single-process via{" "}
          <span className="mono">bot.start()</span>. See SCALING.md before growing past ~2,000
          servers.
        </span>
      )}
    </div>
  );
}
