// api/src/db/count.ts
//
// Row counting for a version of drizzle-orm that does not have db.$count.
//
// $count arrived after 0.33, which is what this package pins. Four call sites
// used it, so `npm run build` failed with "Property '$count' does not exist"
// and no image could be produced. Bumping the ORM to reach one convenience
// method is a much larger change than writing the query it stands for —
// especially with no test suite to catch a behavioural difference elsewhere —
// so this is the same query, spelled out.
//
// If drizzle is upgraded later, this can be deleted and the call sites can go
// back to db.$count with identical semantics.

import { count, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "./client.ts";

/**
 * COUNT(*) over `table`, optionally filtered.
 *
 * Returns 0 rather than undefined when the result set is empty — count(*)
 * always yields a row, but the destructure has to be total to satisfy
 * noUncheckedIndexedAccess-style strictness and a 0 is the honest answer.
 */
export async function countRows(table: PgTable, where?: SQL): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table).where(where);
  return row?.value ?? 0;
}
