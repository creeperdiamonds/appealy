// web/src/pages/Forms.tsx
//
// Forms are the thing everything else in the product hangs off: panels point
// at them, submissions belong to them, the ban-appeal flow selects one. So
// this screen is where a server's whole application experience is decided,
// and where it is quietly broken.
//
// The API validates shape. What it cannot validate is intent, and there are
// four configurations it accepts happily that produce a form nobody can
// finish:
//
//   1. An in_server form with more than 5 text questions. Discord modals hold
//      exactly 5 components; the bot slices the rest off and logs a warning
//      nobody reads (bot/src/interactions/buttons/panelOpen.ts). Questions
//      6+ are never asked and the applicant is never told.
//   2. An in_server form with no questions the modal can show. A modal with
//      zero components is rejected by Discord outright — the button appears
//      to do nothing.
//   3. A select question with no options, or more than 25. Discord caps a
//      select menu at 25 options; an empty menu can't be answered at all.
//   4. Question labels over 45 characters on an in_server form. The modal
//      label limit is 45, so the bot truncates with an ellipsis at render
//      time — fine for prose, quietly destructive for a question whose
//      meaning lives at the end of the sentence.
//
// None of these are errors, so none of them can be a toast. They are stated
// inline, next to the field that causes them, and they stay there.
//
// The DM flow has none of these limits: dmApplicationService asks one
// question per message, so every warning here is conditional on
// applicationType being "in_server". Warning about a limit that doesn't
// apply teaches people to ignore warnings.

import { useCallback, useEffect, useState } from "react";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Empty, Pill } from "../components/ui";
import { RolePicker } from "../components/RolePicker";

// --- Shapes, derived from the zod schemas in api/src/routes/forms.ts ---

type QuestionType = "short_text" | "paragraph" | "select";
type MatchMode = "has_all" | "has_any";
type FormKind = "application" | "appeal";
type ApplicationType = "in_server" | "direct_message";

interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

interface QuestionDTO {
  /** Absent on a question this browser just invented. Present rows keep
   *  their id through a save because submissions reference questions by id
   *  and PATCH replaces the whole set — dropping the id would orphan every
   *  answer already collected. */
  id?: string;
  label: string;
  placeholder: string | null;
  type: QuestionType;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  options: QuestionOption[] | null;
  validationType: "none" | "regex";
  validationPattern: string | null;
  validationErrorMessage: string | null;
  sortOrder: number;
}

/** Only the fields this screen reads. The API sends a good deal more
 *  (thread settings, submission windows, denied-decision roles); PATCH
 *  updates only the keys it is given, so leaving them out of the editor
 *  leaves them untouched rather than resetting them. */
interface FormDTO {
  id: string;
  name: string;
  description: string;
  kind: FormKind;
  applicationType: ApplicationType;
  logChannelId: string;
  active: boolean;
  cooldownSeconds: number;
  allowMultiplePending: boolean;
  requiredRoleIds: string[];
  requiredRolesMatchMode: MatchMode;
  blacklistedRoleIds: string[];
  blacklistedRolesMatchMode: MatchMode;
  grantRoleIds: string[];
  removeRoleIds: string[];
  pendingRoleIds: string[];
  pingRoleIds: string[];
  questions: QuestionDTO[];
}

type Draft = Omit<FormDTO, "id"> & { id?: string };

interface GuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

// Discord channel types that can hold a log message: text, announcement,
// and forum. Voice and category rows would be accepted by the select and
// rejected by Discord at send time.
const POSTABLE_CHANNEL_TYPES = [0, 5, 15];

const MODAL_INPUT_LIMIT = 5; // Discord: components per modal
const MODAL_LABEL_LIMIT = 45; // Discord: characters in a text-input label
const SELECT_OPTION_LIMIT = 25; // Discord: options in a select menu
const QUESTION_LIMIT = 10; // ours: questionSchema.max(10) in the API

