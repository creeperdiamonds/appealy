// api/src/db/client.ts

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as coreSchema from "../../../shared/schema/schema.ts";
import * as platformBanSchema from "../../../shared/schema/platformBans.ts";
import * as outcomeSchema from "../../../shared/schema/outcomes.ts";
import { env } from "../env.ts";

// Sized to the database, not to the traffic. The hosted database is a
// db-f1-micro: about 25 connections, a few reserved for admins. This pool and
// the bot's (bot/src/db/client.ts) share them, and during a deploy the old and
// new revisions both hold theirs for a moment. At 15 here and 10 in the bot
// the two alone could take every slot, and on 2 Oct 2026 they did: an hour of
// "remaining connection slots are reserved" and a dashboard that wouldn't load.
// 6 + 5, doubled during a rollout, is 22 at most. Queries here take
// milliseconds, so 6 is plenty at this size; idle connections close after
// 20 s so a quiet API doesn't sit on slots it isn't using.
const queryClient = postgres(env.DATABASE_URL, {
  max: 6,
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
