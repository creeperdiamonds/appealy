// bot/src/core/__tests__/configCacheGuard.test.ts
//
// A source-level invariant, like deferGuard.test.ts. guildConfigCache holds a
// server's settings for 30 minutes and counts on every write clearing them. The
// API's writes all pass through invalidateOnWrite, but the bot's own don't, and a
// forgotten one looks fine: /anti-raid setup says it's done, and the join handler
// goes on reading the old settings until they expire.
//
// This checks each file rather than each write, so a second write in a file that
// already clears the cache isn't caught.
//
// Run from the repository root.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const BOT_SOURCE = "bot/src";

/** Files that write a cached table and don't need to clear it, and why. */
const NO_CLEAR_NEEDED = new Map([
  ["bot/src/core/dedicatedRunner.ts", "only customBot* columns, which nothing reads through the cache"],
  ["bot/src/events/guildDelete.ts", "only botPresent, which nothing reads through the cache"],
  [
    "bot/src/events/guildCreate.ts",
    "name, icon, owner and botPresent. The cache uses name only as a fallback, and clearing here would " +
      "throw away what's just been loaded for every server each time the bot starts",
  ],
  ["bot/src/services/verificationPanelService.ts", "only messageId, which nothing reads through the cache"],
]);

// Named in the cache's own file, so a table added to it is covered from then on.
const cacheSource = await Deno.readTextFile(`${BOT_SOURCE}/core/guildConfigCache.ts`);
const cachedTables = [...new Set([...cacheSource.matchAll(/schema\.(\w+)/g)].map((m) => m[1]))];

// importGuildData lives in shared/, which can't reach the bot's cache, so its
// callers in the bot have to clear it.
const WRITES_CACHED_SETTINGS = new RegExp(
  `\\.(?:insert|update|delete)\\(\\s*schema\\.(?:${cachedTables.join("|")})\\b|\\bimportGuildData\\(`,
);

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name !== "__tests__") yield* sourceFiles(path);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

Deno.test("the list of cached tables is what the cache really loads", () => {
  // Without this, a change to how the cache names its tables would empty the list
  // and quietly pass every test below.
  for (const table of ["guilds", "antiRaidConfigs", "verificationConfigs", "welcomerConfigs", "appealConfigs", "stickyMessages", "moderationConfigs"]) {
    assert(cachedTables.includes(table), `${table} not found in guildConfigCache.ts`);
  }
});

Deno.test("every bot file that writes cached settings clears the cache", async () => {
  const missing: string[] = [];
  for await (const path of sourceFiles(BOT_SOURCE)) {
    if (NO_CLEAR_NEEDED.has(path)) continue;
    const source = await Deno.readTextFile(path);
    if (WRITES_CACHED_SETTINGS.test(source) && !source.includes("invalidateGuild(")) missing.push(path);
  }
  assertEquals(missing.sort(), []);
});

for (const path of NO_CLEAR_NEEDED.keys()) {
  Deno.test(`${path} still needs its exception`, async () => {
    const source = await Deno.readTextFile(path);
    assert(WRITES_CACHED_SETTINGS.test(source), `${path} no longer writes a cached table; remove it from the list`);
    assert(!source.includes("invalidateGuild("), `${path} now clears the cache; remove it from the list`);
  });
}
