// web/src/pages/StaffPermissions.tsx
//
// Manager delegation — the whole point of which is that it does NOT require
// Discord Administrator.
//
// Before this existed, the only way to let someone review applications was to
// hand them Administrator, which also hands them the ban hammer, the channel
// list, the webhooks and the roles above their own. Servers did it anyway,
// because the alternative was reviewing everything themselves. Every grant on
// this page replaces one of those, so the screen leads with that comparison
// rather than burying it: what you give here is scoped to Appealy, and to the
// forms you name.
//
// Three things the API enforces that this page has to make legible, because
// the failures are all "accepted and wrong" rather than "rejected":
//
//   1. Exactly one of roleId / userId. The zod refine rejects both-or-neither,
//      so the form is a choice, not two optional boxes.
//
//   2. level defaults to "manager", but "admin" and "owner" are accepted. A
//      delegated admin can do everything in this console for this server —
//      including granting more delegations. That's a much bigger decision than
//      "let them review", and it looks identical in the dropdown, so it gets a
//      warning.
//
//   3. canReview defaults true and the other two default false, but nothing
//      stops a grant with all three off. The API accepts it; it just does
//      nothing. Same class of silent no-op as the appeal config, so it's
//      blocked here rather than discovered months later.
//
// The entire router is admin-only — including GET. A manager who reaches this
// page can't even read it, which is correct (delegations are the thing that
// made them a manager) but needs saying in words rather than as a 403.

import { useCallback, useEffect, useState } from "react";
import { api, http, ApiError, type FormSummary } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";

type Level = "owner" | "admin" | "manager";

interface DelegationDTO {
  id: string;
  roleId: string | null;
  userId: string | null;
  level: Level;
  /** null = every form in the server, present and future. */
  formId: string | null;
  canReview: boolean;
  canManageForm: boolean;
  canManagePanel: boolean;
}

interface GuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

const LEVELS: { value: Level; label: string; hint: string }[] = [
  {
    value: "manager",
    label: "Manager",
    hint: "Reviews and manages what you tick below, and nothing else. This is the one you almost always want.",
  },
  {
    value: "admin",
    label: "Admin",
    hint: "Everything in this console for this server, including granting and revoking these delegations.",
  },
  {
    value: "owner",
    label: "Owner",
    hint: "Treated as the server owner by Appealy. Reserve for people who already are.",
  },
];

/** Discord snowflakes are 17–20 digits today. Checked here only so a pasted
 * username fails in the form instead of as a 500 from BigInt(). */
const SNOWFLAKE = /^\d{17,20}$/;

function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.isUnavailable) return "Discord didn't answer, so your permissions couldn't be checked. Try again in a moment.";
  if (e.code === "invalid_body") return "The server rejected that grant. Pick either a role or a user — not both.";
  if (e.code === "delegation_not_found") return "That grant was already revoked by someone else.";
  return e.message || fallback;
}

