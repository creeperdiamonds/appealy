// web/src/pages/Tickets.tsx
//
// Ticket types: each one is a panel with a button, and a rule for what the
// button creates.
//
// Following AppealConfig's lead, the point of this screen isn't the CRUD —
// it's the configurations the API accepts and the bot then does something
// unwanted with. Tickets have more of these than appeals do, because closing
// a private ticket channel *deletes* it (bot/src/services/ticketService.ts),
// so several settings that look like preferences are actually about whether a
// conversation survives:
//
//   1. transcriptOnClose ("Keep closed tickets") off on a private channel.
//      Closing deletes the channel, and the conversation with it. Appealy
//      doesn't copy conversations out (no Message Content intent since
//      2026-11-10), so keeping the channel read-only is the only record.
//   2. No support roles on a private channel. The permission overwrites grant
//      the opener and each support role; with none, staff literally cannot
//      see the ticket they were opened for. Only Administrators, who bypass
//      overwrites, get in.
//   3. No support roles AND creatorCanClose off. canManageTicket falls back
//      to Administrator, so nobody else can close anything — tickets pile up
//      with no way to end them.
//   4. Ping roles that aren't support roles. They get mentioned into a
//      channel they can't open.
//
// None of these produce an error. Each one produces a ticket system that
// looks like it's working right up until it matters.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill, GuideLink } from "../components/ui";
import { RolePicker } from "../components/RolePicker";
import { NotAnId } from "../components/IdFields";
import {
  OptionalChannelPicker,
  useGuildChannels,
  type GuildChannel,
} from "../components/ChannelPicker";

/* ------------------------------------------------------------------ *
 * Shapes, derived from api/src/routes/tickets.ts
 * ------------------------------------------------------------------ */

type ChannelType = "private_channel" | "private_thread" | "public_thread";
type LeaveAction = "none" | "close" | "notify";

interface TicketQuestion {
  label: string;
  paragraph: boolean;
  required: boolean;
}

/** One button on the panel. Empty / null fields inherit from the ticket type. */
interface TicketCategory {
  id?: string;
  label: string;
  emoji: string | null;
  description: string | null;
  discordCategoryId: string | null;
  supportRoleIds: string[];
  pingRoleIds: string[];
  welcomeMessage: string | null;
  questions: TicketQuestion[];
}

// Discord's limits: 25 buttons on a message, 5 inputs in a pop-up, 45 characters
// in an input's label.
const MAX_CATEGORIES = 25;
const MAX_QUESTIONS = 5;

const blankCategory = (): TicketCategory => ({
  label: "",
  emoji: null,
  description: null,
  discordCategoryId: null,
  supportRoleIds: [],
  pingRoleIds: [],
  welcomeMessage: null,
  questions: [],
});

interface TicketConfigDTO {
  id: string;
  guildId: string;
  name: string;
  buttonLabel: string;
  buttonEmoji: string | null;
  channelId: string;
  categoryId: string | null;
  channelType: ChannelType;
  supportRoleIds: string[];
  pingRoleIds: string[];
  panelMessage: string;
  welcomeMessage: string;
  ticketNameFormat: string;
  maxOpenPerUser: number;
  leaveAction: LeaveAction;
  transcriptOnClose: boolean;
  transcriptChannelId: string | null;
  creatorCanClose: boolean;
  claimingEnabled: boolean;
  ratingEnabled: boolean;
  active: boolean;
  categories: TicketCategory[];
}

/** An unsaved config has no id yet; everything else is the POST body. */
type Draft = Omit<TicketConfigDTO, "id" | "guildId"> & { id?: string };

/** Mirrors the zod defaults in the router, so "create" writes what's shown. */
const blank = (): Draft => ({
  name: "",
  buttonLabel: "Open Ticket",
  buttonEmoji: null,
  channelId: "",
  categoryId: null,
  channelType: "private_channel",
  supportRoleIds: [],
  pingRoleIds: [],
  panelMessage: "Click below to open a ticket.",
  welcomeMessage: "Thanks for opening a ticket. A member of staff will be with you shortly.",
  ticketNameFormat: "ticket-{username}",
  maxOpenPerUser: 1,
  leaveAction: "none",
  transcriptOnClose: true,
  transcriptChannelId: null,
  creatorCanClose: true,
  claimingEnabled: false,
  ratingEnabled: false,
  active: true,
  categories: [],
});

