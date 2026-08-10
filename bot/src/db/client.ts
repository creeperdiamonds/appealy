// bot/src/db/client.ts
// Drizzle ORM client shared by all bot services. Uses postgres.js driver.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../shared/schema/schema.ts";
import { env } from "../core/env.ts";

const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });
export { schema };
