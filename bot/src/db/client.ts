// bot/src/db/client.ts
// Drizzle ORM client shared by all bot services. Uses postgres.js driver.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as coreSchema from "../../../shared/schema/schema.ts";
import * as platformBanSchema from "../../../shared/schema/platformBans.ts";
import * as outcomeSchema from "../../../shared/schema/outcomes.ts";
import { env } from "../core/env.ts";

const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Merged explicitly rather than relying on schema.ts's `export *`.
//
// outcomes.ts imports `forms` and `submissions` back from schema.ts, so the two
// are a cycle. drizzle() reads this object during module evaluation — while the
// cycle is still resolving — and snapshots whatever is populated at that
// instant. The re-exports on the far side were not, so db.query was built
// without platformBans, platformBanAppeals or formOutcomes.
//
// Nothing caught it. TypeScript resolves the re-exports statically and is
// satisfied; importing schema.ts on its own shows all 86 exports. It only
// appears when a route touches db.query.platformBanAppeals, gets undefined,
// and the process dies on `Cannot read properties of undefined (reading
// 'findMany')`. That is /api/ops/appeals, and both data exports.
//
// Importing the three modules directly means each is fully evaluated before the
// spread, so the object handed to drizzle is complete however the cycle
// resolves.
const schema = { ...coreSchema, ...platformBanSchema, ...outcomeSchema };

export const db = drizzle(queryClient, { schema });
export { schema };