const QUESTION_TYPES: { value: QuestionType; label: string; hint: string }[] = [
  { value: "short_text", label: "Short answer", hint: "One line" },
  { value: "paragraph", label: "Paragraph", hint: "Multi-line box" },
  { value: "select", label: "Pick from a list", hint: "Asked before the rest" },
];

const blankQuestion = (sortOrder: number): QuestionDTO => ({
  label: "",
  placeholder: null,
  type: "short_text",
  required: true,
  minLength: null,
  maxLength: null,
  options: null,
  validationType: "none",
  validationPattern: null,
  validationErrorMessage: null,
  sortOrder,
});

const blankForm = (): Draft => ({
  name: "",
  description: "",
  kind: "application",
  applicationType: "in_server",
  logChannelId: "",
  active: true,
  cooldownSeconds: 0,
  allowMultiplePending: false,
  requiredRoleIds: [],
  requiredRolesMatchMode: "has_all",
  blacklistedRoleIds: [],
  blacklistedRolesMatchMode: "has_any",
  grantRoleIds: [],
  removeRoleIds: [],
  pendingRoleIds: [],
  pingRoleIds: [],
  questions: [],
});

/**
 * Turns a failed request into something a person can act on.
 *
 * The API answers a rejected body with `{ error: "invalid_body", detail: <zod
 * flatten object> }`, but ApiError passes `detail` straight to `Error`, which
 * stringifies an object to "[object Object]". The field errors are therefore
 * gone by the time this page sees them, and fixing that means editing
 * lib/api.ts. So: unreadable messages get translated by code here, and the
 * `blockers()` checks below exist to catch those bodies before they are ever
 * sent — a 400 reaching this function is a bug in `blockers()`, not the
 * normal path.
 *
 * Cap rejections (429 rate_limit_exceeded) do send a plain-string detail, so
 * those come through verbatim and already read well.
 */
function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.message && e.message !== "[object Object]") return e.message;
  if (e.code === "invalid_body") {
    return "The server rejected these settings. Check question patterns, lengths, and the log channel.";
  }
  if (e.code === "form_not_found") return "This form no longer exists — someone else may have deleted it.";
  if (e.code === "bot_unreachable") return "The bot isn't responding, so its data couldn't be read.";
  return fallback;
}

/**
 * Local pattern check, deliberately shallower than the server's.
 *
 * shared/schema/regexValidation.ts also rejects ReDoS-prone *shapes* —
 * nested quantifiers, quantified alternation, backreferences, lookaround.
 * That analysis is not duplicated here: two copies of a security check drift,
 * and the one that matters is the one on the write path. This catches the
 * mistakes people actually make (unbalanced brackets, an empty pattern), and
 * the server stays the authority on the rest.
 */
function patternProblem(pattern: string): string | null {
  if (pattern.trim().length === 0) return "A pattern is required when validation is on.";
  if (pattern.length > 256) return "Patterns are capped at 256 characters.";
  try {
    new RegExp(pattern);
  } catch (err) {
    return `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** Everything the API would reject. Checked before sending, because its
 *  rejection arrives without field detail (see `describe`). */
function blockers(d: Draft): string[] {
  const out: string[] = [];
  if (!d.name.trim()) out.push("The form needs a name.");
  if (d.name.length > 100) out.push("Names are capped at 100 characters.");
  if (!d.logChannelId) out.push("Pick a log channel — the API requires one on every form.");
  if (d.kind === "appeal" && d.applicationType !== "direct_message") {
    out.push('Appeal forms must be delivered by DM: a banned member can\'t reach a channel or /apply.');
  }
  if (d.questions.length > QUESTION_LIMIT) {
    out.push(`A form holds at most ${QUESTION_LIMIT} questions.`);
  }
  d.questions.forEach((q, i) => {
    const at = `Question ${i + 1}`;
    if (!q.label.trim()) out.push(`${at} needs a label.`);
    if (q.label.length > 200) out.push(`${at}'s label is over 200 characters.`);
    if (q.maxLength !== null && q.maxLength > 4000) out.push(`${at}'s maximum length can't exceed 4000.`);
    if (q.minLength !== null && q.minLength < 0) out.push(`${at}'s minimum length can't be negative.`);
    if (q.minLength !== null && q.maxLength !== null && q.minLength > q.maxLength) {
      out.push(`${at} has a minimum longer than its maximum, which nothing can satisfy.`);
    }
    if (q.validationType === "regex") {
      if (q.type === "select") out.push(`${at} can't use pattern validation — the answer comes from a list.`);
      const p = patternProblem(q.validationPattern ?? "");
      if (p) out.push(`${at}: ${p}`);
    }
  });
  return out;
}

