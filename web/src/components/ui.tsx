// web/src/components/ui.tsx
//
// Shared primitives. Small enough to live in one file; splitting them into
// eleven modules would add navigation cost without adding clarity.

import type { ReactNode } from "react";
import type { RateLimitCaps } from "../lib/api";

/* ------------------------------------------------------------------ *
 * Thresholds
 *
 * One definition, used by every capacity display, so a bar and a pill and
 * a banner describing the same number can never disagree about whether
 * it's a problem. 75% is "watch" because a daily cap crossed at noon will
 * be exhausted by evening; 90% is "act" because that's roughly where a
 * busy hour finishes the job.
 * ------------------------------------------------------------------ */
export const WATCH_AT = 0.75;
export const ACT_AT = 0.9;

export type Level = "ok" | "watch" | "act";

export function levelFor(used: number, limit: number): Level {
  if (limit <= 0) return "ok";
  const ratio = used / limit;
  if (ratio >= ACT_AT) return "act";
  if (ratio >= WATCH_AT) return "watch";
  return "ok";
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="panel-head">
          <div className="panel-title">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2>{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  alert = false,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div className={`stat${alert ? " is-act" : ""}`}>
      <span className="eyebrow">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function Pill({
  children,
  level,
  live = false,
}: {
  children: ReactNode;
  level?: Level;
  live?: boolean;
}) {
  return (
    <span className={`pill${level ? ` is-${level}` : ""}${live ? " is-live" : ""}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * CapacityRail — the signature element of this console.
 *
 * Eight bars, one per cap in shared/schema/pricing.ts, each filled against
 * this guild's own resolved limit rather than a preset. It answers the
 * question the whole billing model is built around — "what are you about
 * to run out of?" — in one glance, which no per-resource CRUD page can do.
 *
 * Two decisions worth defending:
 *
 * Bars are ordered by how full they are, not by a fixed order. A fixed
 * order reads more calmly, but it means the one bar that matters can be
 * anywhere in the list and you have to scan all eight to find it. Sorting
 * by pressure puts it first, always.
 *
 * Caps with no live counter (rolesPerRuleType, apiRequestsPerMinute,
 * historyRetentionDays) are shown as limits without a fill rather than
 * hidden. Hiding them would imply the plan includes fewer things than it
 * does, and these are exactly the three that were being billed for without
 * being enforced — leaving them visible is what makes that discoverable.
 * ------------------------------------------------------------------ */

const CAP_LABELS: Record<keyof RateLimitCaps, string> = {
  submissionsPerDay: "Applications today",
  ticketsPerDay: "Tickets today",
  giveawayEntriesPerDay: "Giveaway entries today",
  formsPerGuild: "Forms",
  panelsPerGuild: "Panels",
  apiRequestsPerMinute: "Dashboard requests / min",
  rolesPerRuleType: "Roles per rule",
  historyRetentionDays: "History kept (days)",
};

/** Caps the system keeps a running count for. The rest are limits that
 * apply at the point of use, with no meaningful "current" value. */
const METERED: (keyof RateLimitCaps)[] = [
  "submissionsPerDay",
  "ticketsPerDay",
  "giveawayEntriesPerDay",
  "formsPerGuild",
  "panelsPerGuild",
];

export function CapacityRail({
  caps,
  used,
  resetsInSeconds,
}: {
  caps: RateLimitCaps;
  used: Record<string, number>;
  resetsInSeconds: number;
}) {
  const metered = METERED.map((key) => {
    const limit = caps[key];
    const current = used[key] ?? 0;
    return { key, limit, current, ratio: limit > 0 ? current / limit : 0 };
  }).sort((a, b) => b.ratio - a.ratio);

  const unmetered = (Object.keys(CAP_LABELS) as (keyof RateLimitCaps)[]).filter(
    (k) => !METERED.includes(k),
  );

  return (
    <div className="caprail">
      {metered.map(({ key, limit, current, ratio }) => {
        const level = levelFor(current, limit);
        return (
          <div className="capbar-row" key={key}>
            <div className="capbar-label">
              <span className="capbar-name">{CAP_LABELS[key]}</span>
              <div className="capbar-track">
                <div
                  className={`capbar-fill${level === "ok" ? "" : ` is-${level}`}`}
                  style={{ width: `${Math.min(100, ratio * 100)}%` }}
                />
                <div className="capbar-tick" />
              </div>
            </div>
            <span className="capbar-count">
              <strong>{current.toLocaleString()}</strong>
              {" / "}
              {limit.toLocaleString()}
            </span>
          </div>
        );
      })}

      <div
        style={{
          borderTop: "1px solid var(--line-soft)",
          paddingTop: 11,
          marginTop: 3,
          display: "flex",
          flexWrap: "wrap",
          gap: "7px 16px",
        }}
      >
        {unmetered.map((key) => (
          <span key={key} style={{ fontSize: 12 }} className="dim">
            {CAP_LABELS[key]}{" "}
            <span className="mono" style={{ color: "var(--text-dim)" }}>
              {caps[key].toLocaleString()}
            </span>
          </span>
        ))}
      </div>

      <span className="eyebrow" style={{ marginTop: 3 }}>
        Daily counts reset in {formatDuration(resetsInSeconds)} · midnight UTC
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sparkline
 * ------------------------------------------------------------------ */
export function Sparkline({ points }: { points: { day: string; count: number }[] }) {
  if (points.length === 0) {
    return <div className="empty">No applications in the last 14 days.</div>;
  }
  const max = Math.max(...points.map((p) => p.count), 1);
  return (
    <div className="spark" role="img" aria-label={`Applications per day: ${points.map((p) => `${p.day}, ${p.count}`).join("; ")}`}>
      {points.map((p) => (
        <div
          key={p.day}
          className="spark-bar"
          style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }}
          title={`${p.day}: ${p.count}`}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 15, width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Banner({
  level,
  title,
  children,
  action,
}: {
  level: "watch" | "act";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner is-${level}`} role={level === "act" ? "alert" : "status"}>
      <div className="banner-body">
        <div className="banner-title">{title}</div>
        <div className="dim">{children}</div>
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return `in ${formatDuration(-diff / 1000)}`;
  if (diff < 45_000) return "just now";
  return `${formatDuration(diff / 1000)} ago`;
}

/** Discord snowflakes carry their creation time in the high bits. Showing
 * an account's age next to its ID is genuinely useful when reviewing a
 * raid — a wall of accounts created the same hour is the tell. */
export function snowflakeDate(id: string): Date {
  return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}
