// web/src/components/ui.tsx
//
// Shared primitives. Small enough to live in one file; splitting them into
// eleven modules would add navigation cost without adding clarity.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RateLimitCaps } from "../lib/api";
import { nextChoice, setTheme, storedChoice, type ThemeChoice } from "../lib/theme";

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

/* ------------------------------------------------------------------ *
 * Sheet
 *
 * The pattern already existed, hand-rolled inside ServerBanned.tsx. It is
 * shared now because the phone navigation depends on it, and two copies of a
 * dialog is two places to get focus handling wrong.
 *
 * Bottom-anchored on a phone (see index.css): the top of the screen is the
 * part a thumb cannot reach, and a centred dialog puts the close button
 * exactly there.
 * ------------------------------------------------------------------ */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    // Focus moves into the dialog, or a keyboard user is left tabbing through
    // the page behind it with no idea anything opened.
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll under the sheet — on a phone that reads
    // as the sheet itself failing to scroll.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        // Without this a click on the sheet bubbles to the backdrop and closes
        // the thing the user was reaching for.
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 id={headingId}>{title}</h2>
          <button ref={closeRef} className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Theme toggle
 *
 * Cycles system → light → dark → system. System stays IN the cycle rather
 * than being buried in a settings screen: it is the default, it is what people
 * want back after trying the other two, and a control you cannot return to the
 * default with is a trap.
 *
 * The label says what you will get, not what you have. A control captioned
 * with its current state and a control captioned with its next state look
 * identical and mean opposite things, and the second is the one people read
 * correctly.
 * ------------------------------------------------------------------ */
/* One glyph per state, on the same 24x24 grid as the nav icons, stroked with
 * currentColor. A monitor for "follow the device" rather than a half-filled
 * circle: the half-circle is the convention, and it is also the one people
 * read as "contrast" or "partial". A screen is unambiguous. */
const THEME_ICON: Record<ThemeChoice, string> = {
  system: "M3 5h18v11H3zM8 20h8M12 16v4",
  light: "M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6 4.5 4.5M19.5 19.5 18 18M6 18l-1.5 1.5M19.5 4.5 18 6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  dark: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5",
};

export function ThemeToggle({ className = "nav-item" }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => storedChoice());
  const next = nextChoice(choice);

  return (
    <button
      className={className}
      onClick={() => setChoice(setTheme(next))}
      // The accessible name has to carry the destination too — an icon button
      // labelled "Theme" tells a screen reader user nothing about what pressing
      // it does.
      aria-label={`Switch to ${next === "system" ? "system" : next} theme`}
      title={`Theme: ${choice}. Switch to ${next}.`}
    >
      <svg
        className="nav-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={THEME_ICON[choice]} />
      </svg>
      {choice === "system" ? "System theme" : choice === "light" ? "Light" : "Dark"}
    </button>
  );
}

/**
 * A tier as a person should read it.
 *
 * `guild.tier` is the stored enum — "free", "tier1", "tier2", "custom" — and it
 * was being rendered straight into the capacity pill, so the console said
 * "tier2 plan". That is the database's word for it, not the customer's, and
 * the pricing page calls the same thing "Throughput tier 2".
 */
export function formatTier(tier: string | null | undefined): string {
  if (!tier) return "Free";
  const preset = /^tier(\d+)$/.exec(tier);
  if (preset) return `Tier ${preset[1]}`;
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}
