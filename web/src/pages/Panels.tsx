// web/src/pages/Panels.tsx
//
// A panel is a message the bot posts in a channel with one button per form.
// It is the only part of this console whose output is public: everything else
// here changes what happens next, whereas publishing writes into a channel
// where members are already talking.
//
// That shapes three decisions on this page:
//
//   Publishing is confirmed, and the confirmation names the channel. The
//   common mistake isn't publishing by accident, it's publishing to the wrong
//   channel — which nobody notices until members start applying in #general.
//
//   Saving a published panel is labelled as editing the live message, because
//   that is what it does. The API pushes a sync to the bot on every PATCH of a
//   published panel (api/src/routes/panels.ts), so there is no separate "sync"
//   action to expose and no state where the message on screen and the message
//   in Discord disagree for long.
//
//   The five-button ceiling is explained where it bites rather than enforced
//   silently. Discord allows five buttons in one action row; the API caps
//   `buttons` at five for both display styles, so a dropdown panel — which
//   Discord itself would allow 25 entries in — stops at five too. Someone
//   who knows the Discord limit and hits ours needs to be told which one
//   they've hit.

import { useCallback, useEffect, useState } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";
import {
  ChannelPicker,
  POSTABLE_CHANNEL_TYPES,
  useGuildChannels,
  type GuildChannel,
} from "../components/ChannelPicker";

// --- Shapes, derived from the zod schemas in api/src/routes/panels.ts ---

type ButtonStyle = "primary" | "secondary" | "success" | "danger";
type DisplayType = "buttons" | "dropdown";

interface PanelButtonDTO {
  /** Absent on a button this browser just invented — and absent again after
   *  the next save, because PATCH deletes and re-inserts the whole set. */
  id?: string;
  formId: string;
  label: string;
  emoji: string | null;
  style: ButtonStyle;
  sortOrder: number;
}

interface PanelDTO {
  id: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  color: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  footerText: string | null;
  displayType: DisplayType;
  published: boolean;
  buttons: PanelButtonDTO[];
}

type Draft = Omit<PanelDTO, "id" | "messageId" | "published"> & {
  id?: string;
  messageId?: string | null;
  published?: boolean;
};

/** Only what the button editor needs from a form. */
interface FormSummary {
  id: string;
  name: string;
  kind: "application" | "appeal";
  applicationType: "in_server" | "direct_message";
  active: boolean;
  questions: unknown[];
}

const BUTTON_LIMIT = 5; // Discord: buttons per action row, and the API's own cap
const SELECT_OPTION_LIMIT = 25; // Discord: options in a select menu
const DEFAULT_COLOR = 0x5865f2; // blurple, matching the API's default

const STYLES: { value: ButtonStyle; label: string }[] = [
  { value: "primary", label: "Blurple — the obvious action" },
  { value: "secondary", label: "Grey — secondary" },
  { value: "success", label: "Green" },
  { value: "danger", label: "Red — reads as a warning" },
];

const blankButton = (sortOrder: number): PanelButtonDTO => ({
  formId: "",
  label: "",
  emoji: null,
  style: "primary",
  sortOrder,
});

const blankPanel = (): Draft => ({
  channelId: "",
  title: "",
  description: "",
  color: DEFAULT_COLOR,
  imageUrl: null,
  thumbnailUrl: null,
  footerText: null,
  displayType: "buttons",
  buttons: [],
});

/**
 * Turns a failed request into something a person can act on.
 *
 * `{ error: "invalid_body", detail: <zod flatten object> }` loses its field
 * errors on the way through ApiError, which hands the object to `Error` and
 * gets "[object Object]" back. Repairing that means editing lib/api.ts, so
 * instead: unreadable messages are translated here, and `blockers()` below
 * catches those bodies before they are sent. A 400 arriving here is a gap in
 * `blockers()`, not the ordinary path.
 *
 * `bot_unreachable` and the panel cap (429) do send plain-string details, and
 * both already say the right thing, so they pass through untouched.
 */
function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.message && e.message !== "[object Object]") return e.message;
  if (e.code === "invalid_body") {
    return "The server rejected this panel. Check that the image links are full URLs and every button has a form.";
  }
  if (e.code === "panel_not_found") return "This panel no longer exists — someone else may have deleted it.";
  if (e.code === "bot_unreachable") return "The bot isn't responding, so nothing was sent to Discord.";
  return fallback;
}

/** z.string().url() rejects a bare hostname, and its rejection reaches us
 *  without a field name attached. Cheaper to catch it here. */
