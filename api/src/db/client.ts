// api/src/db/client.ts

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../shared/schema/schema.ts";
import { env } from "../env.ts";

const queryClient = postgres(env.DATABASE_URL, { max: 15 });
export const db = drizzle(queryClient, { schema });
export { schema };
