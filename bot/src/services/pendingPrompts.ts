// bot/src/services/pendingPrompts.ts
//
// "Ask a question in the channel and wait for that person's next message."
//
// Used by /poll to collect a close time conversationally — the bot asks
// "when should this close?" and the author types "1h 20m" or "july 10"
// rather than fighting a slash-command option into expressing it.
//
// IN MEMORY, ON PURPOSE
// ---------------------
// This is read by events/messageCreate.ts, which that file's own header calls
// the highest-frequency handler in the bot: it fires per message, across
// every channel of every guild, and has been tuned down to one Map lookup and
// no syscall for the ~99% case. A Redis or Postgres read per message to check
// for a pending prompt would undo precisely the work that file exists to
// protect, to serve a question that is outstanding for at most two minutes a
// few times a day.
//
// hasPendingPrompts() exists so the common case costs an integer compare
// rather than building a key string that is then looked up in an empty Map.
//
// The cost of memory is that a prompt does not survive a restart, and the
// waiter simply times out. That is the right trade for a two-minute
// conversational prompt: nothing is persisted that could be left inconsistent,
// and the person is told to run the command again.
//
// Sharding does not break this. Discord routes a guild's interactions and its
// messages to the same shard, so the process that asked the question is the
// process that receives the answer.

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

/** True if anything anywhere is waiting. The hot path's first check. */
export function hasPendingPrompts(): boolean {
  return pending.size > 0;
}

/**
 * Waits for `userId`'s next message in `channelId`.
 *
 * Resolves with the message text, or null if it times out. Never rejects —
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

/**
 * Hands a message to a waiting prompt.
 *
 * Returns whether it was consumed, so the caller knows to stop processing the
 * message — an answer to the bot's question is not also a sticky-message bump
 * or a command.
 */
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
