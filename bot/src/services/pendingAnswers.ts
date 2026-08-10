// bot/src/services/pendingAnswers.ts
//
// Select-menu questions are answered before the modal is shown (Discord
// modals can't contain select components), so we stash those answers
// keyed by (userId, formId) in Redis with a short TTL, then merge them
// with the modal's text answers on final submit.

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

export async function stashPendingSelectAnswers(
  userId: bigint,
  formId: string,
  questionId: string,
  value: string,
) {
  const k = key(userId, formId);
  const existingRaw = await (await getRedis()).get(k);
  const existing: Record<string, string> = existingRaw ? JSON.parse(existingRaw) : {};
  existing[questionId] = value;
  await (await getRedis()).set(k, JSON.stringify(existing), { ex: TTL_SECONDS });
}

export async function getPendingSelectAnswers(
  userId: bigint,
  formId: string,
): Promise<Record<string, string>> {
  const raw = await (await getRedis()).get(key(userId, formId));
  return raw ? JSON.parse(raw) : {};
}

export async function clearPendingSelectAnswers(userId: bigint, formId: string) {
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