const toDraft = (c: TicketConfigDTO): Draft => {
  const { guildId: _guildId, ...rest } = c;
  return rest;
};

/* ------------------------------------------------------------------ *
 * Errors
 *
 * The API answers {error, detail}. lib/api.ts folds detail into ApiError's
 * message, but a 400's detail is a zod flatten() — an object, which String()s
 * to "[object Object]". So the code is what carries meaning most of the time,
 * and printing a code at somebody isn't an error message. Named here instead,
 * and the field checks below try to make invalid_body unreachable in the
 * first place rather than translating it after the fact.
 * ------------------------------------------------------------------ */

const CODES: Record<string, string> = {
  invalid_body: "The server rejected these values. Check name (1–100 characters), button label (1–80), welcome message (1000 max), name format (100 max), and that a panel channel is picked.",
  config_not_found: "That ticket type no longer exists — someone else may have deleted it. Reload to see the current list.",
  bot_unreachable: "The bot didn't answer, so the panel wasn't posted. It's probably restarting; the config itself is unchanged.",
  admin_access_required: "Changing ticket types needs Administrator on this server. You can look, but not save.",
  insufficient_permissions: "You don't have access to this server's settings.",
  permission_check_unavailable: "Discord was unreachable, so we couldn't confirm your permissions. Try again shortly.",
};

function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const known = CODES[e.code];
  if (known) return known;
  return e.message && e.message !== "[object Object]" ? e.message : fallback;
}

/* ------------------------------------------------------------------ *
 * Where a ticket lives
 *
 * Presented as a real choice with real consequences rather than three enum
 * values, because the three differ on privacy, on Discord's channel limit,
 * and — the part nobody expects — on whether closing destroys the history.
 * ------------------------------------------------------------------ */

const CHANNEL_TYPES: { value: ChannelType; label: string; detail: string }[] = [
  {
    value: "private_channel",
    label: "Private channel",
    detail:
      "A new text channel, visible only to the opener and the support roles below. The most private option. Closing locks it read-only, or deletes it if Keep closed tickets is off. Every open ticket also counts against Discord's 500-channel guild limit.",
  },
  {
    value: "private_thread",
    label: "Private thread",
    detail:
      "A thread under the panel channel, hidden from the channel's other members. Costs no channel slots and closing only archives it, so history survives. Support roles get no permission overwrite here — access follows Discord's thread rules, so staff need Manage Threads or an explicit invite to see one. Requires private threads to be available on your server.",
  },
  {
    value: "public_thread",
    label: "Public thread",
    detail:
      "A thread anyone who can see the panel channel can read. Not private — the support roles below decide who can act on a ticket, not who can read it. Right for a public help desk, wrong for reports and appeals.",
  },
];

const LEAVE_ACTIONS: { value: LeaveAction; label: string; detail: string }[] = [
  { value: "none", label: "Leave it open", detail: "The ticket stays exactly as it is. Staff decide what to do with it." },
  { value: "notify", label: "Post a notice in the ticket", detail: "Staff get a message in the ticket saying the opener left, and the ticket stays open." },
  { value: "close", label: "Close the ticket", detail: "Closes automatically. With Keep closed tickets off, a private channel is deleted, and the conversation with it." },
];

/* ------------------------------------------------------------------ *
 * Problems
 *
 * One function, so the badge on the list and the banners in the editor can
 * never disagree about whether a config is broken. Computed from the draft,
 * not the saved row, so the warning appears as you create the state rather
 * than after you've saved it.
 * ------------------------------------------------------------------ */

interface Problem {
  key: string;
  level: "watch" | "act";
  title: string;
  body: string;
}

