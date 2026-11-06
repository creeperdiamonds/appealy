// web/src/components/RolePicker.tsx
//
// Multi-select for Discord roles.
//
// Replaces a comma-separated ID field. That field wasn't just unfriendly —
// nobody can read a role ID, so a typo produced an outcome that silently
// granted nothing, or worse, granted the wrong role and looked correct in
// the editor.
//
// Two things this shows that a plain list wouldn't:
//
// **Hierarchy position.** Roles are ordered highest-first, matching Discord's
// own list, because position is what decides whether the bot can assign a role
// at all. Someone picking roles for an outcome needs to see that @Admin sits
// above @Moderator without going back to server settings to check.
//
// **Whether the bot can actually apply it.** A role above the bot's highest is
// selectable but marked, because the alternative — hiding it — makes the
// editor look broken to someone who knows the role exists. Marking it explains
// the fix; hiding it just raises a question.

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { IdListField } from "./IdFields";
import { sharedLoader } from "../../../shared/lib/sharedLoader";

export interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

/**
 * One request however many pickers a page shows, with the same quiet retries as
 * useGuildChannels. The form editor opens with six of these, and every role list
 * that failed in production was part of a burst of five to seven from one server.
 */
export const loadRoles = sharedLoader(
  (guildId: string) => api.roles(guildId) as unknown as Promise<GuildRole[]>,
  [2_000, 4_000],
);

const hex = (color: number) =>
  color === 0 ? "var(--dim)" : `#${color.toString(16).padStart(6, "0")}`;

export function RolePicker({
  guildId,
  value,
  onChange,
  label,
  hint,
  /** Bot's highest role position, if known. Roles at or above it can't be applied. */
  botHighestPosition,
}: {
  guildId: string;
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  hint?: string;
  botHighestPosition?: number;
}) {
  const [roles, setRoles] = useState<GuildRole[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRoles(null);
    setFailed(false);
    loadRoles(guildId)
      .then((r) => {
        if (live) setRoles(r);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [guildId]);

  const sorted = useMemo(
    () => (roles ?? []).slice().sort((a, b) => b.position - a.position),
    [roles],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((r) => r.name.toLowerCase().includes(q)) : sorted;
  }, [sorted, query]);

  const selected = useMemo(
    () => value.map((id) => sorted.find((r) => r.id === id) ?? { id, name: id, color: 0, position: -1 }),
    [value, sorted],
  );

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  // The bot being unreachable shouldn't cost someone their edit. Fall back to
  // the raw ID field rather than blocking — a degraded editor beats none.
  if (failed) {
    return (
      <IdListField
        label={label}
        kind="role"
        value={value}
        onChange={onChange}
        note="Couldn't load the role list, so this takes role IDs for now. Reloading the page tries the list again."
      />
    );
  }

  return (
    <div className="field">
      <span className="eyebrow">{label}</span>

      <div className="role-chips">
        {selected.length === 0 && <span className="dim">None selected</span>}
        {selected.map((r) => (
          <button
            key={r.id}
            type="button"
            className="role-chip"
            style={{ borderColor: hex(r.color) }}
            onClick={() => toggle(r.id)}
            aria-label={`Remove ${r.name}`}
          >
            <i className="role-dot" style={{ background: hex(r.color) }} />
            {r.name}
            <span className="role-chip-x">×</span>
          </button>
        ))}
      </div>

      <button type="button" className="btn-secondary role-add" onClick={() => setOpen(!open)}>
        {open ? "Done" : "Choose roles"}
      </button>

      {open && (
        <div className="role-list">
          <input
            className="role-search"
            placeholder="Search roles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />

          {!roles && <span className="dim">Loading roles…</span>}

          {roles && filtered.length === 0 && (
            <span className="dim">No roles match “{query}”.</span>
          )}

          {filtered.map((r) => {
            const unmanageable =
              botHighestPosition !== undefined && r.position >= botHighestPosition;
            return (
              <button
                key={r.id}
                type="button"
                className={`role-option${value.includes(r.id) ? " is-selected" : ""}`}
                onClick={() => toggle(r.id)}
              >
                <i className="role-dot" style={{ background: hex(r.color) }} />
                <span className="role-name">{r.name}</span>
                {unmanageable && (
                  <span
                    className="role-warn"
                    title="Above my highest role — move my role above it in Server Settings"
                  >
                    can't apply
                  </span>
                )}
                {value.includes(r.id) && <span className="role-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}

      {hint && <span className="dim">{hint}</span>}
    </div>
  );
}
