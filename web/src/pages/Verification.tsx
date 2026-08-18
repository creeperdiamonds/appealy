// web/src/pages/Verification.tsx
//
// The guild's join gate: post a panel with a Verify button, and hand out a
// role when someone passes it.
//
// Like AppealConfig, this screen's real job is stopping a config the API
// happily accepts and the bot then does nothing useful with. Verification has
// more of those than any other feature here, because it is assembled from four
// independent nullable columns and every one of them can be left null:
//
//   1. enabled with no verified role — the button answers "You're verified!"
//      and grants nothing (bot/src/interactions/buttons/verify.ts only calls
//      addRole `if (config.verifiedRoleId)`).
//   2. enabled with no channel — there is nowhere for the button to live, and
//      POST /publish refuses with channel_not_configured.
//   3. a kick timer with no unverified role — applyVerificationGate in
//      bot/src/events/guildMemberAdd.ts returns before it schedules the kick
//      job unless unverifiedRoleId is set, so the timer silently never runs.
//   4. a kick timer WITH an unverified role but no panel — now it does run,
//      and every member who joins is kicked with no way to stop it.
//
// (3) and (4) are the pair worth the whole page: they are the same two
// settings, one is a no-op and the other empties your server, and neither
// produces an error anyone would see.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Pill, formatDuration } from "../components/ui";
import { OptionalChannelPicker, useGuildChannels } from "../components/ChannelPicker";

/* ------------------------------------------------------------------ *
 * Shapes, derived from api/src/routes/verification.ts
 * ------------------------------------------------------------------ */

interface VerificationConfigDTO {
  guildId: string;
  enabled: boolean;
  channelId: string | null;
  /** Set by the bot when it posts a panel. Null means one was never posted,
   *  which is the difference between "configured" and "reachable". */
  messageId: string | null;
  method: "button" | "captcha";
  verifiedRoleId: string | null;
  unverifiedRoleId: string | null;
  panelTitle: string;
  panelDescription: string;
  kickUnverifiedAfterSeconds: number | null;
}

/** PUT body. guildId comes from the path and messageId is the bot's to set. */
type VerificationDraft = Omit<VerificationConfigDTO, "guildId" | "messageId">;

interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

/** Mirrors the zod defaults in the router, so an unsaved guild edits the same
 *  values it would get on first save rather than a blank form. */
const BLANK: VerificationDraft = {
  enabled: false,
  channelId: null,
  method: "button",
  verifiedRoleId: null,
  unverifiedRoleId: null,
  panelTitle: "Verification",
  panelDescription: "Click the button below to verify and gain access to the server.",
  kickUnverifiedAfterSeconds: null,
};

/* ------------------------------------------------------------------ *
 * Errors
 *
 * The API answers {error, detail}. lib/api.ts folds detail into ApiError's
 * message, but for a 400 the detail is a zod flatten() — an object, which
 * String()s to "[object Object]". So the message is only usable when it
 * survived as a string (bot_unreachable sends one), and the error code is
 * what carries meaning the rest of the time. Rather than print a code at
 * someone, name each one.
 * ------------------------------------------------------------------ */

const CODES: Record<string, string> = {
  invalid_body: "The server rejected these values. Check the panel title (256 characters max), the description (2000 max), and that any kick delay is at least a minute.",
  channel_not_configured: "There's no channel set, so there's nowhere to post the panel.",
  bot_unreachable: "The bot didn't answer. It's probably restarting — nothing was changed.",
  admin_access_required: "Changing verification needs Administrator on this server. You can look, but not save.",
  insufficient_permissions: "You don't have access to this server's settings.",
  permission_check_unavailable: "Discord was unreachable, so we couldn't confirm your permissions. Try again shortly.",
};

function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const known = CODES[e.code];
  if (known) return known;
  // A detail that stayed a string is the most specific thing available.
  return e.message && e.message !== "[object Object]" ? e.message : fallback;
}

/* ------------------------------------------------------------------ *
 * Kick delay
 *
 * Stored in seconds; nobody thinks in seconds. Presets cover what people
 * actually pick, and an existing odd value (set by /verify-setup or an
 * earlier version of this page) is kept as its own option so opening this
 * screen can never quietly round someone's config to the nearest preset.
 * ------------------------------------------------------------------ */

