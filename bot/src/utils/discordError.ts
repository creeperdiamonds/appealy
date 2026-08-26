// bot/src/utils/discordError.ts
//
// Discordeno v20 rejects with Error("Failed to send request to discord.")
// for every REST failure — a closed DM, a missing permission, an expired
// interaction token and a DNS blip all produce that same sentence. On
// 2026-08-23 the flagship review action failed for three days and the logs
// were indistinguishable from noise.
//
// Rather than assume a shape that may change between library versions, this
// walks the error, any `body` it carries, and its `cause` chain, taking the
// first usable value it finds at each level. Anything it cannot read
// degrades to the original message rather than throwing.

/** Discordeno's wrapper message, which tells you nothing on its own. */
const GENERIC = "Failed to send request to discord.";

/** How far down a cause chain to look before giving up. */
const MAX_DEPTH = 4;

export interface DiscordErrorInfo {
  /** HTTP status, when discoverable. */
  status: number | null;
  /** Discord's JSON error code, e.g. 10062 Unknown Interaction. */
  code: number | null;
  /** The most specific human-readable message available. */
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function describeDiscordError(err: unknown): DiscordErrorInfo {
  const levels: Record<string, unknown>[] = [];
  let cursor: unknown = err;

  for (let depth = 0; depth < MAX_DEPTH && cursor != null; depth++) {
    const record = asRecord(cursor);
    if (!record) break;
    levels.push(record);
    const body = asRecord(record.body);
    if (body) levels.push(body);
    cursor = record.cause;
  }

  let status: number | null = null;
  let code: number | null = null;
  const messages: string[] = [];

  for (const level of levels) {
    if (status === null) status = pickNumber(level, ["status", "statusCode", "httpStatus"]);
    if (code === null) code = pickNumber(level, ["code", "errorCode"]);
    if (typeof level.message === "string" && level.message) messages.push(level.message);
  }

  // The wrapper's own message is the least useful one available, so it is
  // only chosen when nothing deeper offered anything.
  const message = messages.find((m) => m !== GENERIC) ?? messages[0] ?? String(err);

  // Deliberately no `raw` field. There was one — JSON.stringify of exactly
  // the three values above, truncated — and it was logged beside them at
  // every call site, so it carried strictly less information than its own
  // neighbours while its name promised the opposite. A field called `raw`
  // that is not the raw error is a trap for whoever is reading these logs
  // at 2am. If the untouched error is ever wanted, log `String(err)` or the
  // stack at the call site, where the original object is still in hand.
  return { status, code, message };
}

/**
 * True when Discord rejected the interaction token as unknown.
 *
 * In practice this means the handler took longer than three seconds to make
 * its first response. Treat it as a latency bug in the handler, not as a
 * transient Discord failure — retrying cannot help, because the token is
 * already gone.
 */
export function isUnknownInteraction(info: DiscordErrorInfo): boolean {
  return info.code === 10062;
}
