// web/src/pages/RoleMenus.tsx
//
// Self-assignable role menus: a published message with a select menu that
// members use to give themselves roles. Deliberately not the same thing as
// Welcomer's auto-roles — those are granted to everyone on join with no
// choice; these are opt-in, at any time (see the roleMenus comment in
// shared/schema/schema.ts).
//
// Three failure modes this screen exists to prevent, in the order they cost
// the most:
//
//   1. More than 25 options. Discord's select menu holds 25, full stop.
//      The API caps the array at 25 and bot/src/services/roleMenuService.ts
//      slices to 25 before posting — so the 26th role isn't rejected, it
//      just never appears in the menu and nobody is told. The counter and
//      the disabled Add button below are that limit made visible.
//
//   2. A menu with no options. The publisher throws role_menu_has_no_options
//      and the API turns that into a 502 that reads like the bot is down.
//      Blocked here with an explanation instead.
//
//   3. A saved menu that was never published. It exists in this list, looks
//      configured, and no member can see it — there is no message in the
//      channel at all.
//
// Two roles on one menu also has to be blocked here: role_menu_option_unique
// is a database constraint, so a duplicate comes back as a 500 rather than a
// validation error anyone could act on.

import { useEffect, useState, useCallback } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";

/** Discord's hard cap on select-menu options. Not a policy choice. */
const MAX_OPTIONS = 25;

type SelectionMode = "single" | "multi";

interface OptionDTO {
  id: string;
  roleId: string;
  label: string;
  emoji: string | null;
  description: string | null;
  sortOrder: number;
}

interface MenuDTO {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  selectionMode: SelectionMode;
  published: boolean;
  options: OptionDTO[];
}

/** An option being edited. No id until the server has stored it — and it
 *  never keeps one across a save, since PATCH replaces the whole option set. */
type DraftOption = Omit<OptionDTO, "id" | "sortOrder">;

interface Draft {
  /** Absent for a menu that hasn't been created yet. */
  id?: string;
  channelId: string;
  title: string;
  description: string;
  selectionMode: SelectionMode;
  options: DraftOption[];
}

interface GuildChannel {
  id: string;
  name: string;
}

interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

const blankDraft = (): Draft => ({
  channelId: "",
  title: "Choose your roles",
  description: "",
  selectionMode: "multi",
  options: [],
});

const blankOption = (): DraftOption => ({
  roleId: "",
  label: "",
  emoji: null,
  description: null,
});

/**
 * The API answers a rejected body with { error: "invalid_body", detail: <zod
 * flatten> }, and lib/api.ts hands `detail` to Error — which stringifies an
 * object to "[object Object]" before it reaches here. So that one code gets
 * its own words; every other code (menu_not_found, bot_unreachable) sends a
 * string worth showing exactly as it arrived.
 */
function apiMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === "invalid_body") {
    return `The server rejected this menu. Titles are 1–256 characters, descriptions up to 2000, labels 1–100, option descriptions up to 100, and a menu needs between 1 and ${MAX_OPTIONS} options.`;
  }
  if (e.code === "menu_not_found") {
    return "That menu is gone — someone else deleted it while this page was open.";
  }
  return e.message || fallback;
}

const hex = (color: number) =>
  color === 0 ? "var(--dim)" : `#${color.toString(16).padStart(6, "0")}`;

