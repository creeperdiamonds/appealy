// web/src/pages/QuickResponses.tsx
//
// Saved replies: canned text staff paste into tickets and reviews instead of
// retyping the same refusal for the four hundredth time, filed under optional
// categories.
//
// Two facts about the API shape this screen has to argue with, because both
// are invisible from the outside and both would otherwise read as bugs:
//
//   1. Categories can be created and deleted but NOT renamed — there is no
//      PATCH on /quick-responses/categories. Offering a rename box that
//      silently did nothing would be worse than saying so, and "delete and
//      recreate" is not an equivalent workaround (see 2).
//
//   2. The category foreign key is ON DELETE SET NULL. Deleting a category
//      does not delete the replies inside it; it un-files them. Admins reach
//      for delete expecting a folder to take its contents with it, so the
//      confirmation says exactly what will survive.
//
// Reads are open to managers, writes are admin-only (requireAdminAccess on
// every mutating route). That asymmetry is deliberate on the API side, so a
// manager landing here gets a page that works in read-only rather than a wall
// of 403s.

import { useCallback, useEffect, useState } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";

interface CategoryDTO {
  id: string;
  name: string;
  sortOrder: number;
}

interface QuickResponseDTO {
  id: string;
  categoryId: string | null;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

/** An unsaved reply. `id` present means editing, absent means creating —
 * the same three fields either way, so one form covers both. */
interface Draft {
  id?: string;
  categoryId: string | null;
  title: string;
  body: string;
}

// Mirrors the zod bounds in api/src/routes/quickResponses.ts. Enforced here
// only so the browser stops someone before a round-trip; the server remains
// the one that decides.
const TITLE_MAX = 100;
const BODY_MAX = 2000;
const CATEGORY_NAME_MAX = 100;

const blank = (categoryId: string | null = null): Draft => ({ categoryId, title: "", body: "" });

/**
 * The API answers {error, detail}. api.ts folds detail into the message, but
 * `detail` for a validation failure is a zod flatten() — an object, which
 * stringifies to "[object Object]". So prefer the message, and fall back to
 * something a human can act on when that's all we got.
 */
function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.isUnavailable) return "Discord didn't answer, so your permissions couldn't be checked. Try again in a moment.";
  if (e.code === "admin_access_required") return "Only server admins can change saved replies.";
  if (e.code === "invalid_body") return "The server rejected those values. Check the title and body lengths.";
  if (e.code === "category_not_found" || e.code === "response_not_found") {
    return "That was already deleted by someone else. Reloading.";
  }
  return e.message || fallback;
}

