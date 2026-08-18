// web/src/pages/StickyMessages.tsx
//
// A message the bot keeps at the bottom of a channel — rules, an invite, a
// pointer to the FAQ. Discord has no "pin to bottom", so the bot deletes its
// previous copy and sends a fresh one once enough other messages have buried
// it (see stickyMessageService.ts).
//
// Two things about that mechanism drive this whole screen, because both are
// invisible from the data and both get reported as bugs:
//
//   1. "Off" does not take the message down. Deactivating stops the reposts;
//      the copy already sitting in the channel stays exactly where it is,
//      forever, until someone deletes it in Discord. Same for deleting the
//      sticky here.
//
//   2. Reposting is not instant. Creating one, or editing its text while it's
//      active, posts immediately — but merely switching it back on does not.
//      It reappears once the channel has seen `repostAfterMessages` more
//      messages, which in a quiet channel can be days.
//
// One sticky per channel is a unique constraint on the column, not a rule of
// this page: the API answers a duplicate create with 409, and a duplicate
// edit would reach the database as a 500. So the collision is checked here
// before either can happen.

import { useEffect, useState, useCallback } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";

const MIN_REPOST = 1;
const MAX_REPOST = 100;

interface StickyDTO {
  id: string;
  guildId: string;
  channelId: string;
  content: string;
  repostAfterMessages: number;
  active: boolean;
}

interface Draft {
  /** Absent until the server has stored it. */
  id?: string;
  channelId: string;
  content: string;
  repostAfterMessages: number;
  active: boolean;
}

interface GuildChannel {
  id: string;
  name: string;
}

const blankDraft = (): Draft => ({
  channelId: "",
  content: "",
  repostAfterMessages: 5,
  active: true,
});

/**
 * The API answers a rejected body with { error: "invalid_body", detail: <zod
 * flatten> }; lib/api.ts hands `detail` to Error, which turns an object into
 * "[object Object]" before it gets here, so that code gets its own words.
 * The 409 sends a written sentence and is worth showing verbatim.
 */
function apiMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === "invalid_body") {
    return `The server rejected this. The message has to be between 1 and 2000 characters, and the repost count between ${MIN_REPOST} and ${MAX_REPOST}.`;
  }
  if (e.code === "sticky_not_found") {
    return "That sticky is gone — someone else deleted it while this page was open.";
  }
  return e.message || fallback;
}

