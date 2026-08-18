// bot/src/db/count.ts
//
// Row counting for a version of drizzle-orm that does not have db.$count.
//
// $count arrived after 0.33, which is what deno.json pins. Mirrors
// api/src/db/count.ts deliberately — the two runtimes each need their own
// module because each imports its own db client, but the query is the same one
// and should stay the same one.

import { count, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "./client.ts";

/** COUNT(*) over `table`, optionally filtered. */
export async function countRows(table: PgTable, where?: SQL): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table).where(where);
  return row?.value ?? 0;
}
