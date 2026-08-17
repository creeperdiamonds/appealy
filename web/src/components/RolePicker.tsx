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

export interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

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
    api
      .roles(guildId)
      .then((r) => setRoles(r as unknown as GuildRole[]))
      .catch(() => setFailed(true));
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
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value.join(", ")}
          placeholder="Role IDs, comma separated"
          onChange={(e) =>
            onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))
          }
        />
        <span className="dim">
          Couldn't reach the bot to list roles, so this is IDs for now. It'll come back on its
          own once the bot is up.
        </span>
      </label>
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
