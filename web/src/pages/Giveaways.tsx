// web/src/pages/Giveaways.tsx
//
// Giveaways for one guild: create them, watch them fill up, end and reroll.
//
// Three properties of api/src/routes/giveaways.ts shape this screen more
// than any design preference:
//
//   1. There is no update route. POST creates, DELETE removes, and that is
//      the entire vocabulary for the record itself. So "edit" here can only
//      mean delete-and-recreate, and the screen says that out loud instead
//      of showing fields whose Save button would 404.
//
//   2. end and reroll are neither undoable nor quiet — both draw winners
//      and announce them in the channel. Reroll is the sharper one: it
//      keeps the existing winners and draws winnerCount *more*, excluding
//      the people who already won (endGiveaway(…, isReroll) in
//      bot/src/services/giveawayService.ts). That is not what the word
//      "reroll" promises, so the confirmation spells it out rather than
//      asking "are you sure?" about a thing nobody has described.
//
//   3. publish answers 202 and hands the job to the bot. The row does not
//      become "running" until the bot has actually posted the message, so
//      this reloads and says so instead of flipping the pill optimistically
//      and lying whenever the bot is down.
//
// Timezones: endsAt is timestamptz on the server and an ISO instant on the
// wire. The only zone that exists in this file is the browser's, which is
// what <input type="datetime-local"> already means — it is named next to
// the field and the resulting instant is echoed back before saving, because
// "ends at 20:00" is worth nothing without knowing whose 20:00.

import { useCallback, useEffect, useState } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Stat, Pill, Empty, Loading, Banner, formatRelative } from "../components/ui";
import { RolePicker } from "../components/RolePicker";
import { ChannelPicker, useGuildChannels } from "../components/ChannelPicker";

type GiveawayStatus = "draft" | "scheduled" | "running" | "ended" | "cancelled";

interface BonusEntry {
  roleId: string;
  extraEntries: number;
}

interface Giveaway {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  prize: string;
  winnerCount: number;
  requiredRoleIds: string[];
  blacklistedRoleIds: string[];
  bonusRoleEntries: BonusEntry[];
  status: GiveawayStatus;
  scheduledFor: string | null;
  endsAt: string | null;
  endedAt: string | null;
  winnerIds: string[];
  /** The list route counts giveaway_entries per row; the create response
   *  hardcodes 0. Optional in the shared DTO, so treated as optional here. */
  entryCount?: number;
}

interface Role {
  id: string;
  name: string;
  color: number;
  position: number;
}

/** Straight from the zod schema in api/src/routes/giveaways.ts. Mirrored
 *  rather than guessed: breaking any of these produces a 400 whose body is
 *  a zod flatten, which is not something to put in front of a person. */
const MAX_PRIZE = 256;
const MAX_WINNERS = 50;
const MAX_BONUS_ENTRIES = 50;

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// dateStyle/timeStyle can't be combined with timeZoneName — Intl throws.
// The zone abbreviation is the whole point here, so the components are
// listed out explicitly.
const ABSOLUTE = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

const absolute = (iso: string) => ABSOLUTE.format(new Date(iso));

/** A datetime-local value carries no offset, so `new Date(v)` reads it in
 *  the browser's zone — which is exactly what the field promised. Anything
 *  cleverer here is how a giveaway ends three hours early. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ERROR_HELP: Record<string, string> = {
  invalid_body:
    "The API rejected these fields. Check the prize (1–256 characters), the winner count (1–50), and that the end time is a real date.",
  giveaway_not_found: "That giveaway is gone — someone else may have deleted it. Reload to catch up.",
  already_published: "That one has already been published.",
  not_running: "Only a running giveaway can be ended.",
  not_ended: "Only a finished giveaway can be rerolled.",
  bot_unreachable:
    "The API couldn't reach the bot, so nothing was posted or drawn. Nothing changed — try again once the bot is back.",
};

/**
 * request() puts the API's `detail` into ApiError.message, and for a zod
 * failure that detail is an object, which stringifies to "[object Object]".
 * Prefer our own sentence whenever that happened, and keep the server's
 * words whenever they are real ones.
 */
