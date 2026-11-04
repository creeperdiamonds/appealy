// bot/src/services/pendingPrompts.ts
//
// "Ask that person a question and wait for their answer."
//
// Used by /poll when the close time names a timezone that could be more than
// one place: it shows a menu and waits for the pick, which arrives through
// interactions/selects/timezonePick.ts.
//
// It used to wait for the person's next typed message too, read from
// events/messageCreate.ts. That needed the Message Content intent, so the
// close time became a command option instead (2026-11-03) and only menu picks
// arrive here now.
//
// IN MEMORY, ON PURPOSE
// ---------------------
// A prompt does not survive a restart, and the waiter simply times out. That
// is the right trade for a two-minute question: nothing is persisted that
// could be left inconsistent, and the person is told to run the command again.
//
// Sharding does not break this. Discord routes a guild's interactions to the
// same shard, so the process that asked the question is the process that
// receives the answer.

const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (text: string | null) => void;
  // Not `number`: Deno's setTimeout returns a number, but the bot builds
  // against node types where it is a Timeout object.
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

function key(channelId: bigint, userId: bigint): string {
  return `${channelId}:${userId}`;
}

/**
 * Waits for `userId`'s answer in `channelId`.
 *
 * Resolves with the answer, or null if it times out. Never rejects —
 * a caller that has already posted a question to a channel needs an answer
 * or a timeout, not an exception to handle.
 */
export function awaitReply(
  channelId: bigint,
  userId: bigint,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const k = key(channelId, userId);

  // Someone running the command twice replaces their own earlier prompt
  // rather than stacking two waiters on one key, where the second would
  // silently never resolve.
  const existing = pending.get(k);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(k);
    existing.resolve(null);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(k);
      resolve(null);
    }, timeoutMs);
    pending.set(k, { resolve, timer });
  });
}

/** Hands an answer to a waiting prompt. Returns whether anything was waiting for it. */
export function deliverReply(channelId: bigint, userId: bigint, text: string): boolean {
  const k = key(channelId, userId);
  const waiter = pending.get(k);
  if (!waiter) return false;

  clearTimeout(waiter.timer);
  pending.delete(k);
  waiter.resolve(text);
  return true;
}

/** Drops a prompt without answering it. For a caller that gives up first. */
export function cancelPrompt(channelId: bigint, userId: bigint): void {
  const k = key(channelId, userId);
  const waiter = pending.get(k);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(k);
  waiter.resolve(null);
}
