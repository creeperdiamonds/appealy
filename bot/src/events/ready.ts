// bot/src/events/ready.ts

import { logger } from "../utils/logger.ts";
import { markShardReady } from "../core/startupProfile.ts";

export function onReady(
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
}