export default function QuickResponses({ guildId }: { guildId: string }) {
  const [categories, setCategories] = useState<CategoryDTO[] | null>(null);
  const [responses, setResponses] = useState<QuickResponseDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);

  // Two-step confirmation for both destructive actions. A window.confirm()
  // dialog is dismissible by reflex and says nothing about consequences; the
  // inline state lets the button's own row explain what deleting does.
  const [confirmCategory, setConfirmCategory] = useState<string | null>(null);
  const [confirmResponse, setConfirmResponse] = useState<string | null>(null);

  const base = `/api/guilds/${guildId}/quick-responses`;

  const load = useCallback(async () => {
    // Settled rather than all: categories are an organising layer over the
    // replies, not a prerequisite for them. Losing the folders shouldn't cost
    // someone access to the text they came here for.
    const [c, r] = await Promise.allSettled([
      http.get<CategoryDTO[]>(`/api/guilds/${guildId}/quick-responses/categories`),
      http.get<QuickResponseDTO[]>(`/api/guilds/${guildId}/quick-responses`),
    ]);

    if (r.status === "rejected") {
      setFatal(describe(r.reason, "Couldn't load saved replies."));
      return;
    }
    setResponses(r.value);
    setCategories(c.status === "fulfilled" ? c.value : []);
    setCategoryError(
      c.status === "rejected" ? describe(c.reason, "Couldn't load categories.") : null,
    );
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (fatal && !responses) return <Banner level="act" title="Couldn't load">{fatal}</Banner>;
  if (!responses || !categories) return <Loading rows={5} />;

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        const updated = await http.patch<QuickResponseDTO>(`${base}/${draft.id}`, {
          title: draft.title,
          body: draft.body,
          categoryId: draft.categoryId,
        });
        setResponses((prev) => (prev ?? []).map((r) => (r.id === updated.id ? updated : r)));
      } else {
        const created = await http.post<QuickResponseDTO>(base, {
          title: draft.title,
          body: draft.body,
          categoryId: draft.categoryId,
        });
        setResponses((prev) => [...(prev ?? []), created]);
      }
      setDraft(null);
    } catch (e) {
      setError(describe(e, "Couldn't save that reply."));
    } finally {
      setSaving(false);
    }
  }

  /** Filing a reply is a one-field edit, so it happens straight from the row
   * rather than by opening the editor — reorganising twenty replies through a
   * modal is how a category system stops being used. */
  async function assign(row: QuickResponseDTO, categoryId: string | null) {
    setError(null);
    // Optimistic: the select has already moved, and snapping it back on the
    // response would look like a glitch. A failure re-loads instead.
    setResponses((prev) => (prev ?? []).map((r) => (r.id === row.id ? { ...r, categoryId } : r)));
    try {
      await http.patch<QuickResponseDTO>(`${base}/${row.id}`, { categoryId });
    } catch (e) {
      setError(describe(e, "Couldn't move that reply."));
      void load();
    }
  }

  async function removeResponse(id: string) {
    setError(null);
    try {
      await http.del<void>(`${base}/${id}`);
      setResponses((prev) => (prev ?? []).filter((r) => r.id !== id));
      if (draft?.id === id) setDraft(null);
    } catch (e) {
      setError(describe(e, "Couldn't delete that reply."));
    } finally {
      setConfirmResponse(null);
    }
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    setAddingCategory(true);
    setError(null);
    try {
      const created = await http.post<CategoryDTO>(
        `/api/guilds/${guildId}/quick-responses/categories`,
        // sortOrder defaults to 0 server-side; sending the current count keeps
        // new categories appending instead of stacking at the top.
        { name, sortOrder: (categories ?? []).length },
      );
      setCategories((prev) => [...(prev ?? []), created]);
      setNewCategory("");
    } catch (e) {
      setError(describe(e, "Couldn't create that category."));
    } finally {
      setAddingCategory(false);
    }
  }

  async function removeCategory(id: string) {
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/quick-responses/categories/${id}`);
      setCategories((prev) => (prev ?? []).filter((c) => c.id !== id));
      // The server sets categoryId to null on the replies rather than deleting
      // them; mirror that here so the list doesn't have to be refetched to
      // stop showing a category that's gone.
      setResponses((prev) => (prev ?? []).map((r) => (r.categoryId === id ? { ...r, categoryId: null } : r)));
    } catch (e) {
      setError(describe(e, "Couldn't delete that category."));
    } finally {
      setConfirmCategory(null);
    }
  }

  const sortedCategories = [...categories].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  // Unfiled last: it's the bucket, not a category, and putting it first would
  // bury the ones someone deliberately made.
  const groups: { id: string | null; name: string; rows: QuickResponseDTO[] }[] = [
    ...sortedCategories.map((c) => ({
      id: c.id as string | null,
      name: c.name,
      rows: responses.filter((r) => r.categoryId === c.id),
    })),
    { id: null, name: "Unfiled", rows: responses.filter((r) => !r.categoryId) },
  ];

  const countInCategory = (id: string) => responses.filter((r) => r.categoryId === id).length;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Saved replies</h1>
        <p className="dim">
          Reusable text for reviews and tickets. Categories are optional and only
          affect how staff find a reply — nothing about a reply changes when it's filed.
        </p>
      </header>

      {error && <Banner level="act" title="That didn't go through">{error}</Banner>}

      {categoryError && (
        <Banner level="watch" title="Categories didn't load">
          {categoryError} Replies still work — they're just all showing as unfiled until
          this comes back.
        </Banner>
      )}

      <Panel
        title="Categories"
        action={<Pill>{categories.length} total</Pill>}
      >
        {categories.length === 0 ? (
          <Empty
            title="No categories"
            hint="Replies work fine without them — add one only when the list gets long enough to scroll."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Replies</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedCategories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="dim">{countInCategory(c.id)}</td>
                  <td>
                    {confirmCategory === c.id ? (
                      <span className="actions">
                        <span className="dim" style={{ fontSize: 12 }}>
                          {countInCategory(c.id) > 0
                            ? `The ${countInCategory(c.id)} replies inside stay — they become unfiled.`
                            : "Delete this category?"}
                        </span>
                        <button className="btn btn-sm btn-danger" onClick={() => void removeCategory(c.id)}>
                          Delete
                        </button>
                        <button className="btn btn-sm" onClick={() => setConfirmCategory(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button className="btn btn-sm" onClick={() => setConfirmCategory(c.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <label className="field">
          <span className="eyebrow">New category</span>
          <input
            type="text"
            value={newCategory}
            maxLength={CATEGORY_NAME_MAX}
            placeholder="Appeals, Ticket closures, Recruitment…"
            onChange={(e) => setNewCategory(e.target.value)}
          />
        </label>
        <div className="actions">
          <button className="btn" onClick={() => void addCategory()} disabled={addingCategory || !newCategory.trim()}>
            {addingCategory ? "Adding…" : "Add category"}
          </button>
          <span className="dim" style={{ fontSize: 12 }}>
            Categories can't be renamed — the API has no rename route, and deleting one to
            rename it would unfile every reply in it.
          </span>
        </div>
      </Panel>

      <Panel
        title="Replies"
        action={
          draft ? undefined : (
            <button className="btn btn-sm btn-primary" onClick={() => setDraft(blank())}>
              New reply
            </button>
          )
        }
      >
        {draft && (
          <>
            <label className="field">
              <span className="eyebrow">Title</span>
              <input
                type="text"
                value={draft.title}
                maxLength={TITLE_MAX}
                placeholder="What staff will see in the picker"
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>

            <label className="field">
              <span className="eyebrow">Body</span>
              <textarea
                rows={6}
                value={draft.body}
                maxLength={BODY_MAX}
                placeholder="The text that gets sent."
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <span className="dim">
                {draft.body.length} / {BODY_MAX}
              </span>
            </label>

            <label className="field">
              <span className="eyebrow">Category</span>
              <select
                value={draft.categoryId ?? ""}
                onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || null })}
              >
                <option value="">— unfiled —</option>
                {sortedCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="actions">
              <button
                className="btn-primary btn"
                onClick={() => void saveDraft()}
                disabled={saving || !draft.title.trim() || !draft.body.trim()}
              >
                {saving ? "Saving…" : draft.id ? "Save changes" : "Create reply"}
              </button>
              <button className="btn" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </button>
            </div>
          </>
        )}

        {responses.length === 0 ? (
          <Empty title="No saved replies yet" hint="Add the answer you type most often first." />
        ) : (
          groups
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <div key={g.id ?? "unfiled"} style={{ marginTop: 14 }}>
                <span className="eyebrow">
                  {g.name} · {g.rows.length}
                </span>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Body</th>
                      <th>Category</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.title}</td>
                        <td className="dim" style={{ maxWidth: 320 }}>
                          {r.body.length > 90 ? `${r.body.slice(0, 90)}…` : r.body}
                        </td>
                        <td>
                          <select
                            className="input"
                            value={r.categoryId ?? ""}
                            onChange={(e) => void assign(r, e.target.value || null)}
                            aria-label={`Category for ${r.title}`}
                          >
                            <option value="">— unfiled —</option>
                            {sortedCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          {confirmResponse === r.id ? (
                            <span className="actions">
                              <span className="dim" style={{ fontSize: 12 }}>
                                Delete “{r.title}”?
                              </span>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => void removeResponse(r.id)}
                              >
                                Delete
                              </button>
                              <button className="btn btn-sm" onClick={() => setConfirmResponse(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span className="actions">
                              <button
                                className="btn btn-sm"
                                onClick={() =>
                                  setDraft({
                                    id: r.id,
                                    title: r.title,
                                    body: r.body,
                                    categoryId: r.categoryId,
                                  })
                                }
                              >
                                Edit
                              </button>
                              <button className="btn btn-sm" onClick={() => setConfirmResponse(r.id)}>
                                Delete
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
        )}

      </Panel>
    </div>
  );
}
