// web/src/pages/AntiRaid.tsx
//
// Join-velocity raid detection: if N members join within S seconds, arm a
// lockdown and do one of three things about it.
//
// The scope limit is the whole design and is worth stating before any
// control appears on screen, because people arrive here expecting a
// mass-ban button and there isn't one. bot/src/services/antiRaidService.ts
// never acts on members who joined before the lockdown, and never bans
// anyone at all — a false positive on a genuine growth spike (a public
// invite going viral) does more damage than under-reacting to a real raid.
//
// What this page has to prevent is narrower and more specific. Every field
// here is independently valid to the API, and three combinations of them
// produce a feature that is switched on and cannot work:
//
//   1. alert_only with no alert channel. triggerLockdown() only sends a
//      message `if (config.alertChannelId)`. Without one the entire effect
//      of a detected raid is a row in the database and a line in the bot's
//      log — nobody in the server is told anything, ever.
//
//   2. A threshold/window pair that normal traffic clears. Ten joins a
//      minute is the router's own default; three joins an hour is a
//      lockdown every afternoon, and if the action is kick_new_joins those
//      lockdowns kick real members.
//
//   3. autoLockdownExpiresAfterSeconds shorter than windowSeconds. The
//      lockdown lifts while the join window that triggered it is still
//      inside its own window, so the very next join re-trips the threshold
//      and arms it again — an alert loop, and under kick_new_joins a gate
//      that flickers open and shut over real people.
//
// And the one that isn't a config error at all: kick_new_joins is a live
// weapon. Switching to it doesn't wait for a new raid — if a lockdown is
// already active when you save, the next member through the door is kicked.
// That is why selecting it costs a second click.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, http, ApiError } from "../lib/api";
import { RolePicker } from "../components/RolePicker";
import { OptionalChannelPicker, useGuildChannels } from "../components/ChannelPicker";
import { Panel, Banner, Loading, Pill, Stat, formatDuration, formatRelative } from "../components/ui";

/* ------------------------------------------------------------------ *
 * Shapes, derived from toDTO() and the lockdown handlers in
 * api/src/routes/antiRaid.ts
 * ------------------------------------------------------------------ */

type AntiRaidAction = "alert_only" | "lock_verification" | "kick_new_joins";

interface AntiRaidConfigDTO {
  guildId: string;
  enabled: boolean;
  joinThreshold: number;
  windowSeconds: number;
  action: AntiRaidAction;
  alertChannelId: string | null;
  alertRoleIds: string[];
  autoLockdownExpiresAfterSeconds: number;
}

/** PUT body. guildId comes from the path. */
type AntiRaidDraft = Omit<AntiRaidConfigDTO, "guildId">;

/**
 * GET /lockdown. The route answers a bare `{ active: false }` when no row
 * exists, and the full shape with `active` computed from `expiresAt > now`
 * when one does — so "not active" and "never triggered" arrive as different
 * payloads and the extra fields are genuinely optional.
 */
interface LockdownDTO {
  active: boolean;
  triggeredAt?: string;
  triggeredByJoinCount?: number;
  expiresAt?: string;
}

/** Mirrors the zod defaults in the router, so a guild that has never saved
 *  edits the values its first save would write rather than a blank form. */
const BLANK: AntiRaidDraft = {
  enabled: false,
  joinThreshold: 10,
  windowSeconds: 60,
  action: "alert_only",
  alertChannelId: null,
  alertRoleIds: [],
  autoLockdownExpiresAfterSeconds: 1800,
};

/* ------------------------------------------------------------------ *
 * What each action actually does
 *
 * Written from bot/src/services/antiRaidService.ts and
 * bot/src/events/guildMemberAdd.ts, not from the enum names. Two of the
 * three do something the name doesn't say:
 *
 *   lock_verification force-enables verification with an UPDATE against an
 *   existing verification_configs row and never turns it back off when the
 *   lockdown expires.
 *
 *   kick_new_joins is enforced in the join handler, after the detection
 *   step has already primed the lockdown cache — so the member whose join
 *   crossed the threshold is kicked too, not just the ones behind them.
 * ------------------------------------------------------------------ */