const KICK_PRESETS: { value: number | null; label: string }[] = [
  { value: null, label: "Never — unverified members stay as long as they like" },
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21600, label: "6 hours" },
  { value: 86400, label: "24 hours" },
  { value: 259200, label: "3 days" },
  { value: 604800, label: "7 days" },
];

/* ------------------------------------------------------------------ *
 * Pickers
 *
 * RolePicker is a multi-select and these two columns hold one role each, so
 * it doesn't fit here — a chip list that silently keeps only the last chip
 * would be worse than a plain select. It is reused as-is on the Tickets page,
 * where the columns really are arrays. The channel field is
 * OptionalChannelPicker, which makes the same bargain in the shared component.
 *
 * This keeps an id that no longer resolves as a visible option. A role that
 * was deleted in Discord is still in the database and still what the bot will
 * try to use; showing "— none —" instead would be a lie, and picking it up as
 * a real change on the next save would erase a setting nobody touched.
 * ------------------------------------------------------------------ */

function ResourceSelect({
  label,
  hint,
  options,
  value,
  onChange,
  failed,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  options: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string | null) => void;
  failed: boolean;
  placeholder: string;
}) {
  // Degrade to a raw id field rather than blocking the edit, same trade as
  // RolePicker: the bot being down shouldn't cost someone their config.
  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.trim() || null)}
        />
        <span className="dim">
          Couldn't reach the bot to list these, so this is an ID for now. The picker comes back on
          its own once the bot is up.
        </span>
      </label>
    );
  }

  const missing = value !== null && !options.some((o) => o.id === value);

  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— none —</option>
        {missing && <option value={value ?? ""}>Unknown ({value})</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {hint && <span className="dim">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Confirmation
 *
 * Two of the actions on this page act on real members — an auto-kick, and a
 * second panel posted into a live channel — so neither happens on one click.
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

export default function Verification({ guildId }: { guildId: string }) {
  const [config, setConfig] = useState<VerificationDraft | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [confirming, setConfirming] = useState<"kick" | "republish" | null>(null);

  const load = useCallback(async () => {
    try {
      // The config is the only request that must succeed. Pickers failing is a
      // degraded editor (see ResourceSelect); the config failing is no editor.
      const current = await http.get<VerificationConfigDTO | null>(
        `/api/guilds/${guildId}/verification`,
      );
      // GET returns null for a guild that has never saved. Seed the draft from
      // the router's own defaults so the first save writes what's on screen.
      setConfig(
        current
          ? {
              enabled: current.enabled,
              channelId: current.channelId,
              method: current.method,
              verifiedRoleId: current.verifiedRoleId,
              unverifiedRoleId: current.unverifiedRoleId,
              panelTitle: current.panelTitle,
              panelDescription: current.panelDescription,
              kickUnverifiedAfterSeconds: current.kickUnverifiedAfterSeconds,
            }
          : { ...BLANK },
      );
      setMessageId(current?.messageId ?? null);
    } catch (e) {
      setLoadError(describe(e, "Couldn't load verification settings."));
      return;
    }

    try {
      setRoles(await http.get<GuildRole[]>(`/api/guilds/${guildId}/resources/roles`));
    } catch {
      setRolesFailed(true);
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

  const patch = (next: Partial<VerificationDraft>) => {
    setConfig({ ...config, ...next });
    setSaved(false);
  };

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await http.put<VerificationConfigDTO>(
        `/api/guilds/${guildId}/verification`,
        config,
      );
      setConfig({
        enabled: updated.enabled,
        channelId: updated.channelId,
        method: updated.method,
        verifiedRoleId: updated.verifiedRoleId,
        unverifiedRoleId: updated.unverifiedRoleId,
        panelTitle: updated.panelTitle,
        panelDescription: updated.panelDescription,
        kickUnverifiedAfterSeconds: updated.kickUnverifiedAfterSeconds,
      });
      setMessageId(updated.messageId);
      setSaved(true);
    } catch (e) {
      setError(describe(e, "Couldn't save."));
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setError(null);
    setPublished(false);
    try {
      await http.post<{ status: string }>(`/api/guilds/${guildId}/verification/publish`, {});
      setPublished(true);
      // The bot writes messageId as part of publishing; re-read so the
      // "never posted" warning below stops firing without a manual refresh.
      await load();
    } catch (e) {
      setError(describe(e, "Couldn't post the panel."));
    } finally {
      setPublishing(false);
      setConfirming(null);
    }
  }

  // Roles highest-first, matching Discord's own ordering — position is what
  // decides whether the bot can assign a role at all.
  const sortedRoles = [...roles].sort((a, b) => b.position - a.position);

  const roleName = (id: string | null) =>
    id ? (sortedRoles.find((r) => r.id === id)?.name ?? null) : null;

  /* ---- The states the API accepts and the bot can't act on ---- */

  const grantsNothing = config.enabled && !config.verifiedRoleId;
  const noPanelChannel = config.enabled && !config.channelId;
  const neverPosted = config.enabled && !!config.channelId && !messageId;
  const kickNeverRuns = config.kickUnverifiedAfterSeconds !== null && !config.unverifiedRoleId;
  const kickWithNoWayOut =
    config.kickUnverifiedAfterSeconds !== null &&
    !!config.unverifiedRoleId &&
    (!config.channelId || !config.verifiedRoleId);
  const sameRole =
    !!config.verifiedRoleId && config.verifiedRoleId === config.unverifiedRoleId;
  const configuredButOff =
    !config.enabled &&
    (!!config.verifiedRoleId || !!config.unverifiedRoleId || !!config.channelId);
  const tightWindow =
    config.kickUnverifiedAfterSeconds !== null && config.kickUnverifiedAfterSeconds < 600;
  // Only meaningful once the pickers actually loaded; otherwise every id looks
  // missing and the page would scream at a guild with a perfect config.
  const rolesKnown = !rolesFailed && roles.length > 0;
  const channelsKnown = !channelsFailed && (channels?.length ?? 0) > 0;
  const missingVerifiedRole =
    rolesKnown && !!config.verifiedRoleId && !roleName(config.verifiedRoleId);
  const missingUnverifiedRole =
    rolesKnown && !!config.unverifiedRoleId && !roleName(config.unverifiedRoleId);
  const missingChannel =
    channelsKnown &&
    !!config.channelId &&
    !(channels ?? []).some((c) => c.id === config.channelId);

  const kickLabel =
    config.kickUnverifiedAfterSeconds === null
      ? null
      : (KICK_PRESETS.find((p) => p.value === config.kickUnverifiedAfterSeconds)?.label ??
        formatDuration(config.kickUnverifiedAfterSeconds));

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Verification</h1>
        <p className="dim">
          A panel with a Verify button. Passing it grants a role — which is the only thing
          verification actually does, so everything below is about making sure that role exists
          and that people can reach the button.
        </p>
      </header>

      <Panel>
        <div className="row spread wrap">
          <Pill level={config.enabled ? (grantsNothing || noPanelChannel ? "act" : "ok") : undefined}>
            {config.enabled ? "Enabled" : "Off"}
          </Pill>
          <Pill level={messageId ? "ok" : "watch"}>
            {messageId ? "Panel posted" : "Panel never posted"}
          </Pill>
          <Pill level={config.kickUnverifiedAfterSeconds === null ? undefined : kickNeverRuns ? "watch" : "act"}>
            {kickLabel ? `Auto-kick after ${kickLabel}` : "No auto-kick"}
          </Pill>
        </div>
      </Panel>

      {/* --- Broken-but-accepted states, in severity order --- */}

      {kickWithNoWayOut && (
        <Banner level="act" title="Members will be kicked with no way to verify">
          The unverified role is applied on join and a kick is scheduled, but{" "}
          {!config.channelId ? "there's no channel for the panel" : "there's no verified role to grant"}
          . Everyone who joins gets removed on a timer and nothing they do can stop it. Fix the
          gap or clear the kick delay before this reaches anybody.
        </Banner>
      )}

      {grantsNothing && (
        <Banner level="act" title="Enabled, but verifying grants nothing">
          Without a verified role the button replies “You're verified!” and changes nothing —
          members stay exactly as locked out as before, and the log will show successful
          verifications the whole time.
        </Banner>
      )}

      {noPanelChannel && (
        <Banner level="act" title="Enabled, but there's no panel channel">
          The Verify button lives in a message, and there's nowhere to post it. Nobody can start
          verification until you pick a channel.
        </Banner>
      )}

      {kickNeverRuns && (
        <Banner level="watch" title="The kick timer will never run">
          Kicks are scheduled when the unverified role is applied on join, so with no unverified
          role set nothing is ever scheduled. This is harmless — but it isn't doing what the
          setting says. Set an unverified role, or clear the delay so the setting stops implying
          a rule you don't have.
        </Banner>
      )}

      {sameRole && (
        <Banner level="watch" title="Verified and unverified are the same role">
          Verifying adds that role and then removes it in the same step, so it cancels out. These
          are meant to be two different roles: one that gates access, one that grants it.
        </Banner>
      )}

      {missingVerifiedRole && (
        <Banner level="act" title="The verified role no longer exists">
          The saved role ID isn't in this server any more. Verification will succeed and grant
          nothing until you pick a role that exists.
        </Banner>
      )}

      {missingUnverifiedRole && (
        <Banner level="watch" title="The unverified role no longer exists">
          The saved role ID isn't in this server any more, so nothing is applied on join — and any
          kick timer stops with it.
        </Banner>
      )}

      {missingChannel && (
        <Banner level="watch" title="The panel channel is gone or isn't a text channel">
          The saved channel ID isn't in this server's text or announcement channels. Posting a
          panel will fail until you pick another one.
        </Banner>
      )}

      {neverPosted && !missingChannel && (
        <Banner
          level="watch"
          title="No panel has been posted yet"
          action={
            <button
              className="btn btn-sm"
              disabled={publishing}
              onClick={() => void publish()}
            >
              {publishing ? "Posting…" : "Post panel"}
            </button>
          }
        >
          Everything is configured, but the message holding the Verify button was never sent, so
          there's still nothing for members to click.
        </Banner>
      )}

      {tightWindow && !kickNeverRuns && (
        <Banner level="watch" title="That's a short window">
          {kickLabel} is enough for someone who joins, reads the panel and clicks. It isn't enough
          for someone who joins on their phone and puts it down, and those people get kicked from
          a server they meant to stay in. An hour costs you nothing.
        </Banner>
      )}

      {configuredButOff && (
        <Banner level="watch" title="Set up, but switched off">
          Roles and channel are configured and none of it applies: nothing is added on join,
          nothing is granted, no kicks are scheduled. Turn it on when you're ready.
        </Banner>
      )}

      {/* --- Settings --- */}

      <Panel title="The gate">
        <label className="row">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>
            <strong>Enable verification</strong>
            <span className="dim block">
              Off means the join gate does nothing — no role on join, no kicks, and the Verify
              button (if a panel is still up) tells people verification isn't enabled.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Challenge</span>
          <select
            value={config.method}
            onChange={(e) => patch({ method: e.target.value as "button" | "captcha" })}
          >
            <option value="button">Button — one click, no challenge</option>
            <option value="captcha">Captcha — retype a 6-character code</option>
          </select>
          <span className="dim">
            {config.method === "button"
              ? "Anything that can click a button passes, including most self-bots. It's a speed bump, not a filter — worth it mainly for the audit trail and the moment of friction."
              : "Not an image captcha. The bot shows a 6-character code and opens a box asking you to retype it, which stops naive auto-join scripts without an image-rendering dependency. A bot written for this server specifically would still pass."}
          </span>
        </label>
      </Panel>

      <Panel
        title="Where the panel goes"
        action={
          messageId ? (
            <button
              className="btn btn-sm"
              disabled={publishing || !config.channelId}
              onClick={() => setConfirming("republish")}
            >
              Repost panel
            </button>
          ) : (
            <button
              className="btn btn-sm"
              disabled={publishing || !config.channelId}
              onClick={() => void publish()}
            >
              {publishing ? "Posting…" : "Post panel"}
            </button>
          )
        }
      >
        {confirming === "republish" && (
          <Confirm
            title="Post a second panel?"
            confirmLabel="Post anyway"
            busy={publishing}
            onConfirm={() => void publish()}
            onCancel={() => setConfirming(null)}
          >
            Posting doesn't move or edit the existing panel — it sends a new message and forgets
            the old one. The old button keeps working, so members will see two working panels
            until you delete one by hand.
          </Confirm>
        )}

        <OptionalChannelPicker
          label="Panel channel"
          channels={channels}
          failed={channelsFailed}
          value={config.channelId}
          onChange={(id) => patch({ channelId: id })}
          hint="Somewhere an unverified member can see. If the unverified role can't read this channel, verification is unreachable for exactly the people who need it."
        />

        <label className="field">
          <span className="eyebrow">Panel title</span>
          <input
            value={config.panelTitle}
            maxLength={256}
            placeholder="Verification"
            onChange={(e) => patch({ panelTitle: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="eyebrow">Panel text</span>
          <textarea
            rows={4}
            value={config.panelDescription}
            maxLength={2000}
            onChange={(e) => patch({ panelDescription: e.target.value })}
            placeholder="Click the button below to verify and gain access to the server."
          />
          <span className="dim">
            {config.kickUnverifiedAfterSeconds !== null
              ? `Members are kicked after ${kickLabel} if they don't verify — say so here. This message is the only warning they get.`
              : "Say what verifying unlocks. This is the only text on the panel."}
          </span>
        </label>

        {published && <span className="dim">Panel posted.</span>}
      </Panel>

      <Panel title="Roles">
        <ResourceSelect
          label="Verified role"
          value={config.verifiedRoleId}
          onChange={(id) => patch({ verifiedRoleId: id })}
          options={sortedRoles.map((r) => ({ id: r.id, name: r.name }))}
          failed={rolesFailed}
          placeholder="Role ID"
          hint="Granted on passing. This is the whole point of the feature — everything else is scaffolding around it. It must sit below the bot's own highest role or the grant fails silently."
        />

        <ResourceSelect
          label="Unverified role"
          value={config.unverifiedRoleId}
          onChange={(id) => patch({ unverifiedRoleId: id })}
          options={sortedRoles.map((r) => ({ id: r.id, name: r.name }))}
          failed={rolesFailed}
          placeholder="Role ID"
          hint="Optional. Applied on join and removed on verifying — useful if you gate by denying this role instead of by granting the verified one. It's also what the kick timer hangs off, so a kick delay does nothing without it."
        />
      </Panel>

      <Panel title="Members who never verify">
        <label className="field">
          <span className="eyebrow">Kick after</span>
          <select
            value={config.kickUnverifiedAfterSeconds ?? ""}
            onChange={(e) => {
              const next = e.target.value === "" ? null : Number(e.target.value);
              // Turning a kick ON is the one setting here that removes people
              // from the server, so it asks first. Turning it off doesn't.
              if (next !== null && config.kickUnverifiedAfterSeconds === null) {
                setConfirming("kick");
              }
              patch({ kickUnverifiedAfterSeconds: next });
            }}
          >
            {KICK_PRESETS.map((p) => (
              <option key={p.label} value={p.value ?? ""}>
                {p.label}
              </option>
            ))}
            {/* A value set elsewhere (/verify-setup, an older build) that isn't
                one of ours. Kept so opening this page can't round it. */}
            {config.kickUnverifiedAfterSeconds !== null &&
              !KICK_PRESETS.some((p) => p.value === config.kickUnverifiedAfterSeconds) && (
                <option value={config.kickUnverifiedAfterSeconds}>
                  {formatDuration(config.kickUnverifiedAfterSeconds)} (current)
                </option>
              )}
          </select>
          <span className="dim">
            Kicks, not bans — they can rejoin and try again. Each pending kick is a scheduled job
            you can see and cancel under Operations before it fires.
          </span>
        </label>

        {confirming === "kick" && (
          <Confirm
            title="This kicks real members"
            confirmLabel="I understand"
            onConfirm={() => setConfirming(null)}
            onCancel={() => {
              patch({ kickUnverifiedAfterSeconds: null });
              setConfirming(null);
            }}
          >
            Once saved, every member who joins and doesn't verify in time is removed
            automatically. Check that the panel is posted and readable by unverified members
            first — an unreachable panel plus this setting empties the server.
          </Confirm>
        )}
      </Panel>

      {error && (
        <Banner level="act" title="Couldn't save">
          {error}
        </Banner>
      )}

      <div className="actions">
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="dim">Saved.</span>}
      </div>
    </div>
  );
}
