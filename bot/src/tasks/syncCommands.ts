// bot/src/tasks/syncCommands.ts
//
// Slash command registration, as a deploy step rather than a boot step.
//
//   deno task sync-commands              # global
//   deno task sync-commands 123456789    # one guild, instant, for dev
//
// Why this moved out of main()
// ----------------------------
// Not primarily for startup latency. `upsertGlobalApplicationCommands` is one
// HTTP PUT — a few hundred milliseconds, not the hour mentioned above
// registerCommands. That hour is Discord's PROPAGATION delay AFTER the call
// returns, and it happens whether or not you block on it.
//
// The real reason is the rate limit. Discord caps global command creates at
// 200 per day per application. Registering on every boot means a crash-loop,
// a rolling deploy, or simply running several bot replicas burns that budget
// on restarts — and once it's gone you cannot update commands until the
// window resets, on the day you most likely need to.
//
// Running it explicitly makes the cost proportional to deploys, not restarts.

import { createAppealyBot } from "../core/client.ts";
import { registerCommands } from "../commands/index.ts";
import { logger } from "../utils/logger.ts";

const raw = Deno.args[0];
const guildId = raw ? BigInt(raw) : undefined;

try {
  await registerCommands(createAppealyBot(), guildId);
  logger.info("Command sync complete", { scope: guildId ? guildId.toString() : "global" });
  Deno.exit(0);
} catch (err) {
  logger.error("Command sync failed", { error: err instanceof Error ? err.stack : String(err) });
  Deno.exit(1);
}