export default function RoleMenus({ guildId }: { guildId: string }) {
  const [menus, setMenus] = useState<MenuDTO[] | null>(null);
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [roles, setRoles] = useState<GuildRole[] | null>(null);
  const [resourcesFailed, setResourcesFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMenus(await http.get<MenuDTO[]>(`/api/guilds/${guildId}/role-menus`));
    } catch (e) {
      setError(apiMessage(e, "Couldn't load role menus."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pickers fail independently of the menus themselves: the bot being down
  // shouldn't turn this page into an error screen when every menu already
  // saved is still readable and editable by ID.
  useEffect(() => {
    Promise.all([
      http.get<GuildChannel[]>(`/api/guilds/${guildId}/resources/channels`),
      http.get<GuildRole[]>(`/api/guilds/${guildId}/resources/roles`),
    ])
      .then(([c, r]) => {
        setChannels(c);
        setRoles(r);
      })
      .catch(() => setResourcesFailed(true));
  }, [guildId]);

  if (error && !menus) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!menus) return <Loading rows={4} />;

  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? id;
  const channelName = (id: string) => {
    const c = channels?.find((x) => x.id === id);
    return c ? `#${c.name}` : id;
  };

  /** Blocking problems — every one of these would come back as a 400 or a
   *  500 rather than something a person could read. */
  function problemsWith(d: Draft): string[] {
    const out: string[] = [];
    if (!d.channelId) out.push("Pick the channel the menu gets posted in.");
    if (!d.title.trim()) out.push("The menu needs a title.");
    if (d.options.length === 0) {
      out.push("Add at least one role. An empty menu can't be published.");
    }
    if (d.options.length > MAX_OPTIONS) {
      out.push(`Discord shows at most ${MAX_OPTIONS} options. Remove ${d.options.length - MAX_OPTIONS}.`);
    }
    if (d.options.some((o) => !o.roleId)) out.push("Every option needs a role.");
    if (d.options.some((o) => !o.label.trim())) out.push("Every option needs a label.");

    const ids = d.options.map((o) => o.roleId).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      // A unique index enforces this, so the alternative is a 500.
      out.push(`Each role can only appear once on a menu — ${roleName(dupes[0])} is listed twice.`);
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
      // sortOrder is written from the list position rather than being typed:
      // the editor already shows the order the member will see, and two
      // options sharing a number would order arbitrarily.
      const body = {
        channelId: draft.channelId,
        title: draft.title,
        description: draft.description,
        selectionMode: draft.selectionMode,
        options: draft.options.map((o, i) => ({
          roleId: o.roleId,
          label: o.label,
          emoji: o.emoji,
          description: o.description,
          sortOrder: i,
        })),
      };

      if (draft.id) {
        await http.patch<MenuDTO>(`/api/guilds/${guildId}/role-menus/${draft.id}`, body);
        // The API re-publishes automatically, but only for a menu that is
        // already published — saying so beats letting someone wonder.
        setNotice(
          menus?.find((m) => m.id === draft.id)?.published
            ? "Saved, and the posted message was updated."
            : "Saved. It isn't posted yet — publish it when you're ready.",
        );
      } else {
        await http.post<MenuDTO>(`/api/guilds/${guildId}/role-menus`, body);
        setNotice("Created. It isn't posted yet — publish it when you're ready.");
      }
      setDraft(null);
      await load();
    } catch (e) {
      setError(apiMessage(e, "Couldn't save the menu."));
    } finally {
      setBusy(null);
    }
  }

  async function publish(menu: MenuDTO) {
    setBusy(`publish:${menu.id}`);
    setError(null);
    setNotice(null);
    try {
      await http.post<{ status: string }>(
        `/api/guilds/${guildId}/role-menus/${menu.id}/publish`,
        {},
      );
      setNotice(
        menu.published
          ? `Re-synced the message in ${channelName(menu.channelId)}.`
          : `Posted to ${channelName(menu.channelId)}.`,
      );
      await load();
    } catch (e) {
      setError(apiMessage(e, "Couldn't publish. The bot has to be online to post a message."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(menuId: string) {
    setBusy(`delete:${menuId}`);
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/role-menus/${menuId}`);
      setConfirmDelete(null);
      if (draft?.id === menuId) setDraft(null);
      setNotice("Deleted. If it was posted, take the message down in Discord too.");
      await load();
    } catch (e) {
      setError(apiMessage(e, "Couldn't delete the menu."));
    } finally {
      setBusy(null);
    }
  }

  const editing = draft !== null;
  const problems = draft ? problemsWith(draft) : [];

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Role menus</h1>
        <p className="dim">
          A message members use to give themselves roles. Each menu is one message in one
          channel, holding up to {MAX_OPTIONS} roles.
        </p>
      </header>

      {resourcesFailed && (
        <Banner level="watch" title="Can't list channels and roles">
          The bot didn't answer, so the pickers below are ID fields. Everything still saves —
          and publishing won't work until the bot is back, because posting the message needs
          its connection.
        </Banner>
      )}

      {error && <Banner level="act" title="Something went wrong">{error}</Banner>}
      {notice && !error && <Banner level="watch" title="Done">{notice}</Banner>}

      {!editing && (
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setDraft(blankDraft())}>
            New menu
          </button>
        </div>
      )}

      {editing && draft && (
        <Panel
          title={draft.id ? "Editing menu" : "New menu"}
          eyebrow={`${draft.options.length} / ${MAX_OPTIONS} options`}
        >
          <ChannelField
            label="Channel"
            value={draft.channelId}
            channels={channels}
            failed={resourcesFailed}
            onChange={(channelId) => setDraft({ ...draft, channelId })}
          />

          <label className="field">
            <span className="eyebrow">Title</span>
            <input
              value={draft.title}
              maxLength={256}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="eyebrow">Description</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.description}
              placeholder="Pick as many as you like — you can change them any time."
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <span className="dim">Shown in the embed above the picker.</span>
          </label>

          <label className="field">
            <span className="eyebrow">How many can be held at once</span>
            <select
              value={draft.selectionMode}
              onChange={(e) =>
                setDraft({ ...draft, selectionMode: e.target.value as SelectionMode })
              }
            >
              <option value="multi">Any number — members hold as many as they pick</option>
              <option value="single">One only — picking a new one removes the old</option>
            </select>
            <span className="dim">
              "One only" is for sets where exactly one applies: region, pronouns, colour. It
              takes the previous role away without asking, which is the whole point.
            </span>
          </label>

          {/* The cap, stated before it's reached rather than at the moment it
              blocks someone. */}
          <div className="field">
            <span className="eyebrow">Options</span>
            <span className="dim">
              {draft.options.length} of {MAX_OPTIONS} used. Discord's select menu holds{" "}
              {MAX_OPTIONS} and no more — past that the extra roles are dropped from the
              posted message without any warning, so this stops at {MAX_OPTIONS}. If you need
              more, split them across a second menu in the same channel.
            </span>
          </div>

          {draft.options.map((o, i) => (
            <Panel key={i} eyebrow={`Option ${i + 1}`}>
              <RoleField
                label="Role"
                value={o.roleId}
                roles={roles}
                failed={resourcesFailed}
                onChange={(roleId) => patchOption(draft, setDraft, i, { roleId })}
              />

              <label className="field">
                <span className="eyebrow">Label</span>
                <input
                  value={o.label}
                  maxLength={100}
                  placeholder={o.roleId ? roleName(o.roleId) : "Europe"}
                  onChange={(e) => patchOption(draft, setDraft, i, { label: e.target.value })}
                />
                <span className="dim">
                  What members read in the menu. It doesn't have to match the role's name — and
                  usually shouldn't, if the role name carries staff shorthand.
                </span>
              </label>

              <label className="field">
                <span className="eyebrow">Description</span>
                <input
                  value={o.description ?? ""}
                  maxLength={100}
                  placeholder="Ping for events in CET"
                  onChange={(e) =>
                    patchOption(draft, setDraft, i, { description: e.target.value || null })
                  }
                />
              </label>

              <label className="field">
                <span className="eyebrow">Emoji</span>
                <input
                  value={o.emoji ?? ""}
                  maxLength={64}
                  placeholder="🌍"
                  onChange={(e) =>
                    patchOption(draft, setDraft, i, { emoji: e.target.value || null })
                  }
                />
                <span className="dim">
                  A standard emoji, pasted in. A custom server emoji is stored by name only, so
                  Discord can't resolve it and the option renders without one.
                </span>
              </label>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={i === 0}
                  onClick={() => setDraft({ ...draft, options: move(draft.options, i, -1) })}
                >
                  Move up
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={i === draft.options.length - 1}
                  onClick={() => setDraft({ ...draft, options: move(draft.options, i, 1) })}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() =>
                    setDraft({ ...draft, options: draft.options.filter((_, n) => n !== i) })
                  }
                >
                  Remove
                </button>
              </div>
            </Panel>
          ))}

          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={draft.options.length >= MAX_OPTIONS}
              onClick={() => setDraft({ ...draft, options: [...draft.options, blankOption()] })}
            >
              Add option
            </button>
            {draft.options.length >= MAX_OPTIONS && (
              <span className="dim">
                Full at {MAX_OPTIONS} — remove one, or put the rest on a second menu.
              </span>
            )}
          </div>

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
              {busy === "save" ? "Saving…" : draft.id ? "Save changes" : "Create menu"}
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </Panel>
      )}

      {menus.length === 0 && !editing && (
        <Empty
          title="No role menus yet"
          hint="Create one to let members pick their own roles instead of asking staff."
        />
      )}

      {menus.map((m) => {
        const noOptions = m.options.length === 0;
        const overCap = m.options.length > MAX_OPTIONS;
        return (
          <Panel
            key={m.id}
            title={m.title}
            eyebrow={`${channelName(m.channelId)} · ${m.options.length} role${m.options.length === 1 ? "" : "s"} · ${m.selectionMode === "single" ? "one only" : "any number"}`}
            action={
              <Pill level={m.published ? "ok" : "watch"}>
                {m.published ? "Posted" : "Not posted"}
              </Pill>
            }
          >
            {m.description && <p className="dim">{m.description}</p>}

            {!m.published && (
              <Banner level="watch" title="Nobody can see this yet">
                It's saved, but no message has been posted, so there is nothing in{" "}
                {channelName(m.channelId)} for members to use. Publish it.
              </Banner>
            )}

            {noOptions && (
              <Banner level="act" title="This menu has no roles">
                Publishing fails outright until you add at least one.
              </Banner>
            )}

            {overCap && (
              <Banner level="act" title={`Only the first ${MAX_OPTIONS} are shown`}>
                Discord's select menu stops at {MAX_OPTIONS}, so the last{" "}
                {m.options.length - MAX_OPTIONS} never appear in the posted message and members
                have no way to pick them. Move them to a second menu.
              </Banner>
            )}

            {m.options.length > 0 && (
              <div className="menu-preview">
                <div className="menu-preview-bar">Choose your roles ▾</div>
                {m.options.map((o, i) => (
                  <div
                    key={o.id}
                    className="menu-preview-option"
                    style={i >= MAX_OPTIONS ? { opacity: 0.45 } : undefined}
                  >
                    <span>
                      {o.emoji ? `${o.emoji} ` : ""}
                      {o.label}
                    </span>
                    <span className="dim block">
                      {o.description ? `${o.description} · ` : ""}
                      <span style={{ color: hex(roles?.find((r) => r.id === o.roleId)?.color ?? 0) }}>
                        @{roleName(o.roleId)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {confirmDelete === m.id ? (
              <Banner
                level="act"
                title={`Delete "${m.title}"?`}
                action={
                  <div className="actions">
                    <button
                      className="btn btn-danger"
                      disabled={busy === `delete:${m.id}`}
                      onClick={() => remove(m.id)}
                    >
                      {busy === `delete:${m.id}` ? "Deleting…" : "Delete it"}
                    </button>
                    <button className="btn" onClick={() => setConfirmDelete(null)}>
                      Keep it
                    </button>
                  </div>
                }
              >
                The menu and its {m.options.length} option
                {m.options.length === 1 ? "" : "s"} go for good, and members keep whatever roles
                they already picked.{" "}
                {m.published
                  ? "The message stays in the channel and answers every click with \"this role menu no longer exists\" — delete it in Discord as well."
                  : "Nothing was ever posted, so there's nothing to clean up in Discord."}
              </Banner>
            ) : (
              <div className="actions">
                <button
                  className="btn"
                  onClick={() =>
                    setDraft({
                      id: m.id,
                      channelId: m.channelId,
                      title: m.title,
                      description: m.description,
                      selectionMode: m.selectionMode,
                      // Sorted on the way in so the editor's order is the
                      // order members see; sortOrder is rewritten on save.
                      options: [...m.options]
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((o) => ({
                          roleId: o.roleId,
                          label: o.label,
                          emoji: o.emoji,
                          description: o.description,
                        })),
                    })
                  }
                >
                  Edit
                </button>
                <button
                  className="btn"
                  disabled={busy === `publish:${m.id}` || noOptions}
                  onClick={() => publish(m)}
                >
                  {busy === `publish:${m.id}`
                    ? "Publishing…"
                    : m.published
                      ? "Re-post now"
                      : "Publish"}
                </button>
                <button className="btn btn-danger" onClick={() => setConfirmDelete(m.id)}>
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

function patchOption(
  draft: Draft,
  setDraft: (d: Draft) => void,
  index: number,
  next: Partial<DraftOption>,
) {
  setDraft({
    ...draft,
    options: draft.options.map((o, i) => (i === index ? { ...o, ...next } : o)),
  });
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item);
  return copy;
}

/** Same fallback rule as RolePicker: when the bot can't be reached, degrade
 *  to a raw ID rather than blocking the edit entirely. */
function ChannelField({
  label,
  value,
  channels,
  failed,
  onChange,
}: {
  label: string;
  value: string;
  channels: GuildChannel[] | null;
  failed: boolean;
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
          </option>
        ))}
      </select>
      {missing && (
        <span className="dim">
          I can't see this channel any more. Publishing will fail until you pick another.
        </span>
      )}
    </label>
  );
}

function RoleField({
  label,
  value,
  roles,
  failed,
  onChange,
}: {
  label: string;
  value: string;
  roles: GuildRole[] | null;
  failed: boolean;
  onChange: (id: string) => void;
}) {
  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value}
          placeholder="Role ID"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </label>
    );
  }
  // Highest first, matching Discord's own list — position is what decides
  // whether I can hand the role out at all, so the order is information.
  const sorted = [...(roles ?? [])].sort((a, b) => b.position - a.position);
  const missing = value !== "" && roles !== null && !sorted.some((r) => r.id === value);
  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <select value={value} disabled={roles === null} onChange={(e) => onChange(e.target.value)}>
        <option value="">— pick a role —</option>
        {missing && <option value={value}>Deleted role ({value})</option>}
        {sorted.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {missing && (
        <span className="dim">
          This role no longer exists. Members clicking the option get an error.
        </span>
      )}
    </label>
  );
}