export default function StaffPermissions({ guildId }: { guildId: string }) {
  const [rows, setRows] = useState<DelegationDTO[] | null>(null);
  const [roles, setRoles] = useState<GuildRole[]>([]);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [fatal, setFatal] = useState<ApiError | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draft grant. Kept as one object so "exactly one of role/user" can be a
  // single subject field rather than two inputs that can disagree.
  const [subject, setSubject] = useState<"role" | "user">("role");
  const [roleId, setRoleId] = useState("");
  const [userId, setUserId] = useState("");
  const [level, setLevel] = useState<Level>("manager");
  const [formId, setFormId] = useState("");
  const [canReview, setCanReview] = useState(true);
  const [canManageForm, setCanManageForm] = useState(false);
  const [canManagePanel, setCanManagePanel] = useState(false);
  const [granting, setGranting] = useState(false);

  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const base = `/api/guilds/${guildId}/staff-permissions`;

  const load = useCallback(async () => {
    try {
      const list = await http.get<DelegationDTO[]>(`/api/guilds/${guildId}/staff-permissions`);
      setRows(list);
    } catch (e) {
      setFatal(e instanceof ApiError ? e : "Couldn't load delegated access.");
      return;
    }
    // Roles and forms are labels, not data — a failure here degrades the page
    // to snowflakes rather than breaking it, so it doesn't share the try above.
    const [r, f] = await Promise.allSettled([api.roles(guildId), api.forms(guildId)]);
    if (r.status === "fulfilled") setRoles(r.value);
    if (f.status === "fulfilled") setForms(f.value);
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The 403 here is not an error state — it's the feature working. Say which.
  if (fatal instanceof ApiError && fatal.code === "admin_access_required") {
    return (
      <Banner level="watch" title="Only server admins can see delegated access">
        You're signed in as a delegated manager. Managing who else gets access is
        deliberately kept with Discord Administrators and the server owner, so a
        manager can't widen their own grant. Ask an admin to make the change.
      </Banner>
    );
  }
  if (fatal) {
    return (
      <Banner level="act" title="Couldn't load">
        {typeof fatal === "string" ? fatal : describe(fatal, "Couldn't load delegated access.")}
      </Banner>
    );
  }
  if (!rows) return <Loading rows={5} />;

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? null;
  const formName = (id: string | null) =>
    id ? (forms.find((f) => f.id === id)?.name ?? "Deleted form") : "All forms";

  const nothingGranted = !canReview && !canManageForm && !canManagePanel && level === "manager";
  const subjectOk = subject === "role" ? Boolean(roleId) : SNOWFLAKE.test(userId.trim());

  async function grant() {
    setGranting(true);
    setError(null);
    try {
      // Exactly one of the two is sent. Sending the other as null rather than
      // omitting it keeps the payload honest about which branch was taken.
      await http.post<{ id: string }>(base, {
        roleId: subject === "role" ? roleId : null,
        userId: subject === "user" ? userId.trim() : null,
        level,
        formId: formId || null,
        canReview,
        canManageForm,
        canManagePanel,
      });
      // POST returns only { id }, so the row has to come from a reload rather
      // than being assembled client-side from what we hoped we sent.
      await load();
      setRoleId("");
      setUserId("");
      setFormId("");
      setLevel("manager");
      setCanReview(true);
      setCanManageForm(false);
      setCanManagePanel(false);
    } catch (e) {
      setError(describe(e, "Couldn't grant that access."));
    } finally {
      setGranting(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await http.del<void>(`${base}/${id}`);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
    } catch (e) {
      setError(describe(e, "Couldn't revoke that access."));
    } finally {
      setConfirmRevoke(null);
    }
  }

  const elevated = rows.filter((r) => r.level !== "manager");

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Delegated access</h1>
        <p className="dim">
          Let a role or a person review applications without giving them Discord
          Administrator. Everything granted here applies inside Appealy only — it
          can't ban, edit channels, or touch anything else in your server.
        </p>
      </header>

      <Banner level="watch" title="This replaces handing out Administrator">
        Discord has no permission for “can review applications”, so servers grant
        Administrator instead and accept the rest of it. A grant below is scoped to
        Appealy, to the forms you name, and to the three boxes you tick — and you
        can take it back without touching their Discord roles.
      </Banner>

      {elevated.length > 0 && (
        <Banner level="act" title={`${elevated.length} grant(s) above Manager`}>
          Admin and Owner delegations can change these permissions themselves,
          including granting new ones. Keep them to people who would otherwise have
          Administrator anyway.
        </Banner>
      )}

      {error && <Banner level="act" title="That didn't go through">{error}</Banner>}

      <Panel title="Who has access" action={<Pill>{rows.length} grant(s)</Pill>}>
        {rows.length === 0 ? (
          <Empty
            title="Nobody is delegated yet"
            hint="Only Discord Administrators and the server owner can use Appealy until you grant someone here."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Who</th>
                <th>Level</th>
                <th>Scope</th>
                <th>Can</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const can = [
                  r.canReview && "review",
                  r.canManageForm && "edit forms",
                  r.canManagePanel && "edit panels",
                ].filter(Boolean) as string[];
                return (
                  <tr key={r.id}>
                    <td>
                      {r.roleId ? (
                        <>
                          {roleName(r.roleId) ? (
                            <strong>@{roleName(r.roleId)}</strong>
                          ) : (
                            <span className="mono">{r.roleId}</span>
                          )}
                          <span className="dim block" style={{ fontSize: 11 }}>
                            role — everyone who has it
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="mono">{r.userId}</span>
                          <span className="dim block" style={{ fontSize: 11 }}>
                            one member
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {r.level === "manager" ? (
                        <Pill>manager</Pill>
                      ) : (
                        <Pill level="act">{r.level}</Pill>
                      )}
                    </td>
                    <td className="dim">{formName(r.formId)}</td>
                    <td className="dim">
                      {can.length > 0 ? (
                        can.join(", ")
                      ) : (
                        // Accepted by the API, does nothing at all. Worth calling
                        // out where it sits rather than in a summary elsewhere.
                        <span style={{ color: "var(--act)" }}>nothing — no boxes ticked</span>
                      )}
                    </td>
                    <td>
                      {confirmRevoke === r.id ? (
                        <span className="actions">
                          <span className="dim" style={{ fontSize: 12 }}>
                            They lose Appealy access immediately.
                          </span>
                          <button className="btn btn-sm btn-danger" onClick={() => void revoke(r.id)}>
                            Revoke
                          </button>
                          <button className="btn btn-sm" onClick={() => setConfirmRevoke(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn-sm" onClick={() => setConfirmRevoke(r.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Grant access">
        <label className="field">
          <span className="eyebrow">Grant to</span>
          <select value={subject} onChange={(e) => setSubject(e.target.value as "role" | "user")}>
            <option value="role">A role — everyone who has it, now and later</option>
            <option value="user">One member, by ID</option>
          </select>
          <span className="dim">
            Roles are the maintainable choice: staff turnover changes who's in the
            role, not what you configured here.
          </span>
        </label>

        {subject === "role" ? (
          <label className="field">
            <span className="eyebrow">Role</span>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={roles.length === 0}>
              <option value="">— choose a role —</option>
              {[...roles]
                .sort((a, b) => b.position - a.position)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
            {roles.length === 0 && (
              <span className="dim">
                Couldn't read this server's roles from Discord. You can still grant to a
                member by ID.
              </span>
            )}
          </label>
        ) : (
          <label className="field">
            <span className="eyebrow">Member ID</span>
            <input
              type="text"
              value={userId}
              placeholder="e.g. 216661201098932225"
              onChange={(e) => setUserId(e.target.value)}
            />
            <span className="dim">
              {userId.trim() && !SNOWFLAKE.test(userId.trim())
                ? "That isn't a Discord ID. Turn on Developer Mode, right-click the member, Copy User ID."
                : "Not a username — the numeric ID."}
            </span>
          </label>
        )}

        <label className="field">
          <span className="eyebrow">Level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="dim">{LEVELS.find((l) => l.value === level)?.hint}</span>
        </label>

        <label className="field">
          <span className="eyebrow">Applies to</span>
          <select value={formId} onChange={(e) => setFormId(e.target.value)}>
            <option value="">All forms — including ones made later</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <span className="dim">
            Scoping to one form is how you let a section's own staff review their own
            applicants without seeing everyone else's.
          </span>
        </label>

        <label className="row">
          <input type="checkbox" checked={canReview} onChange={(e) => setCanReview(e.target.checked)} />
          <span>
            <strong>Review submissions</strong>
            <span className="dim block">
              Accept and deny applications. The reason delegation exists.
            </span>
          </span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={canManageForm}
            onChange={(e) => setCanManageForm(e.target.checked)}
          />
          <span>
            <strong>Edit forms</strong>
            <span className="dim block">
              Change questions, outcomes and the roles an acceptance grants — which
              means changing what accepting is worth.
            </span>
          </span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={canManagePanel}
            onChange={(e) => setCanManagePanel(e.target.checked)}
          />
          <span>
            <strong>Edit panels</strong>
            <span className="dim block">
              Post and change the message members apply from.
            </span>
          </span>
        </label>

        {nothingGranted && (
          <Banner level="watch" title="This grant would do nothing">
            A Manager with none of the three boxes ticked is accepted by the server and
            has no abilities at all. Tick at least one.
          </Banner>
        )}

        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={() => void grant()}
            disabled={granting || !subjectOk || nothingGranted}
          >
            {granting ? "Granting…" : "Grant access"}
          </button>
          <span className="dim" style={{ fontSize: 12 }}>
            Takes effect immediately. No Discord role is created or changed.
          </span>
        </div>
      </Panel>
    </div>
  );
}