function problemsFor(c: Draft): Problem[] {
  const out: Problem[] = [];
  const isChannel = c.channelType === "private_channel";
  const noStaff = c.supportRoleIds.length === 0;

  if (!c.transcriptOnClose && isChannel) {
    out.push({
      key: "conversation-deleted",
      level: c.leaveAction === "close" ? "act" : "watch",
      title: "Closed tickets are deleted",
      body: `With "Keep closed tickets" off, closing a private channel deletes it, and nobody keeps the conversation.${
        c.leaveAction === "close"
          ? " And with tickets set to close when the opener leaves, that happens without anyone clicking anything."
          : ""
      }`,
    });
  }

  if (noStaff) {
    out.push(
      isChannel
        ? {
            key: "no-staff-channel",
            level: "act",
            title: "Staff can't see these tickets",
            body: "A private channel denies @everyone and allows the opener plus each support role. With no support roles, the only people who can open a ticket are Administrators, who bypass permissions. Everyone else sees nothing at all.",
          }
        : {
            key: "no-staff-thread",
            level: "watch",
            title: "Nobody is designated staff",
            body: "Support roles are who may claim and close a ticket. With none set, only Administrators can act on one.",
          },
    );
  }

  if (noStaff && !c.creatorCanClose) {
    out.push({
      key: "nobody-can-close",
      level: "act",
      title: "Nobody can close a ticket",
      body: "The opener isn't allowed to, and there are no support roles to allow instead — so every ticket stays open until an Administrator closes it by hand. On private channels that's an open channel per ticket, forever.",
    });
  }

  const pingedNonStaff = c.pingRoleIds.filter((id) => !c.supportRoleIds.includes(id));
  if (pingedNonStaff.length > 0 && isChannel) {
    out.push({
      key: "ping-blind",
      level: "watch",
      title: `${pingedNonStaff.length === 1 ? "A role is" : `${pingedNonStaff.length} roles are`} pinged but can't read the ticket`,
      body: "Ping roles are mentioned in the ticket's first message; support roles are who gets permission to see it. These are pinged into a channel that's invisible to them — they'll get a notification and a dead link.",
    });
  }

  if (!isChannel && c.categoryId) {
    out.push({
      key: "category-ignored",
      level: "watch",
      title: "The category is ignored",
      body: "Categories only apply to private channels. Threads are always created under the panel channel, so this setting does nothing here.",
    });
  }

  if (isChannel && !c.categoryId) {
    out.push({
      key: "no-category",
      level: "watch",
      title: "Tickets will appear at the top of the channel list",
      body: "With no category, every new ticket channel lands loose in the sidebar above your real channels. Not broken, but it gets loud fast.",
    });
  }

  if (!c.ticketNameFormat.includes("{username}")) {
    out.push({
      key: "same-name",
      level: "watch",
      title: "Every ticket gets the same name",
      body: "{username} is the only placeholder the bot fills in. Without it, all tickets from this type are named identically and telling them apart means opening each one.",
    });
  } else if (/\{(?!username\})[a-z_]+\}/i.test(c.ticketNameFormat)) {
    out.push({
      key: "dead-placeholder",
      level: "watch",
      title: "That placeholder isn't substituted",
      body: "Only {username} is replaced. Anything else in braces is used literally, braces and all, as part of the channel name.",
    });
  }

  if (!c.active) {
    out.push({
      key: "inactive",
      level: "watch",
      title: "This type is inactive",
      body: "The panel and its button stay wherever you posted them, and clicking the button does nothing. Delete the panel message too, or people will keep trying.",
    });
  }

  return out;
}

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

