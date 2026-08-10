// bot/src/main.ts
// Bot process entrypoint. Run with: deno run --allow-net --allow-env bot/src/main.ts

import { createAppealyBot, startBot } from "./core/client.ts";
import { startScheduler } from "./core/scheduler.ts";
import { startControlServer } from "./core/controlServer.ts";
import { registerCommands } from "./commands/index.ts";
import { subscribeToInvalidations } from "./core/guildConfigCache.ts";
import { logger } from "./utils/logger.ts";
import { env } from "./core/env.ts";
import { markGatewayConnecting } from "./core/startupProfile.ts";
import { flushGuildBuffer } from "./events/guildCreate.ts";

// Startup order, most-important-first
// ----------------------------------
// The gateway is the only thing users need to be operational. Everything else
// is degradation, not failure: no scheduler means reminders run late, no
// invalidation subscriber means caches fall back to TTL. So the gateway goes
// first and the rest initializes behind it.
//
// Command registration is NOT here any more — see bot/src/tasks/syncCommands.ts
// for why (short version: Discord allows 200 global command creates per day,
// and registering on every boot spends that budget on restarts).
async function main() {
  const bot = createAppealyBot();

  // Escape hatch for single-container dev where running a separate task is
  // friction. Off by default; never set it in an environment with more than
  // one replica or with automatic restarts.
  if (env.SYNC_COMMANDS_ON_BOOT) {
    await registerCommands(bot);
  }

  markGatewayConnecting();
  await startBot(bot);
  startControlServer(bot);
  startScheduler(bot);

  logger.info("Appealy bot connected; initializing background services.");

  // Deliberately not awaited.
  //
  // The tradeoff this accepts: there is now a window between the gateway
  // coming up and the subscriber being ready, during which a config write
  // from the API won't be seen as an invalidation. The affected key then
  // serves stale until its TTL expires rather than forever, which is exactly
  // the fallback guildConfigCache was designed around — so the window is
  // bounded and self-healing. Waiting on Redis before letting Discord connect
  // is the worse trade.
  subscribeToInvalidations()
    .then(() => logger.info("Cache invalidation subscriber ready"))
    .catch((err) =>
      logger.error("Cache invalidation subscriber failed to start; caches will rely on TTL", {
        error: err instanceof Error ? err.stack : String(err),
      })
    );
}

// Flush buffered guild upserts before the process goes away, so a restart
// during the READY burst doesn't drop them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    flushGuildBuffer().finally(() => Deno.exit(0));
  });
}

main().catch((err) => {
  logger.error("Fatal error during bot startup", { error: err instanceof Error ? err.stack : String(err) });
  Deno.exit(1);
});