const ACTIONS: { value: AntiRaidAction; label: string; what: ReactNode }[] = [
  {
    value: "alert_only",
    label: "Alert staff only",
    what: (
      <>
        Posts one message in the alert channel — the join count, the window, and when the
        lockdown lifts — and stops there. Nothing is done to anyone joining. This is the right
        setting for a server that wants a human to look before anything happens.
      </>
    ),
  },
  {
    value: "lock_verification",
    label: "Force verification on",
    what: (
      <>
        Sends the alert, then flips this server's verification setting to enabled so new members
        hit the gate. Two things the name doesn't say: it updates an existing verification
        config, so a server that has never set verification up gets nothing from this — and
        nothing turns it back off when the lockdown expires. Verification stays on until you
        switch it off yourself.
      </>
    ),
  },
  {
    value: "kick_new_joins",
    label: "Kick members who join during the lockdown",
    what: (
      <>
        Sends the alert, then kicks — not bans — every member who joins while the lockdown is
        active, including the one whose join tripped the threshold. Members already in the server
        are never touched, and this is never applied retroactively. Kicked accounts can rejoin
        with a fresh invite once the lockdown ends.
      </>
    ),
  },
];

/* ------------------------------------------------------------------ *
 * Errors
 *
 * ApiError keeps the zod flatten() structured on `detail`, so a 400 from
 * the router's configSchema can be listed field by field instead of being
 * flattened into a sentence that names none of them. `fieldMessages` is
 * that list; CODES covers the errors that carry no detail at all.
 * ------------------------------------------------------------------ */

const CODES: Record<string, string> = {
  invalid_body:
    "The server rejected these values. The threshold has to be 3–1000, the window 10–3600 seconds, and the lockdown length 60–86400 seconds.",
  admin_access_required:
    "Changing anti-raid settings needs Administrator on this server. You can look, but not save — and clearing a lockdown needs it too.",
  insufficient_permissions: "You don't have access to this server's settings.",
  permission_check_unavailable:
    "Discord was unreachable, so we couldn't confirm your permissions. Nothing was changed — try again shortly.",
};

function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const known = CODES[e.code];
  if (known) return known;
  return e.message && e.message !== "[object Object]" ? e.message : fallback;
}

function fieldsOf(e: unknown): string[] | null {
  return e instanceof ApiError ? e.fieldMessages : null;
}

/* ------------------------------------------------------------------ *
 * Presets
 *
 * The window and the lockdown length are stored in seconds and nobody
 * thinks in seconds. An existing odd value — set by /anti-raid or an
 * earlier version of this page — is kept as its own option, so opening
 * this screen can never quietly round someone's config to the nearest
 * preset on the next save.
 * ------------------------------------------------------------------ */

const WINDOWS: { value: number; label: string }[] = [
  { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
];

const LOCKDOWNS: { value: number; label: string }[] = [
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 10800, label: "3 hours" },
  { value: 21600, label: "6 hours" },
  { value: 86400, label: "24 hours" },
];

/**
 * Joins per minute at or below which a threshold/window pair is treated as
 * loose enough to fire on ordinary traffic.
 *
 * Ten is not a guess: it's the rate the router's own defaults describe
 * (10 joins / 60s), so the line sits exactly at what the product ships and
 * only configurations looser than the default are called out. A server that
 * genuinely wants a hair trigger can still have one — it just gets told.
 */
const NORMAL_RATE_PER_MIN = 10;

/**
 * Below this, the count is small enough that ordinary joins clump into it
 * by coincidence. Three people arriving together after a friend posts an
 * invite is not a raid, whatever the window says.
 */
const COINCIDENCE_THRESHOLD = 5;

/* ------------------------------------------------------------------ *
 * Confirmation
 *
 * Both of the real actions on this page act on live members — arming a
 * kick rule, and lifting the restriction that is currently holding a raid
 * off — so neither happens on one click.
 * ------------------------------------------------------------------ */