export default function Tickets({ guildId }: { guildId: string }) {
  const [configs, setConfigs] = useState<TicketConfigDTO[] | null>(null);
  // One request for the page: two fields use it, and the list above names the
  // channel each config posts its panel to.
  const { channels, failed: channelsFailed } = useGuildChannels(guildId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Exactly one config is open at a time. Rendering every editor at once would
  // also mount a RolePicker per config, each fetching the role list — enough
  // requests on a busy server to trip the API's own per-minute cap.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TicketConfigDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState<TicketConfigDTO | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await http.get<TicketConfigDTO[]>(`/api/guilds/${guildId}/ticket-configs`);
      setConfigs(list);
    } catch (e) {
      setLoadError(describe(e, "Couldn't load ticket types."));
      return;
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && !configs) {
    return (
      <Banner level="act" title="Couldn't load">
        {loadError}
      </Banner>
    );
  }
  if (!configs) return <Loading rows={4} />;

  const patch = (next: Partial<Draft>) => draft && setDraft({ ...draft, ...next });

  async function save() {
    if (!draft) return;

    // Mirrors the router's zod schema. Its 400 detail is a flatten() object
    // that never reaches us as text (see describe), so the useful place to
    // catch a bad value is before it's sent.
    const name = draft.name.trim();
    if (!name) return setError("This ticket type needs a name — it's the title on the panel.");
    if (!draft.buttonLabel.trim()) return setError("The button needs a label. Discord won't render a blank one.");
    if (!draft.channelId) return setError("Pick a channel for the panel. That's where the button lives.");
    for (const [i, c] of draft.categories.entries()) {
      const where = `Category ${i + 1}`;
      if (!c.label.trim()) return setError(`${where} needs a label — it's the text on its button.`);
      if (c.questions.some((q) => !q.label.trim())) {
        return setError(`${where} has a question with no text. Fill it in or remove it.`);
      }
    }

    setSaving(true);
    setError(null);
    try {
      const body = { ...draft, name };
      const saved = draft.id
        ? await http.patch<TicketConfigDTO>(
            `/api/guilds/${guildId}/ticket-configs/${draft.id}`,
            body,
          )
        : await http.post<TicketConfigDTO>(`/api/guilds/${guildId}/ticket-configs`, body);
      setConfigs(
        draft.id
          ? configs!.map((c) => (c.id === saved.id ? saved : c))
          : [...configs!, saved],
      );
      setDraft(toDraft(saved));
      setNotice(draft.id ? "Saved." : "Created. Post its panel to make the button appear.");
    } catch (e) {
      setError(describe(e, "Couldn't save."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(config: TicketConfigDTO) {
    setDeleting(true);
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/ticket-configs/${config.id}`);
      setConfigs(configs!.filter((c) => c.id !== config.id));
      if (draft?.id === config.id) setDraft(null);
      setNotice(`Deleted “${config.name}”. Its panel message is still in the channel — remove it by hand.`);
    } catch (e) {
      setError(describe(e, "Couldn't delete."));
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  }

  async function publish(config: TicketConfigDTO) {
    setPublishing(true);
    setError(null);
    try {
      await http.post<{ status: string }>(
        `/api/guilds/${guildId}/ticket-configs/${config.id}/publish`,
        {},
      );
      setNotice(`Panel posted to the channel set on “${config.name}”.`);
    } catch (e) {
      setError(describe(e, "Couldn't post the panel."));
    } finally {
      setPublishing(false);
      setConfirmPublish(null);
    }
  }

  const channelName = (id: string | null) => {
    if (!id) return null;
    const found = channels?.find((c) => c.id === id);
    return found ? `#${found.name}` : null;
  };

  const worst = (list: Problem[]) => (list.some((p) => p.level === "act") ? "act" : "watch");

  // Every broken config in the guild, so someone who opens this page sees that
  // something is wrong before they've decided which type to look at.
  const totalActs = configs.reduce(
    (n, c) => n + problemsFor(toDraft(c)).filter((p) => p.level === "act").length,
    0,
  );

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Tickets</h1>
        <p className="dim">
          Each type is a button on a panel and a rule for what it opens. Closed tickets are kept
          read-only unless you turn that off, so the settings about keeping tickets and who can
          close are about whether a conversation still exists tomorrow.
          {" "}<GuideLink slug="tickets" />
        </p>
      </header>

      {totalActs > 0 && (
        <Banner level="act" title={`${totalActs} setting${totalActs === 1 ? "" : "s"} that won't do what it says`}>
          Marked on the types below. Each one is a configuration the server accepted and the bot
          will follow exactly — they just don't produce the outcome the setting describes.
        </Banner>
      )}

      {notice && (
        <Banner level="watch" title="Done">
          {notice}
        </Banner>
      )}

      <Panel
        title="Ticket types"
        action={
          <button className="btn btn-sm" onClick={() => { setDraft(blank()); setError(null); setNotice(null); }}>
            New type
          </button>
        }
      >
        {configs.length === 0 && (
          <Empty
            title="No ticket types yet"
            hint="Create one, then post its panel so members have a button to press."
          />
        )}

        {configs.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Opens as</th>
                  <th>Panel in</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {configs.map((c) => {
                  const problems = problemsFor(toDraft(c));
                  return (
                    <tr key={c.id}>
                      <td data-cell="head">
                        <strong>{c.name}</strong>
                        <span className="dim block">
                          {c.buttonEmoji ? `${c.buttonEmoji} ` : ""}
                          {c.buttonLabel}
                        </span>
                      </td>
                      <td data-label="Opens as" className="dim">
                        {CHANNEL_TYPES.find((t) => t.value === c.channelType)?.label ?? c.channelType}
                      </td>
                      <td data-label="Panel in" className="dim mono">{channelName(c.channelId) ?? c.channelId}</td>
                      <td data-label="State">
                        <div className="row wrap">
                          <Pill level={c.active ? "ok" : "watch"}>{c.active ? "Active" : "Inactive"}</Pill>
                          {problems.length > 0 && (
                            <Pill level={worst(problems)}>
                              {problems.length} problem{problems.length === 1 ? "" : "s"}
                            </Pill>
                          )}
                        </div>
                      </td>
                      <td data-cell="actions">
                        <div className="actions">
                          <button
                            className="btn btn-sm"
                            onClick={() => { setDraft(toDraft(c)); setError(null); setNotice(null); }}
                          >
                            {draft?.id === c.id ? "Editing" : "Edit"}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={publishing}
                            onClick={() => setConfirmPublish(c)}
                          >
                            Post panel
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(c)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {confirmPublish && (
        <Confirm
          title={`Post a panel for “${confirmPublish.name}”?`}
          confirmLabel="Post it"
          busy={publishing}
          onConfirm={() => void publish(confirmPublish)}
          onCancel={() => setConfirmPublish(null)}
        >
          This sends a new message to {channelName(confirmPublish.channelId) ?? "the configured channel"}{" "}
          where members can see it. It doesn't replace an earlier panel — any panel you posted
          before stays where it is, with a working button, so you'll want to delete the old
          message yourself.
        </Confirm>
      )}

      {confirmDelete && (
        <Confirm
          title={`Delete “${confirmDelete.name}”?`}
          confirmLabel="Delete this type"
          busy={deleting}
          onConfirm={() => void remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        >
          This also deletes every ticket record filed under it — who opened what, when it closed,
          and the ratings. Open ticket channels aren't touched and will be
          left orphaned. There's no undo. If you only want to stop new tickets, untick Active
          instead.
        </Confirm>
      )}

      {error && (
        <Banner level="act" title="Couldn't do that">
          {error}
        </Banner>
      )}

      {draft && (
        <Editor
          key={draft.id ?? "new"}
          guildId={guildId}
          draft={draft}
          channels={channels}
          channelsFailed={channelsFailed}
          saving={saving}
          onPatch={patch}
          onSave={() => void save()}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editor
 *
 * Split out only so the RolePickers remount cleanly when you switch between
 * types (see the key on it) — a stale role list belonging to another config
 * would be a quiet way to grant the wrong people access.
 * ------------------------------------------------------------------ */

function Editor({
  guildId,
  draft,
  channels,
  channelsFailed,
  saving,
  onPatch,
  onSave,
  onClose,
}: {
  guildId: string;
  draft: Draft;
  channels: GuildChannel[] | null;
  channelsFailed: boolean;
  saving: boolean;
  onPatch: (next: Partial<Draft>) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const problems = problemsFor(draft);
  const typeInfo = CHANNEL_TYPES.find((t) => t.value === draft.channelType)!;
  const leaveInfo = LEAVE_ACTIONS.find((l) => l.value === draft.leaveAction)!;

  return (
    <>
      <Panel
        eyebrow={draft.id ? "Editing" : "New ticket type"}
        title={draft.name || "Untitled"}
        action={
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        }
      >
        <label className="field">
          <span className="eyebrow">Name</span>
          <input
            value={draft.name}
            maxLength={100}
            placeholder="Support"
            onChange={(e) => onPatch({ name: e.target.value })}
          />
          <span className="dim">
            The heading on the panel embed, and the title inside every ticket it opens.
          </span>
        </label>

        <div className="grid grid-2">
          <label className="field">
            <span className="eyebrow">Button label</span>
            <input
              value={draft.buttonLabel}
              maxLength={80}
              placeholder="Open Ticket"
              onChange={(e) => onPatch({ buttonLabel: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="eyebrow">Button emoji</span>
            <input
              value={draft.buttonEmoji ?? ""}
              maxLength={64}
              placeholder="🎫"
              onChange={(e) => onPatch({ buttonEmoji: e.target.value.trim() || null })}
            />
            <span className="dim">
              A standard emoji, or a custom one pasted straight from Discord — those arrive
              looking like <code>{"<:name:123456789>"}</code> and now work.{" "}
              <code>{":shortcode:"}</code> will not: only Discord's own message box converts
              those, so it would save fine and then render as nothing.
            </span>
          </label>
        </div>

        <label className="row">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => onPatch({ active: e.target.checked })}
          />
          <span>
            <strong>Active</strong>
            <span className="dim block">
              Unticking stops new tickets without deleting the type or its history. Existing open
              tickets keep working.
            </span>
          </span>
        </label>
      </Panel>

      {/* The warnings. Inline and permanent rather than a toast, because they
          describe a working configuration, not a failed action. */}
      {problems.map((p) => (
        <Banner key={p.key} level={p.level} title={p.title}>
          {p.body}
        </Banner>
      ))}

      <Panel title="Where the ticket opens">
        <label className="field">
          <span className="eyebrow">Ticket is</span>
          <select
            value={draft.channelType}
            onChange={(e) => onPatch({ channelType: e.target.value as ChannelType })}
          >
            {CHANNEL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="dim">{typeInfo.detail}</span>
        </label>

        <OptionalChannelPicker
          label="Panel channel"
          channels={channels}
          failed={channelsFailed}
          value={draft.channelId || null}
          onChange={(id) => onPatch({ channelId: id ?? "" })}
          hint={
            draft.channelType === "private_channel"
              ? "Where the button is posted. Members need to be able to see this channel to open a ticket at all."
              : "Where the button is posted — and, in thread mode, the channel the threads are created under. Anyone who can't see this channel can't reach their own ticket."
          }
        />

        <label className="field">
          <span className="eyebrow">Category</span>
          <input
            value={draft.categoryId ?? ""}
            placeholder="Category ID"
            disabled={draft.channelType !== "private_channel"}
            onChange={(e) => onPatch({ categoryId: e.target.value.trim() || null })}
          />
          <NotAnId text={draft.categoryId ?? ""} kind="category" />
          <span className="dim">
            {draft.channelType === "private_channel"
              ? "An ID rather than a picker: the bot's channel list only returns text and announcement channels, so categories aren't in it. Right-click a category in Discord with developer mode on to copy its ID."
              : "Only applies to private channels. Threads always open under the panel channel."}
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Channel name format</span>
          <input
            value={draft.ticketNameFormat}
            maxLength={100}
            placeholder="ticket-{username}"
            onChange={(e) => onPatch({ ticketNameFormat: e.target.value })}
          />
          <span className="dim">
            {"{username}"} and {"{category}"} (the label of the button they pressed, if the panel
            has categories) get filled in. Everything else is used literally.
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Open tickets per member</span>
          <select
            value={draft.maxOpenPerUser}
            onChange={(e) => onPatch({ maxOpenPerUser: Number(e.target.value) })}
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="dim">
            Counted per type, not across the whole server. Someone at the limit is turned away
            with a message rather than silently ignored.
          </span>
        </label>
      </Panel>

      <Panel title="Who handles them">
        <RolePicker
          guildId={guildId}
          label="Support roles"
          value={draft.supportRoleIds}
          onChange={(ids) => onPatch({ supportRoleIds: ids })}
          hint={
            draft.channelType === "private_channel"
              ? "Granted permission to see and post in every ticket of this type, and allowed to claim and close them. This list is the access control — leave it empty and staff are locked out of their own tickets."
              : "Allowed to claim and close tickets of this type. In thread mode this grants no visibility on its own; who can read the thread follows the panel channel and Discord's thread rules."
          }
        />

        <RolePicker
          guildId={guildId}
          label="Ping on open"
          value={draft.pingRoleIds}
          onChange={(ids) => onPatch({ pingRoleIds: ids })}
          hint="Mentioned in the ticket's first message. Notification only — being pinged doesn't grant access, so these should normally also be support roles."
        />

        <label className="row">
          <input
            type="checkbox"
            checked={draft.creatorCanClose}
            onChange={(e) => onPatch({ creatorCanClose: e.target.checked })}
          />
          <span>
            <strong>The member who opened it can close it</strong>
            <span className="dim block">
              Support roles and Administrators can always close regardless. Turning this off means
              someone who opened a ticket by mistake has to wait for staff.
            </span>
          </span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={draft.claimingEnabled}
            onChange={(e) => onPatch({ claimingEnabled: e.target.checked })}
          />
          <span>
            <strong>Show a Claim button</strong>
            <span className="dim block">
              Lets one staff member take ownership so two people don't answer the same ticket. Off
              hides the button entirely.
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">When the member who opened it leaves the server</span>
          <select
            value={draft.leaveAction}
            onChange={(e) => onPatch({ leaveAction: e.target.value as LeaveAction })}
          >
            {LEAVE_ACTIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="dim">{leaveInfo.detail}</span>
        </label>
      </Panel>

      <Panel title="Categories">
        <p className="dim">
          Give the panel several buttons — Support, Billing, Report a player — and members pick the
          kind of ticket they want. Each category can have its own Discord category, support roles,
          welcome message and questions; anything you leave empty uses the settings above. With no
          categories, the panel has the single button from the top of this page. Post the panel
          again after changing these.
        </p>

        {draft.categories.map((cat, i) => (
          <CategoryEditor
            key={cat.id ?? `new-${i}`}
            guildId={guildId}
            index={i}
            total={draft.categories.length}
            cat={cat}
            isPrivateChannel={draft.channelType === "private_channel"}
            onChange={(next) =>
              onPatch({ categories: draft.categories.map((c, j) => (j === i ? { ...c, ...next } : c)) })
            }
            onMove={(by) => {
              const list = [...draft.categories];
              const [moved] = list.splice(i, 1);
              list.splice(i + by, 0, moved);
              onPatch({ categories: list });
            }}
            onRemove={() => onPatch({ categories: draft.categories.filter((_, j) => j !== i) })}
          />
        ))}

        <div className="actions">
          <button
            className="btn btn-sm"
            disabled={draft.categories.length >= MAX_CATEGORIES}
            onClick={() => onPatch({ categories: [...draft.categories, blankCategory()] })}
          >
            Add a category
          </button>
        </div>
        {draft.categories.length >= MAX_CATEGORIES && (
          <span className="dim">Discord allows at most {MAX_CATEGORIES} buttons on a message.</span>
        )}
      </Panel>

      <Panel title="What members see and what's kept">
        <label className="field">
          <span className="eyebrow">Panel message</span>
          <textarea
            rows={3}
            value={draft.panelMessage}
            maxLength={1000}
            onChange={(e) => onPatch({ panelMessage: e.target.value })}
            placeholder="Click below to open a ticket."
          />
          <span className="dim">
            Public. Sits under the button, where anyone who can see the channel reads it before
            they have a ticket. Say what this queue is for and what to have ready.
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Welcome message</span>
          <textarea
            rows={4}
            value={draft.welcomeMessage}
            maxLength={1000}
            onChange={(e) => onPatch({ welcomeMessage: e.target.value })}
            placeholder="Thanks for opening a ticket. A member of staff will be with you shortly."
          />
          <span className="dim">
            Private. The first message inside a ticket that already exists, seen only by whoever
            opened it and your support roles.
          </span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={draft.transcriptOnClose}
            onChange={(e) => onPatch({ transcriptOnClose: e.target.checked })}
          />
          <span>
            <strong>Keep closed tickets</strong>
            <span className="dim block">
              A closed private channel stays, read-only, for the opener and your support roles,
              instead of being deleted. Threads are always kept (archived and locked). Appealy
              doesn't copy or store the conversation.
            </span>
          </span>
        </label>

        <OptionalChannelPicker
          label="Log channel"
          channels={channels}
          failed={channelsFailed}
          value={draft.transcriptChannelId}
          onChange={(id) => onPatch({ transcriptChannelId: id })}
          hint="Optional. When a kept ticket closes, Appealy posts who opened and closed it, the reason, and a link to it here."
        />

        <label className="row">
          <input
            type="checkbox"
            checked={draft.ratingEnabled}
            onChange={(e) => onPatch({ ratingEnabled: e.target.checked })}
          />
          <span>
            <strong>Ask for a rating after closing</strong>
            <span className="dim block">
              Sent as a DM to the opener. Members with DMs closed simply never see it, so treat
              the ratings you collect as a sample rather than a response rate.
            </span>
          </span>
        </label>
      </Panel>

      <div className="actions">
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : draft.id ? "Save" : "Create"}
        </button>
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * One category (one button on the panel)
 * ------------------------------------------------------------------ */

function CategoryEditor({
  guildId,
  index,
  total,
  cat,
  isPrivateChannel,
  onChange,
  onMove,
  onRemove,
}: {
  guildId: string;
  index: number;
  total: number;
  cat: TicketCategory;
  isPrivateChannel: boolean;
  onChange: (next: Partial<TicketCategory>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const setQuestion = (i: number, next: Partial<TicketQuestion>) =>
    onChange({ questions: cat.questions.map((q, j) => (j === i ? { ...q, ...next } : q)) });

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{cat.label.trim() || `Category ${index + 1}`}</strong>
        <span className="actions">
          <button className="btn btn-sm" disabled={index === 0} onClick={() => onMove(-1)}>
            Up
          </button>
          <button className="btn btn-sm" disabled={index === total - 1} onClick={() => onMove(1)}>
            Down
          </button>
          <button className="btn btn-sm" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>

      <div className="grid grid-2">
        <label className="field">
          <span className="eyebrow">Button label</span>
          <input
            value={cat.label}
            maxLength={80}
            placeholder="Billing"
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="eyebrow">Button emoji</span>
          <input
            value={cat.emoji ?? ""}
            maxLength={64}
            placeholder="💳"
            onChange={(e) => onChange({ emoji: e.target.value.trim() || null })}
          />
        </label>
      </div>

      <label className="field">
        <span className="eyebrow">Description</span>
        <input
          value={cat.description ?? ""}
          maxLength={100}
          placeholder="Payments, refunds and invoices"
          onChange={(e) => onChange({ description: e.target.value || null })}
        />
        <span className="dim">Optional. Listed under the button in the public panel message.</span>
      </label>

      <label className="field">
        <span className="eyebrow">Discord category</span>
        <input
          value={cat.discordCategoryId ?? ""}
          placeholder="Category ID (empty = the one above)"
          disabled={!isPrivateChannel}
          onChange={(e) => onChange({ discordCategoryId: e.target.value.trim() || null })}
        />
        <NotAnId text={cat.discordCategoryId ?? ""} kind="category" />
        <span className="dim">
          {isPrivateChannel
            ? "Where tickets of this kind are created. Same as the type's category when empty."
            : "Only applies to private channels."}
        </span>
      </label>

      <RolePicker
        guildId={guildId}
        label="Support roles"
        value={cat.supportRoleIds}
        onChange={(ids) => onChange({ supportRoleIds: ids })}
        hint="Replace the type's support roles for this category — they see, claim and close these tickets instead. Empty = the type's roles."
      />

      <RolePicker
        guildId={guildId}
        label="Ping on open"
        value={cat.pingRoleIds}
        onChange={(ids) => onChange({ pingRoleIds: ids })}
        hint="Empty = the type's ping roles."
      />

      <label className="field">
        <span className="eyebrow">Welcome message</span>
        <textarea
          rows={3}
          value={cat.welcomeMessage ?? ""}
          maxLength={1000}
          placeholder="Empty = the type's welcome message"
          onChange={(e) => onChange({ welcomeMessage: e.target.value || null })}
        />
      </label>

      <div className="field">
        <span className="eyebrow">Questions</span>
        <span className="dim">
          Asked in a pop-up when a member presses this button, and posted in the ticket. Up to{" "}
          {MAX_QUESTIONS}; labels are cut at 45 characters by Discord.
        </span>
        {cat.questions.map((q, i) => (
          <div className="row" key={i}>
            <input
              value={q.label}
              maxLength={45}
              placeholder="What do you need help with?"
              onChange={(e) => setQuestion(i, { label: e.target.value })}
            />
            <label className="row">
              <input
                type="checkbox"
                checked={q.paragraph}
                onChange={(e) => setQuestion(i, { paragraph: e.target.checked })}
              />
              <span>Long answer</span>
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={q.required}
                onChange={(e) => setQuestion(i, { required: e.target.checked })}
              />
              <span>Required</span>
            </label>
            <button
              className="btn btn-sm"
              onClick={() => onChange({ questions: cat.questions.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="actions">
          <button
            className="btn btn-sm"
            disabled={cat.questions.length >= MAX_QUESTIONS}
            onClick={() =>
              onChange({ questions: [...cat.questions, { label: "", paragraph: false, required: true }] })
            }
          >
            Add a question
          </button>
        </div>
      </div>
    </div>
  );
}
