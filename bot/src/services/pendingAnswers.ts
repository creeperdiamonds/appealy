// bot/src/services/pendingAnswers.ts
//
// Partial answers for an application that spans more than one interaction,
// keyed by (userId, formId) in Redis with a short TTL and merged on final
// submit. Two things put an application in that position:
//
//   1. Select-menu questions, which are answered before the modal opens
//      because Discord modals cannot contain select components.
//   2. Text questions past the fifth, because a modal holds at most five
//      components. Those pages are stashed here as each one is submitted.
//
// Both write to the SAME key, which is what lets formSubmit.ts merge every
// source with one read. The blob is a flat Record<questionId, value>, so a
// page and a select answer are indistinguishable by the time they land — and
// they should be, since a question is a question.

// Uses the shared lazy connection from core/redis.ts. This module used to do
// its own module-level `await connect(...)`, which was the last holdout of
// the pattern core/redis.ts was written to remove — and worse than the
// originals, because it opened a SECOND connection alongside the singleton.
//
// The import-time cost was real: panelOpen.ts, formSubmit.ts and
// formSelectStep.ts all import this, so the whole interaction path pulled a
// Redis round trip into module evaluation, before main() ran.
import { getRedis } from "../core/redis.ts";

const TTL_SECONDS = 60 * 15; // 15 minutes to complete a multi-step application

function key(userId: bigint, formId: string) {
  return `appealy:pending_answers:${userId}:${formId}`;
}

/**
 * Merges a batch of answers into the stash.
 *
 * Deliberately allowed to throw. Every caller is holding answers a person has
 * already typed, and the only alternative to failing loudly is submitting an
 * application that is quietly missing a page — which is the exact failure this
 * whole mechanism exists to end.
 */
export async function stashPendingAnswers(
  userId: bigint,
  formId: string,
  answers: Record<string, string>,
) {
  const k = key(userId, formId);
  const redis = await getRedis();
  const existingRaw = await redis.get(k);
  const existing: Record<string, string> = existingRaw ? JSON.parse(existingRaw) : {};
  await redis.set(k, JSON.stringify({ ...existing, ...answers }), { ex: TTL_SECONDS });
}

/** One select answer. A thin wrapper so there is one write path, not two. */
export async function stashPendingSelectAnswers(
  userId: bigint,
  formId: string,
  questionId: string,
  value: string,
) {
  await stashPendingAnswers(userId, formId, { [questionId]: value });
}

export async function getPendingAnswers(
  userId: bigint,
  formId: string,
): Promise<Record<string, string>> {
  const raw = await (await getRedis()).get(key(userId, formId));
  return raw ? JSON.parse(raw) : {};
}

export async function clearPendingAnswers(userId: bigint, formId: string) {
  await (await getRedis()).del(key(userId, formId));
}

// Tracks when an in_server applicant first opened the modal, so
// formSubmit.ts can compute completionSeconds. Kept as a separate key
// (rather than folded into the answers blob) since it's written once at
// modal-open time regardless of whether the form has any select questions.
function startedKey(userId: bigint, formId: string) {
  return `appealy:application_started:${userId}:${formId}`;
}

export async function markApplicationStarted(userId: bigint, formId: string) {
  await (await getRedis()).set(startedKey(userId, formId), String(Date.now()), { ex: TTL_SECONDS });
}

export async function getApplicationStartedAt(userId: bigint, formId: string): Promise<number | null> {
  const raw = await (await getRedis()).get(startedKey(userId, formId));
  return raw ? Number(raw) : null;
}
