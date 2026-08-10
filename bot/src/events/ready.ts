// bot/src/events/ready.ts

import { logger } from "../utils/logger.ts";
import { markShardReady } from "../core/startupProfile.ts";
import { startBanCache } from "../core/banCache.ts";
import { startStatusPublisher } from "../core/statusPublisher.ts";

export function onReady(
  bot: import("../core/client.ts").AppealyBot,
  payload: {
    shardId: number;
    user: { username: string; id: bigint };
    // Discord sends unavailable guild stubs in READY. The length is how many
    // GUILD_CREATE events to expect, which is the only way to know when the
    // burst is finished — see startupProfile.ts.
    guilds?: unknown[];
  },
) {
  logger.info("Shard ready", {
    shardId: payload.shardId,
    botUsername: payload.user.username,
  });
  markShardReady(payload.shardId, payload.guilds?.length ?? 0);

  // Shard 0 only — these are process-wide, not per-shard, and starting them
  // once per shard would open N subscribers and N publish intervals.
  if (payload.shardId === 0) {
    void startBanCache();
    startStatusPublisher(bot);
  }
}
