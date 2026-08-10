// api/drizzle.config.ts
// Drizzle Kit config for generating/running migrations against the shared
// schema. Migrations live in /db/migrations at the repo root so both the
// bot and api packages (and CI) reference one canonical migration history.

import type { Config } from "drizzle-kit";

export default {
  schema: ["../shared/schema/schema.ts", "../shared/schema/platformBans.ts"],
  out: "../db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