function urlProblem(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Discord only loads http and https links.";
    }
    return null;
  } catch {
    return "That isn't a full link — include the https:// part.";
  }
}

/** Everything the API would reject, checked before sending. */
function blockers(d: Draft): string[] {
  const out: string[] = [];
  if (!d.channelId) out.push("Pick a channel to post in.");
  if (!d.title.trim()) out.push("The panel needs a title.");
  if (d.title.length > 256) out.push("Titles are capped at 256 characters.");
  if (d.description.length > 2000) out.push("The description is over Discord's 2000-character limit.");
  if ((d.footerText ?? "").length > 256) out.push("Footers are capped at 256 characters.");
  if (d.buttons.length === 0) out.push("A panel needs at least one form attached — otherwise there's nothing to click.");
  if (d.buttons.length > BUTTON_LIMIT) out.push(`A panel holds at most ${BUTTON_LIMIT} forms.`);
  d.buttons.forEach((b, i) => {
    const at = `Button ${i + 1}`;
    if (!b.formId) out.push(`${at} isn't pointing at a form.`);
    if (!b.label.trim()) out.push(`${at} needs a label.`);
    if (b.label.length > 80) out.push(`${at}'s label is over 80 characters.`);
  });
  for (const [field, value] of [
    ["image", d.imageUrl],
    ["thumbnail", d.thumbnailUrl],
  ] as const) {
    if (value) {
      const problem = urlProblem(value);
      if (problem) out.push(`The ${field} link: ${problem}`);
    }
  }
  return out;
}

