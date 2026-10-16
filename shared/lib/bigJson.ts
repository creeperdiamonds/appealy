// shared/lib/bigJson.ts
//
// JSON.parse, except that integers too big for a JavaScript number come back
// as strings instead of being rounded.
//
// Why it exists: drizzle's relational queries (`db.query.x.findFirst({ with:
// { ... } })`) fetch the related rows as Postgres `json` and parse it, and
// every Discord id in a bigint column inside it went through JSON.parse as a
// number. A snowflake is past 2^53, so it was silently rounded to a different
// id: 1489336236060447014 came back as 1489336236060446976. Anything that
// read an id that way talked to a channel that doesn't exist. Ticket
// transcripts never posted once (ticket.config.transcriptChannelId, Unknown
// Channel), and the review flows read the form's channels the same way.
//
// As a string, the id reaches drizzle's bigint column intact, and its
// BigInt(value) is exact. Top-level columns never went through JSON and were
// always right, which is why most of the bot worked.
//
// Used as the parser for Postgres `json` (not `jsonb`) in both database
// clients (bot/src/db/client.ts, api/src/db/client.ts). No table has a `json`
// column, so in practice only drizzle's nested rows use it; `jsonb` columns
// keep the driver's own parser.

/** Turns every integer literal outside a string that isn't a safe integer into a string. */
export function quoteBigIntegers(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // Copy the whole string, escapes included.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const literal = text.slice(i, j);
      out += /^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal)) ? `"${literal}"` : literal;
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function parseJsonKeepingBigIntegers(text: string): unknown {
  return JSON.parse(quoteBigIntegers(text));
}

/**
 * The driver option that applies it, for `postgres(url, { types: ... })`.
 * 114 is Postgres `json`; `jsonb` (3802) is left to the default parser.
 */
export const exactJsonType = {
  json: {
    to: 114,
    from: [114],
    serialize: (value: unknown) => JSON.stringify(value),
    parse: parseJsonKeepingBigIntegers,
  },
};
