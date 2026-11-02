// shared/lib/__tests__/apiIdFields.test.ts
//
// A source-level invariant, like bot/src/core/__tests__/configCacheGuard.test.ts,
// because the API has no test runner. A role list declared as z.array(z.string())
// stores whatever it's given, and the bot finds out later: on 2026-11-01 a ping
// role saved as a role's name stopped an application's review post, which is the
// only place Accept and Deny appear. A lone channel ID declared as z.string()
// reaches BigInt() in the route and answers 500 instead of saying what's wrong.
//
// Run from the repository root.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROUTES = "api/src/routes";

/** Fields here hold something other than a Discord ID, whatever they're called. */
const EXEMPT: Record<string, string> = {
  "migration.ts": "userId is a row from Appy's export file, read by the import and never stored raw",
  "quickResponses.ts": "categoryId is one of Appealy's own UUIDs",
};

const BARE_ID_FIELD =
  /\b(\w*(?:channel|role|roles|user|users|category)\w*ids?)\s*:\s*z\.(?:array\(z\.)?string\(\)(?!\.regex)/gi;

Deno.test("every Discord ID field in the API's routes checks what it's given", async () => {
  const bare: string[] = [];
  for await (const entry of Deno.readDir(ROUTES)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name in EXEMPT) continue;
    const source = await Deno.readTextFile(`${ROUTES}/${entry.name}`);
    for (const match of source.matchAll(BARE_ID_FIELD)) bare.push(`${entry.name}: ${match[1]}`);
  }
  assertEquals(bare.sort(), [], "use discordId or discordIdList from api/src/utils/discordIds.ts");
});