export default function Panels({ guildId }: { guildId: string }) {
  const [panels, setPanels] = useState<PanelDTO[] | null>(null);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Ids of the panel a delete, or a publish, has been proposed for. Both put
  // a second, differently-worded button between the intent and the act.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState<string | null>(null);
  // Held here rather than inside the picker so the list above can name the
  // channel each panel posts to, and the publish confirmation can say it out
  // loud. A failure is not fatal — see ChannelPicker's fallback.
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);

  const load = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([
        http.get<PanelDTO[]>(`/api/guilds/${guildId}/panels`),
        http.get<FormSummary[]>(`/api/guilds/${guildId}/forms`),
      ]);
      setPanels(p);
      setForms(f);
    } catch (e) {
      setError(describe(e, "Couldn't load panels."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !panels) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!panels) return <Loading rows={5} />;

  const channelName = (id: string) => {
    const found = channels?.find((c) => c.id === id);
    return found ? `#${found.name}` : id;
  };

  const patch = (next: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setSaved(false);
  };

  async function save() {
    if (!draft) return;
    const problems = blockers(draft);
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        channelId: draft.channelId,
        title: draft.title.trim(),
        description: draft.description,
        color: draft.color,
        // Empty strings fail z.string().url(); null is how the API spells
        // "no image".
        imageUrl: draft.imageUrl || null,
        thumbnailUrl: draft.thumbnailUrl || null,
        footerText: draft.footerText || null,
        displayType: draft.displayType,
        // sortOrder is the on-screen order — there is no separate field to
        // keep in step with the list.
        buttons: draft.buttons.map((b, i) => ({
          formId: b.formId,
          label: b.label.trim(),
          emoji: b.emoji || null,
          style: b.style,
          sortOrder: i,
        })),
      };

      const result = draft.id
        ? await http.patch<PanelDTO>(`/api/guilds/${guildId}/panels/${draft.id}`, body)
        : await http.post<PanelDTO>(`/api/guilds/${guildId}/panels`, body);

      setPanels(
        draft.id ? panels!.map((p) => (p.id === result.id ? result : p)) : [...panels!, result],
      );
      setDraft(result);
      setSaved(true);
      if (result.published) {
        // Worth saying explicitly: the edit has already gone out to a channel
        // people are reading, without a second confirmation.
        setNotice("Saved, and the live message in Discord was updated.");
      }
    } catch (e) {
      setError(describe(e, "Couldn't save this panel."));
    } finally {
      setSaving(false);
    }
  }

  async function publish(id: string) {
    setError(null);
    setNotice(null);
    setConfirmPublish(null);
    try {
      await http.post<{ status: string }>(`/api/guilds/${guildId}/panels/${id}/publish`, {});
      // 202: the API hands the job to the bot and answers immediately, so
      // `published` is still false in the row we're holding. Re-reading the
      // list is the only way to learn whether the message actually went out —
      // flipping the pill optimistically would claim something we don't know.
      setNotice("Sent to the bot. Refresh in a moment to confirm it posted.");
      await load();
    } catch (e) {
      setError(describe(e, "Couldn't publish this panel."));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/panels/${id}`);
      setPanels(panels!.filter((p) => p.id !== id));
      setConfirmDelete(null);
      if (draft?.id === id) setDraft(null);
      setNotice(
        "Deleted here. The message already posted in Discord stays where it is — remove it by hand if you don't want it clicked.",
      );
    } catch (e) {
      setError(describe(e, "Couldn't delete this panel."));
    }
  }

  const pendingDelete = confirmDelete ? panels.find((p) => p.id === confirmDelete) ?? null : null;
  const pendingPublish = confirmPublish ? panels.find((p) => p.id === confirmPublish) ?? null : null;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Panels</h1>
        <p className="dim">
          A message in a channel with a button for each form. This is how most people find an
          application in the first place.
        </p>
      </header>

      {error && (
        <Banner level="act" title="Heads up">
          {error}
        </Banner>
      )}

      {notice && !error && (
        <Banner level="watch" title="Done">
          {notice}
        </Banner>
      )}

      {forms.length === 0 && (
        <Banner level="watch" title="No forms to attach">
          A panel must carry at least one form, so there's nothing to build yet. Create a form
          first.
        </Banner>
      )}

      {pendingDelete && (
        <Banner
          level="act"
          title={`Delete "${pendingDelete.title}"?`}
          action={
            <div className="actions">
              <button className="btn-danger" onClick={() => void remove(pendingDelete.id)}>
                Delete it
              </button>
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Keep it
              </button>
            </div>
          }
        >
          {pendingDelete.published
            ? `This only deletes the panel's settings. The message in ${channelName(pendingDelete.channelId)} stays up and its buttons stop working — delete that message yourself too.`
            : "This panel was never posted, so nothing in Discord changes."}
        </Banner>
      )}

      {pendingPublish && (
        <Banner
          level="act"
          title={`Post this to ${channelName(pendingPublish.channelId)}?`}
          action={
            <div className="actions">
              <button className="btn-primary" onClick={() => void publish(pendingPublish.id)}>
                Post it
              </button>
              <button className="btn" onClick={() => setConfirmPublish(null)}>
                Not yet
              </button>
            </div>
          }
        >
          Everyone who can read that channel will see it, and it will notify anyone watching the
          channel. Check the channel name above — this is the step that's hard to take back.
        </Banner>
      )}

      <Panel
        eyebrow="This server"
        title="Panels"
        action={
          <button
            className="btn"
            disabled={forms.length === 0}
            onClick={() => { setDraft(blankPanel()); setSaved(false); setError(null); }}
          >
            New panel
          </button>
        }
      >
        {panels.length === 0 ? (
          <Empty
            title="No panels yet"
            hint="Build one, point it at a form, then post it to a channel."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Channel</th>
                <th>Style</th>
                <th>Forms</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {panels.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.title}</strong>
                  </td>
                  <td className="dim">{channelName(p.channelId)}</td>
                  <td className="dim">{p.displayType === "dropdown" ? "Dropdown" : "Buttons"}</td>
                  <td className="dim">{p.buttons.length}</td>
                  <td>
                    <Pill level={p.published ? "ok" : "watch"}>
                      {p.published ? "posted" : "draft"}
                    </Pill>
                  </td>
                  <td>
                    <div className="row wrap">
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setDraft({ ...p, buttons: p.buttons.map((b) => ({ ...b })) });
                          setSaved(false);
                          setError(null);
                        }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-sm" onClick={() => setConfirmPublish(p.id)}>
                        {p.published ? "Repost" : "Post"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setConfirmDelete(p.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {draft && (
        <PanelEditor
          key={draft.id ?? "new"}
          draft={draft}
          forms={forms}
          channels={channels}
          channelsFailed={channelsFailed}
          saving={saving}
          saved={saved}
          onPatch={patch}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setError(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

function PanelEditor({
  draft,
  forms,
  channels,
  channelsFailed,
  saving,
  saved,
  onPatch,
  onSave,
  onCancel,
}: {
  draft: Draft;
  forms: FormSummary[];
  channels: GuildChannel[] | null;
  channelsFailed: boolean;
  saving: boolean;
  saved: boolean;
  onPatch: (next: Partial<Draft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const atButtonLimit = draft.buttons.length >= BUTTON_LIMIT;

  const patchButton = (i: number, next: Partial<PanelButtonDTO>) =>
    onPatch({ buttons: draft.buttons.map((b, n) => (n === i ? { ...b, ...next } : b)) });

  const move = (i: number, by: number) => {
    const to = i + by;
    if (to < 0 || to >= draft.buttons.length) return;
    const next = [...draft.buttons];
    [next[i], next[to]] = [next[to], next[i]];
    onPatch({ buttons: next });
  };

  return (
    <>
      <Panel title={draft.id ? "Edit panel" : "New panel"}>
        <ChannelPicker
          channels={channels}
          failed={channelsFailed}
          types={POSTABLE_CHANNEL_TYPES}
          label="Channel"
          value={draft.channelId}
          onChange={(id) => onPatch({ channelId: id })}
          hint={
            draft.published
              ? "Moving a posted panel to another channel doesn't move the message that's already up — repost it and delete the old one."
              : "Where the panel message will be posted."
          }
        />

        <label className="field">
          <span className="eyebrow">Title</span>
          <input
            value={draft.title}
            maxLength={256}
            placeholder="Apply to the team"
            onChange={(e) => onPatch({ title: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="eyebrow">Description</span>
          <textarea
            rows={5}
            value={draft.description}
            maxLength={2000}
            placeholder="What these applications are for, and what happens after someone applies."
            onChange={(e) => onPatch({ description: e.target.value })}
          />
        </label>

        <div className="row wrap">
          <label className="field">
            <span className="eyebrow">Accent colour</span>
            <input
              className="input"
              type="color"
              value={`#${draft.color.toString(16).padStart(6, "0")}`}
              // Stored as an integer because that's what Discord's embed API
              // takes; the picker is the only place a hex string exists.
              onChange={(e) => onPatch({ color: parseInt(e.target.value.slice(1), 16) })}
            />
          </label>

          <label className="field">
            <span className="eyebrow">Layout</span>
            <select
              value={draft.displayType}
              onChange={(e) => onPatch({ displayType: e.target.value as DisplayType })}
            >
              <option value="buttons">Buttons in a row</option>
              <option value="dropdown">A dropdown menu</option>
            </select>
          </label>
        </div>

        {draft.displayType === "dropdown" && (
          <span className="dim">
            Discord dropdowns hold {SELECT_OPTION_LIMIT} entries, but a panel is capped at{" "}
            {BUTTON_LIMIT} forms either way — the limit you'll hit here is ours, not Discord's.
          </span>
        )}

        <UrlField
          label="Large image"
          value={draft.imageUrl}
          onChange={(v) => onPatch({ imageUrl: v })}
          hint="Shown full-width under the text. Discord fetches it every time the message is loaded, so link somewhere that will still be up next year."
        />

        <UrlField
          label="Thumbnail"
          value={draft.thumbnailUrl}
          onChange={(v) => onPatch({ thumbnailUrl: v })}
          hint="Small image in the top-right corner — usually a server logo."
        />

        <label className="field">
          <span className="eyebrow">Footer</span>
          <input
            value={draft.footerText ?? ""}
            maxLength={256}
            placeholder="Applications are reviewed within 48 hours."
            onChange={(e) => onPatch({ footerText: e.target.value || null })}
          />
        </label>
      </Panel>

      <Panel
        title="Forms on this panel"
        eyebrow={`${draft.buttons.length} of ${BUTTON_LIMIT}`}
        action={
          <button
            className="btn"
            disabled={atButtonLimit || forms.length === 0}
            onClick={() => onPatch({ buttons: [...draft.buttons, blankButton(draft.buttons.length)] })}
          >
            Attach a form
          </button>
        }
      >
        {atButtonLimit && (
          <Banner level="watch" title={`${BUTTON_LIMIT} is the ceiling`}>
            Discord fits {BUTTON_LIMIT} buttons in one row, and the API holds both layouts to the
            same number. For more than {BUTTON_LIMIT} forms, post a second panel — a second
            message in the same channel works fine.
          </Banner>
        )}

        {draft.buttons.length === 0 && (
          <Empty
            title="Nothing attached"
            hint="A panel with no forms can't be saved — attach at least one."
          />
        )}

        {draft.buttons.map((b, i) => (
          <ButtonEditor
            key={b.id ?? `new-${i}`}
            index={i}
            total={draft.buttons.length}
            button={b}
            forms={forms}
            published={Boolean(draft.published)}
            onPatch={(next) => patchButton(i, next)}
            onMove={(by) => move(i, by)}
            onRemove={() => onPatch({ buttons: draft.buttons.filter((_, n) => n !== i) })}
          />
        ))}
      </Panel>

      <div className="actions">
        <button className="btn-primary" onClick={onSave} disabled={saving}>
          {saving
            ? "Saving…"
            : draft.published
              ? "Save and update the live message"
              : draft.id
                ? "Save"
                : "Create panel"}
        </button>
        <button className="btn" onClick={onCancel} disabled={saving}>
          {draft.id ? "Close" : "Discard"}
        </button>
        {saved && <span className="dim">Saved.</span>}
        {draft.published && !saving && (
          <span className="dim">
            This panel is live, so saving edits the message people are already looking at.
          </span>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * One attached form
 * ------------------------------------------------------------------ */

function ButtonEditor({
  index,
  total,
  button,
  forms,
  published,
  onPatch,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  button: PanelButtonDTO;
  forms: FormSummary[];
  published: boolean;
  onPatch: (next: Partial<PanelButtonDTO>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  // Detaching from a draft costs nothing, so it happens on the click. On a
  // published panel the same click removes a way in that members can see
  // right now, which deserves the extra beat.
  const [confirming, setConfirming] = useState(false);

  const form = forms.find((f) => f.id === button.formId) ?? null;

  return (
    <Panel className="stack">
      <div className="row spread wrap">
        <span className="eyebrow">Button {index + 1}</span>
        <div className="row">
          <button className="btn btn-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            ↑
          </button>
          <button
            className="btn btn-sm"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            aria-label="Move down"
          >
            ↓
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => (published ? setConfirming(true) : onRemove())}
          >
            Detach
          </button>
        </div>
      </div>

      {confirming && (
        <Banner
          level="act"
          title="Detach this form?"
          action={
            <div className="actions">
              <button className="btn-danger" onClick={onRemove}>
                Detach
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          }
        >
          This panel is live. Saving after this removes the button from the message in Discord,
          and anyone mid-application through it keeps their draft but loses the way back in.
        </Banner>
      )}

      <label className="field">
        <span className="eyebrow">Form</span>
        <select
          value={button.formId}
          onChange={(e) => {
            const formId = e.target.value;
            const picked = forms.find((f) => f.id === formId);
            // Prefill the label from the form's name only while the label is
            // still untouched — the label is what members read, and most
            // people want it to say the same thing.
            onPatch(
              picked && !button.label.trim()
                ? { formId, label: picked.name.slice(0, 80) }
                : { formId },
            );
          }}
        >
          <option value="">— pick a form —</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      {/* Both of these produce a button that exists, is clickable, and does
          nothing useful — which is why they're stated here and not left to
          be discovered by a member. */}
      {form && !form.active && (
        <Banner level="act" title={`"${form.name}" is switched off`}>
          The button will appear and answer "this form is no longer available." Activate the form,
          or attach a different one.
        </Banner>
      )}

      {form && form.kind === "appeal" && (
        <Banner level="act" title="An appeal form doesn't belong on a panel">
          Appeal forms exist for people who are banned, and a banned member can't see this channel
          at all. Point the ban-appeal settings at it instead.
        </Banner>
      )}

      {form && form.questions.length === 0 && (
        <Banner level="watch" title={`"${form.name}" asks nothing`}>
          A form with no questions can't open a pop-up in Discord, so the button will fail. Add a
          question to the form first.
        </Banner>
      )}

      <label className="field">
        <span className="eyebrow">Label</span>
        <input
          value={button.label}
          maxLength={80}
          placeholder="Apply"
          onChange={(e) => onPatch({ label: e.target.value })}
        />
        <span className="dim">
          What members read on the button. Short wins — long labels squeeze the buttons beside
          them.
        </span>
      </label>

      <div className="row wrap">
        <label className="field">
          <span className="eyebrow">Emoji</span>
          <input
            value={button.emoji ?? ""}
            maxLength={64}
            placeholder="📝"
            onChange={(e) => onPatch({ emoji: e.target.value || null })}
          />
          <span className="dim">
            A standard emoji, or a custom one as &lt;:name:id&gt;. Custom emoji only render if the
            bot shares a server with them.
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Colour</span>
          <select
            value={button.style}
            onChange={(e) => onPatch({ style: e.target.value as ButtonStyle })}
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Small fields
 * ------------------------------------------------------------------ */

function UrlField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  hint?: string;
}) {
  // Validated as you type rather than on save, because the API's rejection
  // arrives with no field attached and this is the field it usually means.
  const problem = value ? urlProblem(value) : null;
  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <input
        value={value ?? ""}
        placeholder="https://…"
        onChange={(e) => onChange(e.target.value || null)}
      />
      {problem ? <span className="dim">{problem}</span> : hint && <span className="dim">{hint}</span>}
    </label>
  );
}