function Confirm({
  title,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Banner
      level="act"
      title={title}
      action={
        <div className="actions">
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      }
    >
      {children}
    </Banner>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function AntiRaid({ guildId }: { guildId: string }) {
  const [config, setConfig] = useState<AntiRaidDraft | null>(null);
  const [lockdown, setLockdown] = useState<LockdownDTO | null>(null);
  // The channel list failing degrades one picker to an ID field; it is not
  // allowed to stop the settings loading, so it fetches on its own.
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState<"kick" | "clear" | null>(null);

  // The threshold is the one free-text number on the page, so it needs its
  // own string state: parsing straight into the draft would snap an empty
  // box to 3 the moment someone clears it to retype.
  const [thresholdText, setThresholdText] = useState("");

  const load = useCallback(async () => {
    try {
      // api.antiRaid is the front door for this route, but it is typed
      // Record<string, unknown> and the route answers null for a guild that
      // has never saved — so the cast is unavoidable, and it's exactly why
      // the DTO above is declared next to the screen instead of in lib/api.
      const current = (await api.antiRaid(guildId)) as unknown as AntiRaidConfigDTO | null;
      const draft: AntiRaidDraft = current
        ? {
            enabled: current.enabled,
            joinThreshold: current.joinThreshold,
            windowSeconds: current.windowSeconds,
            action: current.action,
            alertChannelId: current.alertChannelId,
            alertRoleIds: current.alertRoleIds ?? [],
            autoLockdownExpiresAfterSeconds: current.autoLockdownExpiresAfterSeconds,
          }
        : { ...BLANK };
      setConfig(draft);
      setThresholdText(String(draft.joinThreshold));
    } catch (e) {
      setLoadError(describe(e, "Couldn't load anti-raid settings."));
      return;
    }

    // Not required to edit: losing the lockdown state loses a panel, not the
    // page.
    try {
      setLockdown(await http.get<LockdownDTO>(`/api/guilds/${guildId}/anti-raid/lockdown`));
    } catch {
      setLockdown(null);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && !config) {
    return (
      <Banner level="act" title="Couldn't load">
        {loadError}
      </Banner>
    );
  }
  if (!config) return <Loading rows={5} />;

  const patch = (next: Partial<AntiRaidDraft>) => {
    setConfig({ ...config, ...next });
    setSaved(false);
  };

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setFields(null);
    try {
      const updated = await http.put<AntiRaidConfigDTO>(
        `/api/guilds/${guildId}/anti-raid`,
        config,
      );
      setConfig({
        enabled: updated.enabled,
        joinThreshold: updated.joinThreshold,
        windowSeconds: updated.windowSeconds,
        action: updated.action,
        alertChannelId: updated.alertChannelId,
        alertRoleIds: updated.alertRoleIds ?? [],
        autoLockdownExpiresAfterSeconds: updated.autoLockdownExpiresAfterSeconds,
      });
      setThresholdText(String(updated.joinThreshold));
      setSaved(true);
    } catch (e) {
      setError(describe(e, "Couldn't save."));
      setFields(fieldsOf(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearLockdown() {
    setClearing(true);
    setError(null);
    setFields(null);
    try {
      await api.clearLockdown(guildId);
      // Re-read rather than assuming: the route reports whether a row was
      // actually updated, and a lockdown that expired on its own between
      // the click and the request should show as expired, not as cleared.
      const fresh = await http
        .get<LockdownDTO>(`/api/guilds/${guildId}/anti-raid/lockdown`)
        .catch(() => null);
      setLockdown(fresh);
    } catch (e) {
      setError(describe(e, "Couldn't clear the lockdown."));
      setFields(fieldsOf(e));
    } finally {
      setClearing(false);
      setConfirming(null);
    }
  }

  /**
   * Switching TO kick_new_joins is the only setting change on this page
   * that can remove real people, so it routes through a confirmation
   * instead of landing in the draft on change. Switching away from it, and
   * every other value, is harmless and applies immediately.
   */
  function chooseAction(next: AntiRaidAction) {
    if (next === "kick_new_joins" && config?.action !== "kick_new_joins") {
      setConfirming("kick");
      return;
    }
    setConfirming((c) => (c === "kick" ? null : c));
    patch({ action: next });
  }

  // Only meaningful once the picker actually loaded; otherwise every saved id
  // looks missing and the page would shout at a guild with a perfect config.
  const channelsKnown = !channelsFailed && (channels?.length ?? 0) > 0;
  const missingChannel =
    channelsKnown &&
    !!config.alertChannelId &&
    !(channels ?? []).some((c) => c.id === config.alertChannelId);

  const thresholdValid =
    /^\d+$/.test(thresholdText) && Number(thresholdText) >= 3 && Number(thresholdText) <= 1000;

  // The number the two detection settings actually describe. Threshold and
  // window are meaningless apart — 20 joins is tight in ten seconds and
  // absurd over an hour — so the rate is what every warning below reasons
  // about, and what the summary shows instead of the raw pair.
  const perMinute = (config.joinThreshold / config.windowSeconds) * 60;
  const rateLabel = perMinute >= 10 ? Math.round(perMinute).toString() : perMinute.toFixed(1);

  const lockdownActive = lockdown?.active === true;
  const everTriggered = !!lockdown?.triggeredAt;

  /* ---- The states the API accepts and the bot can't act on ---- */

  const noAlertChannel = config.enabled && !config.alertChannelId;
  const silentAltogether = noAlertChannel && config.action === "alert_only";
  const pingsGoNowhere = noAlertChannel && config.alertRoleIds.length > 0;
  const expiryUnderWindow =
    config.enabled && config.autoLockdownExpiresAfterSeconds < config.windowSeconds;
  const looseRate = config.enabled && perMinute < NORMAL_RATE_PER_MIN;
  const tinyThreshold = config.enabled && config.joinThreshold < COINCIDENCE_THRESHOLD;
  const kicksArmed = config.enabled && config.action === "kick_new_joins";
  const kickingNow = kicksArmed && lockdownActive;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Anti-raid</h1>
        <p className="dim">
          Watches how fast people join. If {config.joinThreshold} arrive within{" "}
          {formatDuration(config.windowSeconds)}, a lockdown is armed. Members already here are
          never touched and nobody is ever banned — the strongest thing this can do is kick
          accounts that join while the lockdown is up.
        </p>
      </header>

      <Panel>
        <div className="row spread wrap">
          <Pill level={config.enabled ? (silentAltogether ? "act" : "ok") : undefined}>
            {config.enabled ? "Watching joins" : "Off"}
          </Pill>
          <Pill level={kicksArmed ? "act" : undefined}>
            {ACTIONS.find((a) => a.value === config.action)?.label ?? config.action}
          </Pill>
          <Pill level={lockdownActive ? "act" : undefined} live={lockdownActive}>
            {lockdownActive ? "Lockdown active" : everTriggered ? "Lockdown ended" : "No lockdown"}
          </Pill>
        </div>

        <div className="grid grid-3">
          <Stat
            label="Trips at"
            value={`${config.joinThreshold} joins`}
            sub={`within ${formatDuration(config.windowSeconds)}`}
            alert={looseRate || tinyThreshold}
          />
          <Stat label="Which is" value={`${rateLabel}/min`} sub="sustained join rate" />
          <Stat
            label="Lockdown lasts"
            value={formatDuration(config.autoLockdownExpiresAfterSeconds)}
            sub="unless cleared sooner"
            alert={expiryUnderWindow}
          />
        </div>
      </Panel>

      {/* --- Live state first: what is happening right now beats what is configured --- */}

      {kickingNow && (
        <Banner level="act" title="Members are being kicked right now">
          A lockdown is active and the action is set to kick. Everyone who joins this server is
          being removed until it lifts {lockdown?.expiresAt ? formatRelative(lockdown.expiresAt) : ""}
          . If this was a false alarm, clear the lockdown below.
        </Banner>
      )}

      {everTriggered && (
        <Panel
          title={lockdownActive ? "Lockdown in effect" : "Last lockdown"}
          action={
            lockdownActive && confirming !== "clear" ? (
              <button
                className="btn btn-sm"
                disabled={clearing}
                onClick={() => setConfirming("clear")}
              >
                Clear lockdown
              </button>
            ) : undefined
          }
        >
          <div className="grid grid-3">
            <Stat
              label="Triggered by"
              value={`${lockdown?.triggeredByJoinCount ?? "?"} joins`}
              sub={`in ${formatDuration(config.windowSeconds)}`}
            />
            <Stat
              label="Started"
              value={lockdown?.triggeredAt ? formatRelative(lockdown.triggeredAt) : "—"}
              sub={lockdown?.triggeredAt ? new Date(lockdown.triggeredAt).toLocaleString() : undefined}
            />
            <Stat
              label={lockdownActive ? "Lifts" : "Ended"}
              value={lockdown?.expiresAt ? formatRelative(lockdown.expiresAt) : "—"}
              sub={lockdown?.expiresAt ? new Date(lockdown.expiresAt).toLocaleString() : undefined}
              alert={lockdownActive}
            />
          </div>
          {!lockdownActive && (
            <span className="dim block">
              Nothing is being restricted now. The record is kept so the next lockdown can be
              compared against it — a second one an hour later usually means the threshold is too
              low, not that the raid came back.
            </span>
          )}
        </Panel>
      )}

      {confirming === "clear" && (
        <Confirm
          title="End the lockdown now?"
          confirmLabel="Clear lockdown"
          busy={clearing}
          onConfirm={() => void clearLockdown()}
          onCancel={() => setConfirming(null)}
        >
          Joins stop being restricted immediately
          {config.action === "kick_new_joins" ? " and new members stop being kicked" : ""}, roughly
          two seconds after you click — the bot caches lockdown state that long to survive raid
          traffic. If the raid is still in progress, it resumes with no further warning until the
          threshold trips again.
          {config.action === "lock_verification" && (
            <>
              {" "}
              Verification stays switched on either way: the lockdown turned it on and nothing
              turns it back off, so that's yours to undo on the Verification page.
            </>
          )}
        </Confirm>
      )}

      {confirming === "kick" && (
        <Confirm
          title="Kick members who join during a lockdown?"
          confirmLabel="Yes, arm kicks"
          onConfirm={() => {
            setConfirming(null);
            patch({ action: "kick_new_joins" });
          }}
          onCancel={() => setConfirming(null)}
        >
          Every account that joins while a lockdown is active gets kicked — including the member
          whose join crossed the threshold, because detection arms the lockdown before the join
          finishes being handled. That runs for{" "}
          {formatDuration(config.autoLockdownExpiresAfterSeconds)} from the moment it trips, on
          everyone, with no verification step and no appeal. Members already in the server are
          never affected, nothing is retroactive, and these are kicks rather than bans — the
          people caught by mistake can come back with a new invite.
          {lockdownActive && (
            <>
              {" "}
              <strong>
                A lockdown is active right now, so kicks begin the moment you save — there is no
                new raid to wait for.
              </strong>
            </>
          )}
          {looseRate && (
            <>
              {" "}
              <strong>
                At {rateLabel} joins a minute this is set to trip on ordinary traffic.
              </strong>{" "}
              Raise the threshold before arming this.
            </>
          )}
        </Confirm>
      )}

      {/* --- Broken-but-accepted configurations, in severity order --- */}

      {expiryUnderWindow && (
        <Banner level="act" title="The lockdown lifts before the window it's watching closes">
          A {formatDuration(config.autoLockdownExpiresAfterSeconds)} lockdown inside a{" "}
          {formatDuration(config.windowSeconds)} window ends while the joins that triggered it are
          still being counted, so the next join trips the threshold again straight away. That
          means repeated alerts, and{" "}
          {config.action === "kick_new_joins"
            ? "a kick rule that flickers on and off across real members."
            : "a lockdown that never really settles."}{" "}
          Make the lockdown longer than the window.
        </Banner>
      )}

      {silentAltogether && (
        <Banner level="act" title="Enabled, and nobody will ever hear about it">
          Alert-only is the entire action, and there's no alert channel to send it to. A detected
          raid writes a lockdown record and a line in the bot's log — that's it. No message, no
          ping, no restriction. Pick a channel, or pick an action that does something on its own.
        </Banner>
      )}

      {noAlertChannel && !silentAltogether && (
        <Banner level="watch" title="No alert channel">
          The lockdown will still be armed, but nothing tells your staff it happened
          {config.action === "kick_new_joins"
            ? " — the first they'll know is members reporting they were kicked."
            : "."}
          {pingsGoNowhere && " The alert roles below have nowhere to be pinged either."}
        </Banner>
      )}

      {missingChannel && (
        <Banner level="act" title="The alert channel is gone">
          The saved channel ID isn't in this server's channel list any more, so the alert send
          will fail and be logged as an error. Pick another channel.
        </Banner>
      )}

      {tinyThreshold && (
        <Banner level="watch" title="That threshold catches coincidences">
          {config.joinThreshold} people arriving together isn't a raid — it's what happens when
          someone posts your invite. Detection is a count with no account-age or pattern check
          behind it, so a number this small will trip on ordinary days
          {kicksArmed ? ", and each time it will kick whoever walks in next." : "."}
        </Banner>
      )}

      {looseRate && !tinyThreshold && (
        <Banner level={kicksArmed ? "act" : "watch"} title="This will trip on normal traffic">
          {config.joinThreshold} joins in {formatDuration(config.windowSeconds)} is{" "}
          {rateLabel} a minute. Any server that's actually growing clears that, and the default —
          10 joins in a minute — exists because a real raid is an order of magnitude faster.
          {kicksArmed
            ? " With kicks armed, an ordinary busy evening empties your door."
            : " Expect alerts on days nothing is wrong."}
        </Banner>
      )}

      {config.enabled && config.action === "lock_verification" && (
        <Banner level="watch" title="Verification has to already be set up">
          This action switches your existing verification config on. A server that never
          configured verification has no row to switch, so the lockdown will alert and change
          nothing else — and once it does switch verification on, it stays on after the lockdown
          expires until you turn it off yourself.
        </Banner>
      )}

      {/* --- Settings --- */}

      <Panel title="Detection">
        <label className="row">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>
            <strong>Watch join velocity</strong>
            <span className="dim block">
              Off means joins aren't recorded at all — nothing is tracked in the background, so
              turning this on starts from an empty window rather than catching up.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Joins that trigger a lockdown</span>
          {/* Text rather than a number input: index.css styles text and
              unadorned inputs only, and this page doesn't get to add CSS. */}
          <input
            type="text"
            inputMode="numeric"
            value={thresholdText}
            onChange={(e) => {
              const next = e.target.value.trim();
              setThresholdText(next);
              if (/^\d+$/.test(next)) {
                const n = Number(next);
                if (n >= 3 && n <= 1000) patch({ joinThreshold: n });
              }
              setSaved(false);
            }}
          />
          <span className="dim">
            {thresholdValid
              ? `${config.joinThreshold} joins inside the window below.`
              : "Has to be a whole number between 3 and 1000 — saving is blocked until it is."}
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Counted over</span>
          <select
            value={config.windowSeconds}
            onChange={(e) => patch({ windowSeconds: Number(e.target.value) })}
          >
            {!WINDOWS.some((w) => w.value === config.windowSeconds) && (
              <option value={config.windowSeconds}>{config.windowSeconds} seconds</option>
            )}
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
          <span className="dim">
            A rolling window, not a bucket — the count is of joins in the last{" "}
            {formatDuration(config.windowSeconds)} at every join, so a burst spanning two clock
            minutes still counts as one burst.
          </span>
        </label>
      </Panel>

      <Panel title="What happens when it trips">
        <label className="field">
          <span className="eyebrow">Action</span>
          <select
            value={config.action}
            onChange={(e) => chooseAction(e.target.value as AntiRaidAction)}
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <span className="dim">{ACTIONS.find((a) => a.value === config.action)?.what}</span>
        </label>

        {kicksArmed && (
          <div className="row">
            <span>
              <strong>Who gets kicked</strong>
              <span className="dim block">
                Only accounts that join between the lockdown arming and it lifting — for{" "}
                {formatDuration(config.autoLockdownExpiresAfterSeconds)}, or until someone clears
                it here or with <span className="mono">/anti-raid clear</span>. Never existing
                members, never retroactively, and never a ban. The bot needs Kick Members, and its
                role above theirs, or the kick fails and is only visible in the log.
              </span>
            </span>
          </div>
        )}

        <label className="field">
          <span className="eyebrow">Lockdown lasts</span>
          <select
            value={config.autoLockdownExpiresAfterSeconds}
            onChange={(e) => patch({ autoLockdownExpiresAfterSeconds: Number(e.target.value) })}
          >
            {!LOCKDOWNS.some((l) => l.value === config.autoLockdownExpiresAfterSeconds) && (
              <option value={config.autoLockdownExpiresAfterSeconds}>
                {formatDuration(config.autoLockdownExpiresAfterSeconds)}
              </option>
            )}
            {LOCKDOWNS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="dim">
            Measured from the moment it trips. A second burst while one is already running doesn't
            re-alert or extend it — that's deliberate, or a raid would ping your staff thousands of
            times.
          </span>
        </label>
      </Panel>

      <Panel title="Alerts">
        <OptionalChannelPicker
          label="Alert channel"
          channels={channels}
          failed={channelsFailed}
          value={config.alertChannelId}
          onChange={(id) => patch({ alertChannelId: id })}
          hint="Where the raid message goes. Somewhere staff actually watch — this is the only notification the feature sends."
        />

        <RolePicker
          guildId={guildId}
          value={config.alertRoleIds}
          onChange={(ids) => patch({ alertRoleIds: ids })}
          label="Roles to ping"
          hint="Mentioned in the alert. The bot pings these explicitly, so they don't need to be mentionable in Discord's own settings — but with no alert channel they're never sent."
        />
      </Panel>

      {error && (
        <Banner level="act" title="Couldn't save">
          {error}
          {/* fieldMessages is the zod flatten kept structured on ApiError.
              Listing it beats the summarised sentence, which drops every
              field past the second one. */}
          {fields && (
            <ul>
              {fields.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <div className="actions">
        <button
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={saving || !thresholdValid}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="dim">Saved.</span>}
        {!thresholdValid && <span className="dim">Fix the join threshold first.</span>}
      </div>
    </div>
  );
}
