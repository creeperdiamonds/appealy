// web/src/pages/Polls.tsx
//
// Community polls: write them, schedule them, publish them, let them close.
//
// The lifecycle is the thing this screen has to teach, because it is split
// between three places and none of them is obvious from a list of rows:
//
//   draft      → nothing exists in Discord yet
//   scheduled  → the bot posts it when scheduledFor passes (publishDuePolls
//                sweeps every 30s, so "on time" means "within half a minute")
//   published  → votes are being taken on the message
//   closed     → closesAt passed and the scheduler stripped the vote menu
//
// Two consequences worth stating up front rather than discovering:
//
//   * A poll stops being editable the moment it's published. The API answers
//     409 poll_already_published for PATCH, so the editor refuses to open on
//     one instead of collecting edits it can't save.
//
//   * closesAt only ever closes a *published* poll (closeDuePolls filters on
//     status). A close time on a poll nobody publishes is inert, and a close
//     time earlier than the publish time closes it on the very next sweep.
//     Both are configurations the API accepts happily, so they're flagged here.
//
// There is no manual "close now" route — closing is entirely closesAt's job.
// Rather than fake a button that would have to lie, the close time is
// editable and explained.
//
// Timezones: scheduledFor and closesAt are timestamptz on the server and ISO
// instants on the wire. <input type="datetime-local"> means the browser's own
// zone, so that zone is named beside every field and the resulting instant is
// echoed back before saving — a poll that closes an hour early because
// someone assumed UTC is a real and unrecoverable failure.

import { useCallback, useEffect, useState } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Pill, Empty, Loading, Banner, formatRelative } from "../components/ui";
import { ChannelPicker, useGuildChannels } from "../components/ChannelPicker";

type PollStatus = "draft" | "scheduled" | "published" | "closed";

interface PollOption {
  id?: string;
  label: string;
  emoji?: string;
}

interface Poll {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  question: string;
  options: PollOption[];
  allowMultiselect: boolean;
  status: PollStatus;
  scheduledFor: string | null;
  closesAt: string | null;
}

/** Mirrors the zod schema in api/src/routes/polls.ts. MAX_OPTIONS is the
 *  Discord select-menu cap the router enforces; the bot's /poll fast path
 *  tops out at 9 because a slash command can only carry nine option fields,
 *  which is why a 10-option poll can be made here and not there. */
const MAX_QUESTION = 300;
const MAX_LABEL = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const FAST_PATH_OPTIONS = 9;

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// dateStyle/timeStyle can't be combined with timeZoneName — Intl throws.
// The zone abbreviation is exactly what has to be visible, so components
// are spelled out.
const ABSOLUTE = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

const absolute = (iso: string) => ABSOLUTE.format(new Date(iso));

/** datetime-local carries no offset, so `new Date(v)` reads it in the
 *  browser's zone — precisely what the field promised the person typing. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The inverse, for loading an existing poll back into the form. Built from
 *  local getters rather than toISOString().slice(), which would silently
 *  shift the displayed time by the UTC offset. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ERROR_HELP: Record<string, string> = {
  invalid_body:
    "The API rejected these fields. A poll needs a question of 1–300 characters and between 2 and 10 options, each 1–100 characters.",
  poll_not_found: "That poll is gone — someone else may have deleted it. Reload to catch up.",
  poll_already_published: "Published and closed polls can't be edited. Delete it and post a new one.",
  already_published: "That poll has already been published.",
  bot_unreachable:
    "The API couldn't reach the bot, so nothing was posted. The poll is unchanged — try again once the bot is back.",
};

/**
 * request() puts the API's `detail` into ApiError.message, and for a zod
 * failure that detail is an object, which stringifies to "[object Object]".
 * Prefer our own sentence when that happened; keep the server's words when
 * they're real (poll_already_published sends a usable one).
 */
function explain(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const help = ERROR_HELP[e.code];
  const detail = e.message && e.message !== "[object Object]" ? e.message : null;
  if (help && detail && detail !== help && detail !== e.code) return `${help} (${detail})`;
  return help ?? detail ?? fallback;
}

interface Draft {
  /** Absent on a new poll; present means PATCH rather than POST. */
  id?: string;
  channelId: string;
  question: string;
  options: PollOption[];
  allowMultiselect: boolean;
  scheduledForLocal: string;
  closesAtLocal: string;
}

const blankDraft = (): Draft => ({
  channelId: "",
  question: "",
  options: [{ label: "" }, { label: "" }],
  allowMultiselect: false,
  scheduledForLocal: "",
  closesAtLocal: "",
});