function explain(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const help = ERROR_HELP[e.code];
  const detail = e.message && e.message !== "[object Object]" ? e.message : null;
  if (help && detail && detail !== help && detail !== e.code) return `${help} (${detail})`;
  return help ?? detail ?? fallback;
}

interface Draft {
  channelId: string;
  prize: string;
  winnerCount: number;
  requiredRoleIds: string[];
  blacklistedRoleIds: string[];
  bonusRoleEntries: BonusEntry[];
  endsAtLocal: string;
}

const blankDraft = (): Draft => ({
  channelId: "",
  prize: "",
  winnerCount: 1,
  requiredRoleIds: [],
  blacklistedRoleIds: [],
  bonusRoleEntries: [],
  endsAtLocal: "",
});

type Action = "publish" | "end" | "reroll" | "delete";

const ACTION_LABEL: Record<Action, string> = {
  publish: "Yes, post it",
  end: "Yes, end it now",
  reroll: "Yes, draw again",
  delete: "Yes, delete it",
};

function confirmCopy(action: Action, g: Giveaway, channelName: string): string {
  const entries = g.entryCount ?? 0;
  const winners = `${g.winnerCount} winner${g.winnerCount === 1 ? "" : "s"}`;
  switch (action) {
    case "publish":
      return `Posts "${g.prize}" in #${channelName} right now and starts taking entries. There's no unpublish — the only way back is deleting it.`;
    case "end":
      return `Draws ${winners} immediately from the ${entries} entr${entries === 1 ? "y" : "ies"} so far and announces them in #${channelName}${
        g.endsAt ? `, ahead of its ${absolute(g.endsAt)} finish` : ""
      }. Entries stop. This can't be undone.`;
    case "reroll":
      return `Draws ${winners} more from everyone who hasn't already won, and announces them in #${channelName}. The ${g.winnerIds.length} existing winner${
        g.winnerIds.length === 1 ? "" : "s"
      } keep their win — a reroll adds winners, it doesn't replace them.`;
    case "delete":
      return `Deletes the giveaway and all ${entries} of its entries. Any message already posted in #${channelName} stays there, dead — remove that yourself.`;
  }
}