export default function StickyMessages({ guildId }: { guildId: string }) {
  const [stickies, setStickies] = useState<StickyDTO[] | null>(null);
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [channelsFailed, setChannelsFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStickies(await http.get<StickyDTO[]>(`/api/guilds/${guildId}/sticky-messages`));
    } catch (e) {
      setError(apiMessage(e, "Couldn't load sticky messages."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Separate failure from the list itself: the bot being unreachable turns
  // the picker into an ID field, it doesn't take the page down.
  useEffect(() => {
    http
      .get<GuildChannel[]>(`/api/guilds/${guildId}/resources/channels`)
      .then(setChannels)
      .catch(() => setChannelsFailed(true));
  }, [guildId]);

  if (error && !stickies) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!stickies) return <Loading rows={3} />;

  const channelName = (id: string) => {
    const c = channels?.find((x) => x.id === id);
    return c ? `#${c.name}` : id;
  };

  function problemsWith(d: Draft): string[] {
    const out: string[] = [];
    if (!d.channelId) out.push("Pick a channel.");
    if (!d.content.trim()) out.push("Write the message.");
    if (d.content.length > 2000) out.push("Discord's limit is 2000 characters.");
    if (
      !Number.isInteger(d.repostAfterMessages) ||
      d.repostAfterMessages < MIN_REPOST ||
      d.repostAfterMessages > MAX_REPOST
    ) {
      out.push(`Repost after has to be a whole number between ${MIN_REPOST} and ${MAX_REPOST}.`);
    }
    // The column is unique, so this is a 409 on create and a database error
    // on edit. Catching it here is the difference between a sentence and a
    // stack trace. Only covers this guild's stickies — a channel claimed by
    // another guild is impossible from here, and the 409 handles it.
    const clash = (stickies ?? []).find((s) => s.channelId === d.channelId && s.id !== d.id);
    if (clash) {
      out.push(`${channelName(d.channelId)} already has a sticky. Edit that one instead.`);
    }
    return out;
  }

  async function saveDraft() {
    if (!draft) return;
    if (problemsWith(draft).length > 0) return;

    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const body = {
        channelId: draft.channelId,
        content: draft.content,
        repostAfterMessages: draft.repostAfterMessages,
        active: draft.active,
      };

      if (draft.id) {
        const before = stickies?.find((s) => s.id === draft.id);
        await http.patch<StickyDTO>(`/api/guilds/${guildId}/sticky-messages/${draft.id}`, body);
        // Only a content change on an active sticky reposts straight away.
        // Turning one back on waits for the channel to get busy again, and
        // people read that silence as a broken save.
        const reposted = draft.active && before?.content !== draft.content;
        setNotice(
          !draft.active
            ? "Saved, and it's switched off. Any copy already in the channel stays there until you delete it in Discord."
            : reposted
              ? `Saved and re-posted to ${channelName(draft.channelId)}.`
              : `Saved. It moves to the bottom of ${channelName(draft.channelId)} after the next ${draft.repostAfterMessages} messages.`,
        );
      } else {
        await http.post<StickyDTO>(`/api/guilds/${guildId}/sticky-messages`, body);
        setNotice(
          draft.active
            ? `Created and posted to ${channelName(draft.channelId)}.`
            : "Created, but switched off — nothing is posted until you turn it on.",
        );
      }
      setDraft(null);
      await load();
    } catch (e) {
      setError(apiMessage(e, "Couldn't save."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(`delete:${id}`);
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/sticky-messages/${id}`);
      setConfirmDelete(null);
      if (draft?.id === id) setDraft(null);
      setNotice("Deleted. The last copy is still in the channel — take it down in Discord.");
      await load();
    } catch (e) {
      setError(apiMessage(e, "Couldn't delete."));
    } finally {
      setBusy(null);
    }
  }

  const editing = draft !== null;
  const problems = draft ? problemsWith(draft) : [];
  const inactive = stickies.filter((s) => !s.active).length;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Sticky messages</h1>
        <p className="dim">
          A message the bot keeps at the bottom of a channel by re-posting it once other
          messages have buried it. One per channel.
        </p>
      </header>

      {channelsFailed && (
        <Banner level="watch" title="Can't list channels">
          The bot didn't answer, so the picker below is an ID field. Saving still works; posting
          doesn't, until the bot is back.
        </Banner>
      )}

      {inactive > 0 && (
        <Banner level="watch" title={`${inactive} switched off`}>
          Off means the bot stops re-posting — it doesn't remove the copy already sitting in the
          channel. If one shouldn't be there, delete that message in Discord.
        </Banner>
      )}

      {error && <Banner level="act" title="Something went wrong">{error}</Banner>}
      {notice && !error && <Banner level="watch" title="Done">{notice}</Banner>}

      {!editing && (
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setDraft(blankDraft())}>
            New sticky
          </button>
        </div>
      )}

      {editing && draft && (
        <Panel title={draft.id ? "Editing sticky" : "New sticky"}>
          <ChannelField
            label="Channel"
            value={draft.channelId}
            channels={channels}
            failed={channelsFailed}
            taken={stickies.filter((s) => s.id !== draft.id).map((s) => s.channelId)}
            onChange={(channelId) => setDraft({ ...draft, channelId })}
          />

          <label className="field">
            <span className="eyebrow">Message</span>
            <textarea
              rows={5}
              maxLength={2000}
              value={draft.content}
              placeholder="Read #rules before posting. Support goes in #help, not here."
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
            <span className="dim">
              Plain text, sent as the bot. {draft.content.length} / 2000
            </span>
          </label>

          <label className="field">
            <span className="eyebrow">Re-post after this many messages</span>
            {/* Text rather than number: only text inputs carry this console's
                field styling, and the value is validated either way. */}
            <input
              inputMode="numeric"
              value={String(draft.repostAfterMessages)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  repostAfterMessages: Number(e.target.value.replace(/\D/g, "")) || 0,
                })
              }
            />
            <span className="dim">
              Between {MIN_REPOST} and {MAX_REPOST}. Low numbers in a busy channel mean the bot
              deletes and re-sends constantly, which reads as spam and burns rate limit —{" "}
              {MIN_REPOST} re-posts after every single message. 5 to 10 suits most channels.
            </span>
          </label>

          <label className="row">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
            />
            <span>
              <strong>Active</strong>
              <span className="dim block">
                Off stops the re-posting and nothing else — the copy already in the channel
                stays until someone deletes it by hand.
              </span>
            </span>
          </label>

          {problems.length > 0 && (
            <Banner level="act" title="Fix these before saving">
              {problems.join(" ")}
            </Banner>
          )}

          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy === "save" || problems.length > 0}
              onClick={saveDraft}
            >
              {busy === "save" ? "Saving…" : draft.id ? "Save changes" : "Create sticky"}
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </Panel>
      )}

      {stickies.length === 0 && !editing && (
        <Empty
          title="No sticky messages yet"
          hint="Add one to keep the rules, or a pointer to the right channel, at the bottom of a busy channel."
        />
      )}

      {stickies.map((s) => {
        const missingChannel =
          channels !== null && !channels.some((c) => c.id === s.channelId);
        return (
          <Panel
            key={s.id}
            title={channelName(s.channelId)}
            eyebrow={`Re-posts after ${s.repostAfterMessages} message${s.repostAfterMessages === 1 ? "" : "s"}`}
            action={<Pill level={s.active ? "ok" : "watch"}>{s.active ? "Active" : "Off"}</Pill>}
          >
            <p className="appeal-body">{s.content}</p>

            {missingChannel && (
              <Banner level="act" title="I can't see that channel">
                It was deleted, or I lost access to it. Nothing has been posted since — point
                this at another channel or delete it.
              </Banner>
            )}

            {!s.active && (
              <Banner level="watch" title="Switched off">
                Not being re-posted. Whatever was last sent is still sitting in the channel.
              </Banner>
            )}

            {confirmDelete === s.id ? (
              <Banner
                level="act"
                title={`Delete the sticky in ${channelName(s.channelId)}?`}
                action={
                  <div className="actions">
                    <button
                      className="btn btn-danger"
                      disabled={busy === `delete:${s.id}`}
                      onClick={() => remove(s.id)}
                    >
                      {busy === `delete:${s.id}` ? "Deleting…" : "Delete it"}
                    </button>
                    <button className="btn" onClick={() => setConfirmDelete(null)}>
                      Keep it
                    </button>
                  </div>
                }
              >
                The text goes with it and can't be recovered from here. The copy currently in
                the channel is not removed — delete that message in Discord too, or it stays up
                with nothing maintaining it.
              </Banner>
            ) : (
              <div className="actions">
                <button
                  className="btn"
                  onClick={() =>
                    setDraft({
                      id: s.id,
                      channelId: s.channelId,
                      content: s.content,
                      repostAfterMessages: s.repostAfterMessages,
                      active: s.active,
                    })
                  }
                >
                  Edit
                </button>
                <button className="btn btn-danger" onClick={() => setConfirmDelete(s.id)}>
                  Delete
                </button>
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/** Same fallback rule as RolePicker: when the bot can't be reached, degrade
 *  to a raw ID rather than blocking the edit. Channels that already hold a
 *  sticky are marked rather than hidden — hiding one makes the picker look
 *  broken to someone who knows the channel exists. */
function ChannelField({
  label,
  value,
  channels,
  failed,
  taken,
  onChange,
}: {
  label: string;
  value: string;
  channels: GuildChannel[] | null;
  failed: boolean;
  taken: string[];
  onChange: (id: string) => void;
}) {
  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value}
          placeholder="Channel ID"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </label>
    );
  }
  const missing = value !== "" && channels !== null && !channels.some((c) => c.id === value);
  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <select value={value} disabled={channels === null} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick a channel —</option>
        {missing && <option value={value}>Unknown channel ({value})</option>}
        {(channels ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
            {taken.includes(c.id) ? " — already has one" : ""}
          </option>
        ))}
      </select>
      {channels === null && <span className="dim">Loading channels…</span>}
    </label>
  );
}