const draftFrom = (p: Poll): Draft => ({
  id: p.id,
  channelId: p.channelId,
  question: p.question,
  // Option ids are carried back verbatim. poll_votes rows are keyed by
  // optionId, so dropping them on an edit would orphan every vote already
  // cast — the router only generates a new id where one is missing.
  options: p.options.map((o) => ({ id: o.id, label: o.label, emoji: o.emoji })),
  allowMultiselect: p.allowMultiselect,
  scheduledForLocal: isoToLocalInput(p.scheduledFor),
  closesAtLocal: isoToLocalInput(p.closesAt),
});

type Action = "publish" | "delete";

export default function Polls({ guildId }: { guildId: string }) {
  const [rows, setRows] = useState<Poll[] | null>(null);
  // Names for the list below as well as the picker's own options, so it is
  // one request for the page rather than one per field.
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: Action } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await http.get<Poll[]>(`/api/guilds/${guildId}/polls`));
      setError(null);
    } catch (e) {
      setError(explain(e, "Couldn't load polls."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !rows) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!rows) return <Loading rows={5} />;

  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name ?? id;
  const editable = (p: Poll) => p.status === "draft" || p.status === "scheduled";

  async function act(id: string, action: Action) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      if (action === "delete") {
        await http.del<void>(`/api/guilds/${guildId}/polls/${id}`);
        setNotice("Poll deleted, along with every vote recorded against it.");
      } else {
        await http.post<{ status: string }>(`/api/guilds/${guildId}/polls/${id}/publish`, {});
        // 202: the bot has been asked, not obeyed. The row flips to
        // "published" only once the message is actually up.
        setNotice("Asked the bot to post it. It shows as published once the message exists — reload in a moment.");
      }
      setConfirming(null);
      if (draft?.id === id) setDraft(null);
      await load();
    } catch (e) {
      setError(explain(e, "That didn't work."));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft) return;
    const question = draft.question.trim();
    const options = draft.options
      .map((o) => ({ id: o.id, label: o.label.trim(), emoji: o.emoji?.trim() || undefined }))
      .filter((o) => o.label.length > 0);

    // Checked here rather than left to the 400, because the API answers a
    // zod flatten and this form takes real effort to fill in.
    if (!question) return setError("A poll needs a question.");
    if (!draft.channelId.trim()) return setError("Pick a channel to post it in.");
    if (options.length < MIN_OPTIONS) {
      return setError(`A poll needs at least ${MIN_OPTIONS} options with text in them — blank ones are dropped.`);
    }
    if (options.length > MAX_OPTIONS) {
      return setError(`Discord's select menu holds ${MAX_OPTIONS} options, and the API rejects more.`);
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        channelId: draft.channelId.trim(),
        question,
        options,
        allowMultiselect: draft.allowMultiselect,
        // Explicit null, not omitted: PATCH treats `undefined` as "leave
        // alone", so clearing a schedule has to be sent as null to land.
        scheduledFor: localInputToIso(draft.scheduledForLocal),
        closesAt: localInputToIso(draft.closesAtLocal),
      };
      if (draft.id) {
        await http.patch<Poll>(`/api/guilds/${guildId}/polls/${draft.id}`, body);
        setNotice("Saved.");
      } else {
        await http.post<Poll>(`/api/guilds/${guildId}/polls`, body);
        setNotice(
          body.scheduledFor
            ? "Scheduled. The bot posts it when that time arrives."
            : "Saved as a draft. Nothing is posted until you publish it.",
        );
      }
      setDraft(null);
      await load();
    } catch (e) {
      setError(explain(e, "Couldn't save the poll."));
    } finally {
      setSaving(false);
    }
  }

  const patch = (next: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  const patchOption = (i: number, next: Partial<PollOption>) =>
    setDraft((d) =>
      d ? { ...d, options: d.options.map((o, at) => (at === i ? { ...o, ...next } : o)) } : d,
    );

  const scheduledIso = draft ? localInputToIso(draft.scheduledForLocal) : null;
  const closesIso = draft ? localInputToIso(draft.closesAtLocal) : null;
  const scheduledInPast = scheduledIso !== null && new Date(scheduledIso).getTime() <= Date.now();
  // A close time that isn't after the moment the poll goes up leaves no
  // window to vote in. Compared against the schedule when there is one, and
  // against now when publishing is manual.
  const closesBeforeItOpens =
    closesIso !== null &&
    new Date(closesIso).getTime() <= new Date(scheduledIso ?? new Date().toISOString()).getTime();
  const closesWithoutPublish = closesIso !== null && scheduledIso === null;
  const filledOptions = draft ? draft.options.filter((o) => o.label.trim()).length : 0;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Polls</h1>
        <p className="dim">
          Voting happens on a select menu under the message the bot posts. A poll closes itself when
          its close time passes.
        </p>
      </header>

      {error && <Banner level="act" title="Something went wrong">{error}</Banner>}
      {notice && <Banner level="watch" title="Done">{notice}</Banner>}

      <Panel
        eyebrow="All polls"
        title={`${rows.length} in this server`}
        action={
          <button className="btn btn-primary" onClick={() => setDraft(draft ? null : blankDraft())}>
            {draft ? "Cancel" : "New poll"}
          </button>
        }
      >
        {rows.length === 0 ? (
          <Empty title="No polls yet" hint="Write one, then publish it or give it a time to go up." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Goes up</th>
                <th>Closes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.question}</div>
                    <div className="dim" style={{ fontSize: 11 }}>
                      {p.options.length} options · {p.allowMultiselect ? "pick several" : "pick one"}
                    </div>
                    <div className="dim" style={{ fontSize: 11 }}>
                      {p.options.map((o) => `${o.emoji ? `${o.emoji} ` : ""}${o.label}`).join(" · ")}
                    </div>
                  </td>
                  <td className="dim">#{channelName(p.channelId)}</td>
                  <td>
                    <Pill
                      level={
                        p.status === "published"
                          ? "ok"
                          : p.status === "scheduled"
                            ? "watch"
                            : undefined
                      }
                      live={p.status === "published"}
                    >
                      {p.status}
                    </Pill>
                  </td>
                  <td className="dim">
                    {p.scheduledFor ? (
                      <>
                        <div>{formatRelative(p.scheduledFor)}</div>
                        {/* Absolute instant with its zone, always — a lone
                            "in 5h" can't be checked against a calendar. */}
                        <div style={{ fontSize: 11 }}>{absolute(p.scheduledFor)}</div>
                      </>
                    ) : p.status === "published" || p.status === "closed" ? (
                      "posted"
                    ) : (
                      "when you publish"
                    )}
                  </td>
                  <td className="dim">
                    {p.closesAt ? (
                      <>
                        <div>{formatRelative(p.closesAt)}</div>
                        <div style={{ fontSize: 11 }}>{absolute(p.closesAt)}</div>
                      </>
                    ) : (
                      "stays open"
                    )}
                  </td>
                  <td>
                    {confirming?.id === p.id ? (
                      <div style={{ display: "grid", gap: 6, maxWidth: 340 }}>
                        <span className="dim" style={{ fontSize: 11 }}>
                          {confirming.action === "publish"
                            ? `Posts this poll in #${channelName(p.channelId)} now and starts taking votes. It can't be edited afterwards, and there's no unpublish — only deleting it.`
                            : `Deletes the poll and every vote cast on it. Any message already in #${channelName(p.channelId)} stays there with a dead menu — remove that yourself.`}
                        </span>
                        <div className="row wrap">
                          <button
                            className={`btn btn-sm${confirming.action === "delete" ? " btn-danger" : ""}`}
                            disabled={busy === p.id}
                            onClick={() => void act(p.id, confirming.action)}
                          >
                            {busy === p.id
                              ? "Working…"
                              : confirming.action === "publish"
                                ? "Yes, post it"
                                : "Yes, delete it"}
                          </button>
                          <button className="btn btn-sm" disabled={busy === p.id} onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="row wrap">
                        {editable(p) && (
                          <button className="btn btn-sm" onClick={() => setDraft(draftFrom(p))}>
                            Edit
                          </button>
                        )}
                        {editable(p) && (
                          <button className="btn btn-sm" onClick={() => setConfirming({ id: p.id, action: "publish" })}>
                            Publish now
                          </button>
                        )}
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setConfirming({ id: p.id, action: "delete" })}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Said once, plainly, instead of a Votes column full of dashes: no
            endpoint on this API reads poll_votes, so the dashboard genuinely
            cannot show a tally. The posted message can, and does. */}
        <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
          Vote counts aren't available here — no route on this API reads them. The bot renders the live
          tally into the poll message itself, so that message is the place to read results.
        </p>
      </Panel>

      {draft && (
        <Panel eyebrow={draft.id ? "Edit" : "New"} title={draft.id ? "Edit poll" : "Create a poll"}>
          {draft.id && (
            <Banner level="watch" title="Editable only until it's published">
              Once the bot posts this poll the API refuses further edits, because people will already
              have voted against these exact options. Publishing is the point of no return.
            </Banner>
          )}

          <label className="field">
            <span className="eyebrow">Question</span>
            <input
              value={draft.question}
              maxLength={MAX_QUESTION}
              placeholder="Which map should we play on Friday?"
              onChange={(e) => patch({ question: e.target.value })}
            />
            <span className="dim">
              {draft.question.length}/{MAX_QUESTION} characters.
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

          <div className="field">
            <span className="eyebrow">Options</span>
            {draft.options.map((o, i) => (
              <div className="row wrap" key={i}>
                <input
                  value={o.emoji ?? ""}
                  placeholder="🙂"
                  maxLength={8}
                  className="input"
                  style={{ width: 64 }}
                  aria-label={`Emoji for option ${i + 1}`}
                  onChange={(e) => patchOption(i, { emoji: e.target.value })}
                />
                <input
                  value={o.label}
                  maxLength={MAX_LABEL}
                  className="input"
                  style={{ flex: 1, minWidth: 180 }}
                  placeholder={`Option ${i + 1}`}
                  aria-label={`Option ${i + 1}`}
                  onChange={(e) => patchOption(i, { label: e.target.value })}
                />
                <button
                  className="btn btn-sm"
                  disabled={draft.options.length <= MIN_OPTIONS}
                  onClick={() => patch({ options: draft.options.filter((_, at) => at !== i) })}
                  title={
                    draft.options.length <= MIN_OPTIONS
                      ? `A poll needs at least ${MIN_OPTIONS} options`
                      : "Remove this option"
                  }
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="row wrap">
              <button
                className="btn btn-sm"
                disabled={draft.options.length >= MAX_OPTIONS}
                onClick={() => patch({ options: [...draft.options, { label: "" }] })}
              >
                Add option
              </button>
              <span className="dim" style={{ fontSize: 12 }}>
                {filledOptions}/{MAX_OPTIONS} filled in.{" "}
                {draft.options.length >= MAX_OPTIONS
                  ? `That's the cap — a Discord select menu holds ${MAX_OPTIONS}, and the API rejects an eleventh.`
                  : `Between ${MIN_OPTIONS} and ${MAX_OPTIONS}; blank rows are dropped on save.`}
              </span>
            </div>

            {/* Not an error — this poll is valid. It just can't be recreated
                with /poll later, and that surprises people who use both. */}
            {draft.options.length > FAST_PATH_OPTIONS && (
              <span className="dim" style={{ fontSize: 12 }}>
                Past {FAST_PATH_OPTIONS} options this poll can only be made here — the /poll command carries
                nine option fields at most.
              </span>
            )}
          </div>

          <label className="row">
            <input
              type="checkbox"
              checked={draft.allowMultiselect}
              onChange={(e) => patch({ allowMultiselect: e.target.checked })}
            />
            <span>
              <strong>Let voters pick more than one</strong>
              <span className="dim block">
                Off means one choice each, and changing it swaps their vote rather than adding to it.
              </span>
            </span>
          </label>

          <label className="field">
            <span className="eyebrow">Goes up at</span>
            <input
              className="input"
              type="datetime-local"
              value={draft.scheduledForLocal}
              onChange={(e) => patch({ scheduledForLocal: e.target.value })}
            />
            <span className="dim">
              Read in your own timezone ({ZONE}).{" "}
              {scheduledIso
                ? `That's ${absolute(scheduledIso)} — ${formatRelative(scheduledIso)}. The bot checks every 30 seconds, so expect it within a minute of that.`
                : "Leave empty to keep it a draft and publish it by hand."}
            </span>
          </label>

          <label className="field">
            <span className="eyebrow">Closes at</span>
            <input
              className="input"
              type="datetime-local"
              value={draft.closesAtLocal}
              onChange={(e) => patch({ closesAtLocal: e.target.value })}
            />
            <span className="dim">
              Read in your own timezone ({ZONE}).{" "}
              {closesIso
                ? `That's ${absolute(closesIso)} — ${formatRelative(closesIso)}. The bot removes the vote menu then; there's no manual close, so this is the only way a poll ends.`
                : "Leave empty and the poll takes votes indefinitely — there is no manual close button, so it stays open until you delete it."}
            </span>
          </label>

          {scheduledInPast && (
            <Banner level="watch" title="That publish time has already passed">
              The API accepts it, and the bot's next sweep will post the poll within about half a minute.
              Fine if that's what you meant; surprising if you were aiming at next Friday.
            </Banner>
          )}

          {closesBeforeItOpens && (
            <Banner level="act" title="It would close before anyone could vote">
              The close time isn't after the time this poll goes up, so the scheduler would close it on the
              same sweep that posts it. Push the close time later.
            </Banner>
          )}

          {closesWithoutPublish && !closesBeforeItOpens && (
            <Banner level="watch" title="A close time alone doesn't post the poll">
              Only published polls close — a draft with a close time and no publish time just sits there.
              Either set a time above, or publish it from the list before this time arrives.
            </Banner>
          )}

          <div className="actions">
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : draft.id ? "Save" : scheduledIso ? "Schedule" : "Save draft"}
            </button>
            <button className="btn" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
            <span className="dim">Saving posts nothing. Publishing does.</span>
          </div>
        </Panel>
      )}

      <p className="dim" style={{ fontSize: 12, margin: 0 }}>
        Every time on this page is shown in {ZONE}, your browser's timezone. The server stores the exact
        instant, so a poll opens and closes at the same moment for every member wherever they are.
      </p>
    </div>
  );
}