export default function Forms({ guildId }: { guildId: string }) {
  const [forms, setForms] = useState<FormDTO[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Id of the form a delete has been proposed for. Deleting a form takes its
  // submissions and its panel buttons with it, so the second click is the one
  // that counts — and it is a different button, not the same one twice.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setForms(await http.get<FormDTO[]>(`/api/guilds/${guildId}/forms`));
    } catch (e) {
      setError(describe(e, "Couldn't load forms."));
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !forms) return <Banner level="act" title="Couldn't load">{error}</Banner>;
  if (!forms) return <Loading rows={5} />;

  const patch = (next: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setSaved(false);
  };

  const patchQuestion = (i: number, next: Partial<QuestionDTO>) => {
    setDraft((d) =>
      d ? { ...d, questions: d.questions.map((q, n) => (n === i ? { ...q, ...next } : q)) } : d,
    );
    setSaved(false);
  };

  const move = (i: number, by: number) => {
    setDraft((d) => {
      if (!d) return d;
      const to = i + by;
      if (to < 0 || to >= d.questions.length) return d;
      const next = [...d.questions];
      [next[i], next[to]] = [next[to], next[i]];
      return { ...d, questions: next };
    });
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
    try {
      // sortOrder is the array index rather than a field anyone edits:
      // the list on screen is the order, so there is nothing to keep in sync.
      const body = {
        name: draft.name.trim(),
        description: draft.description,
        kind: draft.kind,
        applicationType: draft.applicationType,
        logChannelId: draft.logChannelId,
        active: draft.active,
        cooldownSeconds: draft.cooldownSeconds,
        allowMultiplePending: draft.allowMultiplePending,
        requiredRoleIds: draft.requiredRoleIds,
        requiredRolesMatchMode: draft.requiredRolesMatchMode,
        blacklistedRoleIds: draft.blacklistedRoleIds,
        blacklistedRolesMatchMode: draft.blacklistedRolesMatchMode,
        grantRoleIds: draft.grantRoleIds,
        removeRoleIds: draft.removeRoleIds,
        pendingRoleIds: draft.pendingRoleIds,
        pingRoleIds: draft.pingRoleIds,
        questions: draft.questions.map((q, i) => ({
          ...q,
          sortOrder: i,
          // A "none" form still carries whatever pattern was typed before the
          // dropdown was switched back. The API nulls those columns itself;
          // sending them anyway would fail the regex-safety check for a rule
          // that is no longer in force.
          validationPattern: q.validationType === "regex" ? q.validationPattern : null,
          validationErrorMessage: q.validationType === "regex" ? q.validationErrorMessage : null,
        })),
      };

      const result = draft.id
        ? await http.patch<FormDTO>(`/api/guilds/${guildId}/forms/${draft.id}`, body)
        : await http.post<FormDTO>(`/api/guilds/${guildId}/forms`, body);

      setForms(
        draft.id ? forms!.map((f) => (f.id === result.id ? result : f)) : [...forms!, result],
      );
      setDraft(result);
      setSaved(true);
    } catch (e) {
      setError(describe(e, "Couldn't save this form."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await http.del<void>(`/api/guilds/${guildId}/forms/${id}`);
      setForms(forms!.filter((f) => f.id !== id));
      setConfirmDelete(null);
      if (draft?.id === id) setDraft(null);
    } catch (e) {
      setError(describe(e, "Couldn't delete this form."));
    }
  }

  const pending = confirmDelete ? forms.find((f) => f.id === confirmDelete) ?? null : null;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Forms</h1>
        <p className="dim">
          What applicants are asked, who may apply, and what happens to their roles when
          they do.
        </p>
      </header>

      {error && (
        <Banner level="act" title="Heads up">
          {error}
        </Banner>
      )}

      {pending && (
        <Banner
          level="act"
          title={`Delete "${pending.name}"?`}
          action={
            <div className="actions">
              <button className="btn-danger" onClick={() => void remove(pending.id)}>
                Delete it
              </button>
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Keep it
              </button>
            </div>
          }
        >
          Its submissions and its history go with it, and any panel button pointing at it
          stops working. This can't be undone.
        </Banner>
      )}

      <Panel
        eyebrow="This server"
        title="Forms"
        action={
          <button className="btn" onClick={() => { setDraft(blankForm()); setSaved(false); }}>
            New form
          </button>
        }
      >
        {forms.length === 0 ? (
          <Empty
            title="No forms yet"
            hint="Create one, then point a panel or the ban-appeal flow at it."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Delivery</th>
                <th>Questions</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td>
                    <strong>{f.name}</strong>
                    {f.kind === "appeal" && <span className="dim block">ban appeal</span>}
                  </td>
                  <td className="dim">
                    {f.applicationType === "direct_message" ? "Direct message" : "In server"}
                  </td>
                  <td className="dim">{f.questions.length}</td>
                  <td>
                    <Pill level={f.active ? "ok" : "watch"}>{f.active ? "active" : "inactive"}</Pill>
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="btn btn-sm"
                        onClick={() => { setDraft({ ...f }); setSaved(false); setError(null); }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(f.id)}>
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
        <FormEditor
          key={draft.id ?? "new"}
          guildId={guildId}
          draft={draft}
          saving={saving}
          saved={saved}
          onPatch={patch}
          onPatchQuestion={patchQuestion}
          onMove={move}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setError(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editor
 *
 * Split out only because the list above stays readable that way; it holds
 * no state of its own, so there is never a version of the form on screen
 * that the page doesn't know about.
 * ------------------------------------------------------------------ */

function FormEditor({
  guildId,
  draft,
  saving,
  saved,
  onPatch,
  onPatchQuestion,
  onMove,
  onSave,
  onCancel,
}: {
  guildId: string;
  draft: Draft;
  saving: boolean;
  saved: boolean;
  onPatch: (next: Partial<Draft>) => void;
  onPatchQuestion: (i: number, next: Partial<QuestionDTO>) => void;
  onMove: (i: number, by: number) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inServer = draft.applicationType === "in_server";
  const textQuestions = draft.questions.filter((q) => q.type !== "select");
  const selectQuestions = draft.questions.filter((q) => q.type === "select");

  // The modal is built from text questions only — selects are asked first, in
  // their own ephemeral message, so they don't consume one of the five slots.
  const overModalLimit = inServer && textQuestions.length > MODAL_INPUT_LIMIT;
  const emptyModal = inServer && textQuestions.length === 0 && selectQuestions.length === 0;

  return (
    <>
      <Panel title={draft.id ? "Edit form" : "New form"}>
        <label className="field">
          <span className="eyebrow">Name</span>
          <input
            value={draft.name}
            maxLength={100}
            placeholder="Staff application"
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="eyebrow">Description</span>
          <textarea
            rows={3}
            value={draft.description}
            maxLength={500}
            placeholder="Shown to the applicant before they start."
            onChange={(e) => onPatch({ description: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="eyebrow">Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => {
              const kind = e.target.value as FormKind;
              // Switching to "appeal" forces DM delivery rather than letting
              // the save fail: the API rejects the pair, and its rejection
              // arrives without field detail (see describe()).
              onPatch(kind === "appeal" ? { kind, applicationType: "direct_message" } : { kind });
            }}
          >
            <option value="application">Application — panels, /apply</option>
            <option value="appeal">Ban appeal — DM'd to banned members</option>
          </select>
          {draft.kind === "appeal" && (
            <span className="dim">
              Appeal forms are reachable only through the ban-time DM, so delivery is fixed to
              direct message. Select it under Ban appeals to actually use it.
            </span>
          )}
        </label>

        <label className="field">
          <span className="eyebrow">Delivery</span>
          <select
            value={draft.applicationType}
            disabled={draft.kind === "appeal"}
            onChange={(e) => onPatch({ applicationType: e.target.value as ApplicationType })}
          >
            <option value="in_server">In server — a Discord pop-up form</option>
            <option value="direct_message">Direct message — one question at a time</option>
          </select>
          <span className="dim">
            {inServer
              ? "A pop-up holds five text questions and nothing more. DM delivery has no such limit."
              : "The bot asks in DMs, one message per question, and resumes if it restarts mid-conversation."}
          </span>
        </label>

        <ChannelSelect
          guildId={guildId}
          label="Log channel"
          value={draft.logChannelId}
          onChange={(id) => onPatch({ logChannelId: id })}
          hint="Where submissions land for review. Required — a form with nowhere to post is a form nobody reviews."
        />

        <label className="row">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => onPatch({ active: e.target.checked })}
          />
          <span>
            <strong>Active</strong>
            <span className="dim block">
              Inactive forms stay configured but refuse new applications — the panel button
              answers "this form is no longer available."
            </span>
          </span>
        </label>

        <label className="field">
          <span className="eyebrow">Cooldown between applications (seconds)</span>
          <input
            className="input"
            type="number"
            min={0}
            value={draft.cooldownSeconds}
            onChange={(e) => onPatch({ cooldownSeconds: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="dim">0 means someone denied at 10:00 can reapply at 10:01.</span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={draft.allowMultiplePending}
            onChange={(e) => onPatch({ allowMultiplePending: e.target.checked })}
          />
          <span>
            <strong>Allow more than one application waiting at a time</strong>
            <span className="dim block">
              Off is the safer default: it stops one person filling the review queue while
              their first application is still open.
            </span>
          </span>
        </label>
      </Panel>

      <Panel title="Who may apply" eyebrow="Gating">
        <RolePicker
          guildId={guildId}
          label="Required roles"
          value={draft.requiredRoleIds}
          onChange={(ids) => onPatch({ requiredRoleIds: ids })}
          hint="Empty means anyone may apply."
        />
        {draft.requiredRoleIds.length > 1 && (
          <label className="field">
            <span className="eyebrow">Match</span>
            <select
              value={draft.requiredRolesMatchMode}
              onChange={(e) => onPatch({ requiredRolesMatchMode: e.target.value as MatchMode })}
            >
              <option value="has_all">Must have every one of them</option>
              <option value="has_any">Any one of them is enough</option>
            </select>
          </label>
        )}

        <RolePicker
          guildId={guildId}
          label="Blocked roles"
          value={draft.blacklistedRoleIds}
          onChange={(ids) => onPatch({ blacklistedRoleIds: ids })}
          hint="Anyone holding these can't apply — usually a punishment role."
        />
        {draft.blacklistedRoleIds.length > 1 && (
          <label className="field">
            <span className="eyebrow">Match</span>
            <select
              value={draft.blacklistedRolesMatchMode}
              onChange={(e) => onPatch({ blacklistedRolesMatchMode: e.target.value as MatchMode })}
            >
              <option value="has_any">Any one of them blocks (usual choice)</option>
              <option value="has_all">Only blocked when they hold all of them</option>
            </select>
          </label>
        )}
      </Panel>

      <Panel title="Roles" eyebrow="What the bot does">
        <RolePicker
          guildId={guildId}
          label="Granted on accept"
          value={draft.grantRoleIds}
          onChange={(ids) => onPatch({ grantRoleIds: ids })}
        />
        <RolePicker
          guildId={guildId}
          label="Removed on accept"
          value={draft.removeRoleIds}
          onChange={(ids) => onPatch({ removeRoleIds: ids })}
        />
        <RolePicker
          guildId={guildId}
          label="Held while pending"
          value={draft.pendingRoleIds}
          onChange={(ids) => onPatch({ pendingRoleIds: ids })}
          hint="Given on submit and taken back on a decision — useful for an 'applied' marker."
        />
        <RolePicker
          guildId={guildId}
          label="Pinged when one arrives"
          value={draft.pingRoleIds}
          onChange={(ids) => onPatch({ pingRoleIds: ids })}
          hint="Mentioned in the log channel. Nothing else in this list mentions anyone."
        />

        {draft.grantRoleIds.length > 0 && (
          <span className="dim">
            The bot can only apply roles below its own highest role. Roles it can't reach are
            marked in the pickers above.
          </span>
        )}
      </Panel>

      <Panel
        title="Questions"
        eyebrow={`${draft.questions.length} of ${QUESTION_LIMIT}`}
        action={
          <button
            className="btn"
            disabled={draft.questions.length >= QUESTION_LIMIT}
            onClick={() =>
              onPatch({ questions: [...draft.questions, blankQuestion(draft.questions.length)] })
            }
          >
            Add question
          </button>
        }
      >
        {/* Both of these describe a form the API will happily store and an
            applicant cannot complete, so they live here permanently rather
            than appearing on save. */}
        {overModalLimit && (
          <Banner level="act" title={`Only the first ${MODAL_INPUT_LIMIT} will ever be asked`}>
            Discord pop-up forms hold {MODAL_INPUT_LIMIT} text inputs. This form has{" "}
            {textQuestions.length}, so the bot drops the rest at send time and the applicant is
            never shown them. Cut it down, or switch delivery to direct message — DMs ask one
            question per message and have no cap.
          </Banner>
        )}

        {emptyModal && (
          <Banner level="act" title="This form asks nothing">
            Discord refuses a pop-up with no fields, so the button appears to do nothing at all.
            Add a question before publishing a panel that points here.
          </Banner>
        )}

        {draft.questions.length === 0 && !emptyModal && (
          <Empty title="No questions yet" hint="Add the first one above." />
        )}

        {draft.questions.map((q, i) => (
          <QuestionEditor
            key={q.id ?? `new-${i}`}
            index={i}
            total={draft.questions.length}
            question={q}
            inServer={inServer}
            onPatch={(next) => onPatchQuestion(i, next)}
            onMove={(by) => onMove(i, by)}
            onRemove={() => onPatch({ questions: draft.questions.filter((_, n) => n !== i) })}
          />
        ))}
      </Panel>

      <div className="actions">
        <button className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : draft.id ? "Save" : "Create form"}
        </button>
        <button className="btn" onClick={onCancel} disabled={saving}>
          {draft.id ? "Close" : "Discard"}
        </button>
        {saved && <span className="dim">Saved.</span>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * One question
 * ------------------------------------------------------------------ */

function QuestionEditor({
  index,
  total,
  question,
  inServer,
  onPatch,
  onMove,
  onRemove,
}: {
  index: number;
  total: number;
  question: QuestionDTO;
  inServer: boolean;
  onPatch: (next: Partial<QuestionDTO>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  // Removing a question deletes every answer already given to it, since PATCH
  // replaces the whole question set. One click shouldn't do that.
  const [confirming, setConfirming] = useState(false);

  const q = question;
  const isSelect = q.type === "select";
  const options = q.options ?? [];
  const labelTooLong = inServer && q.label.length > MODAL_LABEL_LIMIT;
  const patternIssue =
    q.validationType === "regex" ? patternProblem(q.validationPattern ?? "") : null;

  const setOptions = (next: QuestionOption[]) => onPatch({ options: next.length ? next : null });

  return (
    <Panel className="stack">
      <div className="row spread wrap">
        <span className="eyebrow">Question {index + 1}</span>
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
          <button className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
            Remove
          </button>
        </div>
      </div>

      {confirming && (
        <Banner
          level="act"
          title="Remove this question?"
          action={
            <div className="actions">
              <button className="btn-danger" onClick={onRemove}>
                Remove
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          }
        >
          Saving after this drops every answer already given to it — past submissions will show
          the question as gone rather than unanswered.
        </Banner>
      )}

      <label className="field">
        <span className="eyebrow">Label</span>
        <input
          value={q.label}
          maxLength={200}
          placeholder="Why do you want to join the staff team?"
          onChange={(e) => onPatch({ label: e.target.value })}
        />
        {labelTooLong && (
          <span className="dim">
            Over {MODAL_LABEL_LIMIT} characters. Discord truncates pop-up labels with an ellipsis,
            so anything after character {MODAL_LABEL_LIMIT} is never read — keep the point at the
            front.
          </span>
        )}
      </label>

      <label className="field">
        <span className="eyebrow">Type</span>
        <select
          value={q.type}
          onChange={(e) => {
            const type = e.target.value as QuestionType;
            // Pattern validation can't apply to an answer chosen from a list,
            // and the API refuses the pair outright.
            onPatch(
              type === "select"
                ? { type, validationType: "none", validationPattern: null, options: q.options ?? [] }
                : { type },
            );
          }}
        >
          {QUESTION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label} — {t.hint}
            </option>
          ))}
        </select>
        {isSelect && inServer && (
          <span className="dim">
            List questions are asked first, in their own message, before the pop-up opens — they
            don't use up one of the five text slots.
          </span>
        )}
      </label>

      <label className="field">
        <span className="eyebrow">Placeholder</span>
        <input
          value={q.placeholder ?? ""}
          maxLength={100}
          placeholder="Shown greyed-out in the empty box"
          onChange={(e) => onPatch({ placeholder: e.target.value || null })}
        />
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={q.required}
          onChange={(e) => onPatch({ required: e.target.checked })}
        />
        <span>
          <strong>Required</strong>
        </span>
      </label>

      {isSelect ? (
        <div className="field">
          <span className="eyebrow">Options</span>

          {options.length === 0 && (
            <Banner level="act" title="A list with nothing in it">
              An empty menu can't be answered, so the application stops here. Add at least one
              option.
            </Banner>
          )}

          {options.length > SELECT_OPTION_LIMIT && (
            <Banner level="act" title={`Only ${SELECT_OPTION_LIMIT} will appear`}>
              Discord menus hold {SELECT_OPTION_LIMIT} options. The rest are dropped at send time
              — nobody can choose them.
            </Banner>
          )}

          {options.map((o, n) => (
            <div className="row wrap" key={n}>
              <input
                value={o.label}
                placeholder="What the applicant sees"
                onChange={(e) => {
                  const next = [...options];
                  // The stored value is what lands in the submission record.
                  // Keeping it in step with the label while it hasn't been
                  // edited separately spares people a field whose purpose is
                  // invisible until it's wrong.
                  const wasMirrored = next[n].value === next[n].label;
                  next[n] = {
                    ...next[n],
                    label: e.target.value,
                    value: wasMirrored ? e.target.value : next[n].value,
                  };
                  setOptions(next);
                }}
              />
              <button
                className="btn btn-sm btn-danger"
                onClick={() => setOptions(options.filter((_, x) => x !== n))}
                aria-label={`Remove option ${n + 1}`}
              >
                ×
              </button>
            </div>
          ))}

          <button
            className="btn"
            disabled={options.length >= SELECT_OPTION_LIMIT}
            onClick={() => setOptions([...options, { label: "", value: "" }])}
          >
            Add option
          </button>
        </div>
      ) : (
        <div className="row wrap">
          <label className="field">
            <span className="eyebrow">Minimum length</span>
            <input
              className="input"
              type="number"
              min={0}
              value={q.minLength ?? ""}
              placeholder="none"
              onChange={(e) =>
                onPatch({ minLength: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="eyebrow">Maximum length</span>
            <input
              className="input"
              type="number"
              min={0}
              max={4000}
              value={q.maxLength ?? ""}
              placeholder="4000"
              onChange={(e) =>
                onPatch({ maxLength: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </label>
        </div>
      )}

      {!isSelect && (
        <>
          <label className="field">
            <span className="eyebrow">Answer must match a pattern</span>
            <select
              value={q.validationType}
              onChange={(e) => onPatch({ validationType: e.target.value as "none" | "regex" })}
            >
              <option value="none">No — accept anything</option>
              <option value="regex">Yes — check it against a regular expression</option>
            </select>
          </label>

          {q.validationType === "regex" && (
            <>
              <label className="field">
                <span className="eyebrow">Pattern</span>
                <input
                  value={q.validationPattern ?? ""}
                  maxLength={256}
                  placeholder="^[0-9]{17,20}$"
                  onChange={(e) => onPatch({ validationPattern: e.target.value || null })}
                />
                <span className="dim">
                  {patternIssue ??
                    "Backreferences and lookaround are refused, along with patterns that can be made to run away — one bad expression stalls the bot for everyone."}
                </span>
              </label>

              <label className="field">
                <span className="eyebrow">What to say when it doesn't match</span>
                <input
                  value={q.validationErrorMessage ?? ""}
                  maxLength={200}
                  placeholder="That doesn't look like a Steam ID."
                  onChange={(e) => onPatch({ validationErrorMessage: e.target.value || null })}
                />
                <span className="dim">
                  Without this the applicant is told only that their answer was rejected, which
                  they can't act on.
                </span>
              </label>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Channel picker
 *
 * Same bargain RolePicker.tsx makes: the channel list comes from the bot's
 * REST session, so when the bot is down the list is gone. Falling back to a
 * raw ID field keeps the editor usable instead of trapping someone mid-edit
 * behind an outage they can't fix.
 * ------------------------------------------------------------------ */

function ChannelSelect({
  guildId,
  label,
  value,
  onChange,
  hint,
}: {
  guildId: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  hint?: string;
}) {
  const [channels, setChannels] = useState<GuildChannel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    http
      .get<GuildChannel[]>(`/api/guilds/${guildId}/resources/channels`)
      .then(setChannels)
      .catch(() => setFailed(true));
  }, [guildId]);

  if (failed) {
    return (
      <label className="field">
        <span className="eyebrow">{label}</span>
        <input
          value={value}
          placeholder="Channel ID"
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <span className="dim">
          Couldn't reach the bot to list channels, so this is an ID for now. It'll come back on
          its own once the bot is up.
        </span>
      </label>
    );
  }

  const postable = (channels ?? [])
    .filter((c) => POSTABLE_CHANNEL_TYPES.includes(c.type))
    .sort((a, b) => a.position - b.position);

  // A channel that was deleted, or one the bot can no longer see, would
  // otherwise vanish from the select and silently reassign the form to
  // whatever sits at the top of the list.
  const orphaned = value && !postable.some((c) => c.id === value);

  return (
    <label className="field">
      <span className="eyebrow">{label}</span>
      <select value={value} disabled={!channels} onChange={(e) => onChange(e.target.value)}>
        <option value="">{channels ? "— pick a channel —" : "Loading channels…"}</option>
        {orphaned && <option value={value}>Unknown channel ({value})</option>}
        {postable.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
      {orphaned && (
        <span className="dim">
          The bot can't see this channel any more — it may have been deleted, or its permissions
          changed. Messages sent there will fail.
        </span>
      )}
      {hint && <span className="dim">{hint}</span>}
    </label>
  );
}
