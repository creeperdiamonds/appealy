// bot/src/core/statusShape.ts
//
// What the bot tells the status Worker, and how a shard is classified. No
// imports, so it can be tested without Discord, a database or any env.
//
// Must stay in step with parseHeartbeat in src/model.ts on the status-page
// branch, which
// rejects anything that doesn't match this shape exactly.

export type PublicState = "up" | "degraded" | "down";

export interface Heartbeat {
  sentAt: string;
  totalShards: number;
  shards: { id: number; state: PublicState }[];
  database: "up" | "down";
}

/** Discordeno 20's ShardState.Connected. Every other value (Connecting,
 *  Disconnected, Unidentified, Identifying, Resuming, Offline) is some stage
 *  of not receiving events. */
export const SHARD_CONNECTED = 0;

/** Gateway heartbeat round-trip above this reads as slow rather than fine. */
export const SLOW_RTT_MS = 500;

export function classifyShard(shard: { state?: number; heart?: { rtt?: number } }): PublicState {
  if (shard.state !== SHARD_CONNECTED) return "down";
  return (shard.heart?.rtt ?? 0) > SLOW_RTT_MS ? "degraded" : "up";
}