export default function Giveaways({ guildId }: { guildId: string }) {
  const [rows, setRows] = useState<Giveaway[] | null>(null);
  // Names for the list below as well as the picker's own options, so it is
  // one request for the page rather than one per field.
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: Action } | null>(null);

  const load = useCallback(async () => {
    try {
      // Roles are labels for the giveaway list; a bot that's down shouldn't
      // blank the page, so only the giveaways themselves are allowed to fail
      // the load.
      const [g, r] = await Promise.all([
        http.get<Giveaway[]>(`/api/guilds/${guildId}/giveaways`),
        http.get<Role[]>(`/api/guilds/${guildId}/resources/roles`).catch(() => [] as Role[]),
      ]);
      setRows(g);
      setRoles(r);
      setError(null);
    } catch (e) {
      setError(explain(e, "Couldn't load giveaways."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !rows) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!rows) return <Loading rows={5} />;

  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name ?? id;
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;

  const running = rows.filter((g) => g.status === "running");
  const entriesLive = running.reduce((n, g) => n + (g.entryCount ?? 0), 0);

  async function act(id: string, action: Action) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      if (action === "delete") {
        await http.del<void>(`/api/guilds/${guildId}/giveaways/${id}`);
        setNotice("Giveaway deleted.");
      } else if (action === "publish") {
        await http.post<{ status: string }>(`/api/guilds/${guildId}/giveaways/${id}/publish`, {});
        // 202: the bot has been asked, not obeyed. Claiming "published"
        // here would be a guess, and a wrong one whenever the bot is wedged.
        setNotice(
          "Asked the bot to post it. It turns into 'running' once the message is actually up — reload in a moment if it hasn't.",
        );
      } else {
        const res = await http.post<{ winners: string[] }>(
          `/api/guilds/${guildId}/giveaways/${id}/${action}`,
          {},
        );
        setNotice(
          res.winners.length > 0
            ? `${action === "reroll" ? "Rerolled" : "Ended"} — ${res.winners.length} winner${
                res.winners.length === 1 ? "" : "s"
              }: ${res.winners.join(", ")}`
            : "Nobody eligible was entered, so no winner could be drawn. The channel has been told.",
        );
      }
      setConfirming(null);
      await load();
    } catch (e) {
      setError(explain(e, "That didn't work."));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!draft) return;
    const endsAtIso = localInputToIso(draft.endsAtLocal);
    // Checked here rather than left to the 400, because the API's answer is
    // a zod flatten and this is a form someone just spent a minute filling.
    if (!draft.prize.trim()) return setError("A giveaway needs a prize — it's the title of the post.");
    if (!draft.channelId.trim()) return setError("Pick a channel to post it in.");
    if (!endsAtIso) return setError("Set an end time.");

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await http.post<Giveaway>(`/api/guilds/${guildId}/giveaways`, {
        channelId: draft.channelId.trim(),
        prize: draft.prize.trim(),
        winnerCount: draft.winnerCount,
        requiredRoleIds: draft.requiredRoleIds,
        blacklistedRoleIds: draft.blacklistedRoleIds,
        bonusRoleEntries: draft.bonusRoleEntries,
        endsAt: endsAtIso,
      });
      setDraft(null);
      setNotice("Created as a draft. Nothing is posted until you publish it.");
      await load();
    } catch (e) {
      setError(explain(e, "Couldn't create the giveaway."));
    } finally {
      setSaving(false);
    }
  }

  const patch = (next: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  const draftEndsIso = draft ? localInputToIso(draft.endsAtLocal) : null;
  const endsInPast = draftEndsIso !== null && new Date(draftEndsIso).getTime() <= Date.now();

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Giveaways</h1>
        <p className="dim">
          Entries are collected on the message the bot posts. Winners are drawn when the end time
          passes, or when you end it here.
        </p>
      </header>

      {error && <Banner level="act" title="Something went wrong">{error}</Banner>}
      {notice && <Banner level="watch" title="Done">{notice}</Banner>}

      <div className="grid grid-3">
        <Stat label="Running" value={running.length} sub={running.length === 0 ? "nothing live" : undefined} />
        <Stat label="Entries in running" value={entriesLive.toLocaleString()} />
        <Stat label="Drafts" value={rows.filter((g) => g.status === "draft").length} sub="not posted yet" />
      </div>

      <Panel
        eyebrow="All giveaways"
        title={`${rows.length} in this server`}
        action={
          <button className="btn btn-primary" onClick={() => setDraft(draft ? null : blankDraft())}>
            {draft ? "Cancel" : "New giveaway"}
          </button>
        }
      >
        {rows.length === 0 ? (
          <Empty title="No giveaways yet" hint="Create one, then publish it to post the entry message." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Entries</th>
                <th>Ends</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const gates = [
                  g.requiredRoleIds.length > 0 && `needs ${g.requiredRoleIds.map(roleName).join(", ")}`,
                  g.blacklistedRoleIds.length > 0 && `blocks ${g.blacklistedRoleIds.map(roleName).join(", ")}`,
                  ...g.bonusRoleEntries.map((b) => `${roleName(b.roleId)} +${b.extraEntries}`),
                ].filter(Boolean) as string[];

                return (
                  <tr key={g.id}>
                    <td>
                      <div>{g.prize}</div>
                      <div className="dim" style={{ fontSize: 11 }}>
                        {g.winnerCount} winner{g.winnerCount === 1 ? "" : "s"}
                        {gates.length > 0 && ` · ${gates.join(" · ")}`}
                      </div>
                      {g.winnerIds.length > 0 && (
                        <div className="dim mono" style={{ fontSize: 11, marginTop: 3 }}>
                          won by {g.winnerIds.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="dim">#{channelName(g.channelId)}</td>
                    <td>
                      <Pill
                        level={
                          g.status === "running"
                            ? "ok"
                            : g.status === "scheduled"
                              ? "watch"
                              : g.status === "cancelled"
                                ? "act"
                                : undefined
                        }
                        live={g.status === "running"}
                      >
                        {g.status}
                      </Pill>
                    </td>
                    <td className="mono">{(g.entryCount ?? 0).toLocaleString()}</td>
                    <td className="dim">
                      {g.endedAt ? (
                        <>
                          <div>ended {formatRelative(g.endedAt)}</div>
                          <div style={{ fontSize: 11 }}>{absolute(g.endedAt)}</div>
                        </>
                      ) : g.endsAt ? (
                        <>
                          <div>{formatRelative(g.endsAt)}</div>
                          {/* The absolute instant with its zone, always. A
                              lone "in 5h" is unverifiable, and this is the
                              number people plan an announcement around. */}
                          <div style={{ fontSize: 11 }}>{absolute(g.endsAt)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {confirming?.id === g.id ? (
                        <div style={{ display: "grid", gap: 6, maxWidth: 340 }}>
                          <span className="dim" style={{ fontSize: 11 }}>
                            {confirmCopy(confirming.action, g, channelName(g.channelId))}
                          </span>
                          <div className="row wrap">
                            <button
                              className={`btn btn-sm${
                                confirming.action === "delete" || confirming.action === "end" ? " btn-danger" : ""
                              }`}
                              disabled={busy === g.id}
                              onClick={() => void act(g.id, confirming.action)}
                            >
                              {busy === g.id ? "Working…" : ACTION_LABEL[confirming.action]}
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={busy === g.id}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="row wrap">
                          {g.status === "draft" && (
                            <button
                              className="btn btn-sm"
                              onClick={() => setConfirming({ id: g.id, action: "publish" })}
                            >
                              Publish
                            </button>
                          )}
                          {g.status === "running" && (
                            <button className="btn btn-sm" onClick={() => setConfirming({ id: g.id, action: "end" })}>
                              End now
                            </button>
                          )}
                          {g.status === "ended" && (
                            <button
                              className="btn btn-sm"
                              onClick={() => setConfirming({ id: g.id, action: "reroll" })}
                            >
                              Reroll
                            </button>
                          )}
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => setConfirming({ id: g.id, action: "delete" })}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {draft && (
        <Panel eyebrow="New" title="Create a giveaway">
          {/* Said before the fields rather than after a failed save: there
              is no PATCH for giveaways, so nothing typed here is editable
              later, and that changes how carefully you fill the form in. */}
          <Banner level="watch" title="Giveaways can't be edited after they're created">
            The API has no update route for them — only create, publish, end, reroll and delete. A
            wrong prize or end time means deleting this and making it again, which is harmless while
            it's still a draft and messy once it's posted.
          </Banner>

          <label className="field">
            <span className="eyebrow">Prize</span>
            <input
              value={draft.prize}
              maxLength={MAX_PRIZE}
              placeholder="Nitro for a month"
              onChange={(e) => patch({ prize: e.target.value })}
            />
            <span className="dim">
              {draft.prize.length}/{MAX_PRIZE} characters. This is the title of the post.
            </span>
          </label>

          <ChannelPicker
            label="Channel"
            channels={channels}
            failed={channelsFailed}
            value={draft.channelId}
            onChange={(channelId) => patch({ channelId })}
            hint="Only text and announcement channels the bot can see are listed."
          />

          <label className="field">
            <span className="eyebrow">Winners</span>
            <input
              className="input"
              type="number"
              min={1}
              max={MAX_WINNERS}
              value={draft.winnerCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                // Clamped rather than left to the 400: the API's answer to
                // 51 is a zod flatten nobody can read.
                patch({
                  winnerCount: Number.isFinite(n) ? Math.min(MAX_WINNERS, Math.max(1, Math.trunc(n))) : 1,
                });
              }}
              style={{ maxWidth: 120 }}
            />
            <span className="dim">
              Between 1 and {MAX_WINNERS} — the API rejects anything outside that. Asking for more winners
              than there are entrants simply draws everyone.
            </span>
          </label>

          <label className="field">
            <span className="eyebrow">Ends at</span>
            <input
              className="input"
              type="datetime-local"
              value={draft.endsAtLocal}
              onChange={(e) => patch({ endsAtLocal: e.target.value })}
            />
            <span className="dim">
              Read in your own timezone ({ZONE}).{" "}
              {draftEndsIso
                ? `That's ${absolute(draftEndsIso)} — ${formatRelative(draftEndsIso)}.`
                : "The server stores the exact instant, so it lands at the same moment for members everywhere."}
            </span>
          </label>

          {endsInPast && (
            <Banner level="act" title="That end time has already passed">
              The API accepts it, but the bot's next sweep would draw the winners within about half a
              minute of publishing. Push the time forward unless that's genuinely what you want.
            </Banner>
          )}

          <RolePicker
            guildId={guildId}
            label="Required roles"
            value={draft.requiredRoleIds}
            onChange={(ids) => patch({ requiredRoleIds: ids })}
            hint="Leave empty and anyone can enter. With roles picked, an entrant needs at least one of them."
          />

          <RolePicker
            guildId={guildId}
            label="Blocked roles"
            value={draft.blacklistedRoleIds}
            onChange={(ids) => patch({ blacklistedRoleIds: ids })}
            hint="Anyone holding one of these can't enter, even if they also hold a required role."
          />

          <RolePicker
            guildId={guildId}
            label="Bonus entries"
            value={draft.bonusRoleEntries.map((b) => b.roleId)}
            onChange={(ids) =>
              // Reconciled rather than rebuilt, so removing a role and adding
              // it back doesn't quietly reset the weight next to it.
              patch({
                bonusRoleEntries: ids.map(
                  (id) =>
                    draft.bonusRoleEntries.find((b) => b.roleId === id) ?? { roleId: id, extraEntries: 1 },
                ),
              })
            }
            hint="Pick the roles that get extra weight in the draw, then set how much below."
          />

          {draft.bonusRoleEntries.map((b, i) => (
            <label className="field" key={b.roleId}>
              <span className="eyebrow">Extra entries for {roleName(b.roleId)}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={MAX_BONUS_ENTRIES}
                value={b.extraEntries}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n)
                    ? Math.min(MAX_BONUS_ENTRIES, Math.max(1, Math.trunc(n)))
                    : 1;
                  patch({
                    bonusRoleEntries: draft.bonusRoleEntries.map((x, at) =>
                      at === i ? { ...x, extraEntries: clamped } : x,
                    ),
                  });
                }}
                style={{ maxWidth: 120 }}
              />
              <span className="dim">
                1–{MAX_BONUS_ENTRIES} extra tickets on top of their own. Bonuses stack, so someone holding three
                boosted roles gets all three.
              </span>
            </label>
          ))}

          <div className="actions">
            <button className="btn btn-primary" onClick={() => void create()} disabled={saving}>
              {saving ? "Creating…" : "Create draft"}
            </button>
            <button className="btn" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
            <span className="dim">Creating posts nothing. Publish does.</span>
          </div>
        </Panel>
      )}

      <p className="dim" style={{ fontSize: 12, margin: 0 }}>
        Every time on this page is shown in {ZONE}, your browser's timezone. The server keeps the exact
        instant, so a giveaway ends at the same moment for every member wherever they are.
      </p>
    </div>
  );
}
