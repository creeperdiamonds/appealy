/**
 * ============================================================================
 *  SHARD CONTROL PLANE  —  Discordeno v21 big-bot topology
 * ============================================================================
 *
 *  Topology assumed (from your answers: 500k+ guilds, multi-host):
 *
 *    [gateway manager]  1 process   — owns buckets, resharding, control API
 *          |
 *          +-- [sharding master] x N hosts   — HTTP listener, owns worker_threads
 *                    |
 *                    +-- [worker] x M        — owns DiscordenoShard instances
 *                              |
 *                              +-- shard --> event handler (bot) processes
 *
 *  TWO PATHS, DELIBERATELY SEPARATE:
 *
 *    TELEMETRY (push, lossy, cheap)  shard -> Redis -> BFF -> browser
 *    CONTROL   (pull, exact, audited) browser -> BFF -> manager -> master -> worker
 *
 *  The dashboard NEVER queries the gateway manager for state. At 5k shards a
 *  status fan-out is a self-inflicted outage. The manager is only ever asked to
 *  *do* things, never to *report* things.
 *
 *  Sections:
 *    A. Shared contract (keys, packing, enums)
 *    B. Worker side      — telemetry emitter
 *    C. Sharding master  — control message handling
 *    D. Gateway manager  — control API + identify budget governor
 *    E. Dashboard BFF    — SSE snapshot/delta stream
 *
 *  Marked  ⚠️ ASSUMPTION  wherever I'm guessing at your code. Send me the repo
 *  (manager.ts, sharding/index.ts, sharding/worker.ts) and I'll replace these
 *  with the real thing.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// A. SHARED CONTRACT
// ---------------------------------------------------------------------------

/** Mirrors Discordeno's ShardState, flattened to a single byte for transport. */
export const enum ShardStateByte {
  Unspawned = 0,
  Offline = 1,
  Connecting = 2,
  Unidentified = 3,
  Identifying = 4,
  Resuming = 5,
  Connected = 6,
  Disconnected = 7,
}

export const REDIS_KEYS = {
  /** HASH per shard. EXPIRE 90s — absence *is* the death signal. No health polling. */
  shard: (id: number) => `gw:shard:${id}`,
  /** HASH of shardId -> packed counter, flushed by workers every 5s. */
  eventCounters: (workerId: number) => `gw:events:w${workerId}`,
  /** Manager-owned. Written on every getSessionInfo() refresh. */
  sessionBudget: 'gw:budget',
  /** Sorted set of queued control jobs, score = earliest-eligible epoch ms. */
  controlQueue: 'gw:control:queue',
  /** Append-only audit log. Every action, who, when, what it cost. */
  audit: 'gw:control:audit',
} as const

/**
 * Wire format. 4 bytes/shard = 20 KB for a full 5,000-shard snapshot.
 * Sending JSON here would be ~1.5 MB and would melt the browser at 1 Hz.
 */
export const SHARD_RECORD_BYTES = 4
export function packShard(buf: DataView, i: number, state: number, rttMs: number, flags: number) {
  const o = i * SHARD_RECORD_BYTES
  buf.setUint8(o, state)
  buf.setUint16(o + 1, Math.min(rttMs, 65535))
  buf.setUint8(o + 3, flags)
}
export const FLAG_STALE_ACK = 1 << 0 // no HEARTBEAT_ACK within 2 intervals
export const FLAG_DRAINING = 1 << 1 // operator-initiated, expected to flap
export const FLAG_RESHARDING = 1 << 2 // belongs to the incoming shard set

// ---------------------------------------------------------------------------
// B. WORKER SIDE — telemetry emitter
//    Goes in services/gateway/sharding/worker.ts, inside createShard().
// ---------------------------------------------------------------------------

import { DiscordenoShard } from '@discordeno/gateway'
import type Redis from 'ioredis'

/**
 * ⚠️ The big-bot guide writes an InfluxDB point per gateway event. At 5M guilds
 * that is ~50–200k writes/sec and it will dominate your gateway CPU. Count in
 * process, flush on an interval. This is the single highest-leverage change in
 * this file.
 */
export function attachTelemetry(shard: DiscordenoShard, redis: Redis, workerId: number) {
  let eventsSinceFlush = 0
  const originalMessage = shard.events.message

  shard.events.message = async (s, payload) => {
    eventsSinceFlush++ // in-process counter, not a network call
    return originalMessage?.(s, payload)
  }

  // Heartbeat cadence is ~41.25s, so a 5s flush is already 8x oversampled.
  const flush = setInterval(() => {
    const p = redis.pipeline()

    if (eventsSinceFlush > 0) {
      p.hincrby(REDIS_KEYS.eventCounters(workerId), String(shard.id), eventsSinceFlush)
      eventsSinceFlush = 0
    }

    p.hset(REDIS_KEYS.shard(shard.id), {
      state: String(shard.state),
      rtt: String(shard.heart.rtt ?? 0),
      lastAck: String(shard.heart.lastAck ?? 0),
      worker: String(workerId),
      host: process.env.HOST_ID ?? '0',
      // ⚠️ ASSUMPTION: you track guild count per shard somewhere. If you keep it
      // in the bot process instead, drop this and let the BFF join it in.
      guilds: String((shard as any).guildCount ?? 0),
    })
    // TTL is the liveness mechanism. A dead worker stops refreshing and its
    // shards evaporate from the dashboard on their own within 90s.
    p.expire(REDIS_KEYS.shard(shard.id), 90)
    p.exec().catch(() => {}) // telemetry must never throw into the gateway path
  }, 5_000)

  shard.events.disconnected = () => clearInterval(flush)
}

// ---------------------------------------------------------------------------
// C. SHARDING MASTER — control message handling
//    Extends the switch in services/gateway/sharding/index.ts.
// ---------------------------------------------------------------------------

export type ControlCommand =
  | { type: 'IDENTIFY_SHARD'; shardId: number }
  /** Resume-first reconnect. Costs ZERO session starts. Default restart path. */
  | { type: 'RECONNECT_SHARD'; shardId: number }
  | { type: 'KILL_SHARD'; shardId: number }
  /** Drain then respawn every shard on a worker — used for rolling redeploys. */
  | { type: 'CYCLE_WORKER'; workerId: number }

/** In the worker's parentPort message handler. */
export async function handleWorkerCommand(
  cmd: ControlCommand,
  SHARDS: Map<number, DiscordenoShard>,
) {
  switch (cmd.type) {
    case 'RECONNECT_SHARD': {
      const shard = SHARDS.get(cmd.shardId)
      if (!shard) return { ok: false, reason: 'Shard not running on this worker' }
      // shard.close() with a resumable code lets Discordeno resume with the
      // stored session id + sequence. No IDENTIFY, no budget spend, no downtime.
      await shard.close(4000, 'Operator reconnect')
      await shard.resume()
      return { ok: true, cost: 0 }
    }
    case 'IDENTIFY_SHARD': {
      const shard = SHARDS.get(cmd.shardId)
      if (!shard) return { ok: false, reason: 'Shard not running on this worker' }
      await shard.identify() // internally closes the old connection cleanly
      return { ok: true, cost: 1 }
    }
    case 'KILL_SHARD': {
      await SHARDS.get(cmd.shardId)?.shutdown()
      SHARDS.delete(cmd.shardId)
      return { ok: true, cost: 0 }
    }
  }
}

// ---------------------------------------------------------------------------
// D. GATEWAY MANAGER — control API + identify budget governor
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE FOOTGUN THIS EXISTS TO PREVENT
 *
 * `session_start_limit.remaining` is a per-day budget (1000 by default; higher
 * if you've been granted it). Every IDENTIFY spends one. A "restart everything"
 * button that issues 5,000 identifies will exhaust the budget, and Discord will
 * refuse new sessions until the reset window — your entire fleet stays down for
 * up to 24 hours and there is no appeal and no override.
 *
 * So: every control action is priced in session starts before it runs, the
 * governor refuses anything it can't afford, and the UI shows the budget as a
 * first-class number next to the button.
 */
export class IdentifyGovernor {
  private queue: Array<{ cmd: ControlCommand; bucketId: number; cost: number }> = []
  private lastIdentifyPerBucket = new Map<number, number>()

  constructor(
    private maxConcurrency: number, // buckets available, from getSessionInfo()
    private getRemaining: () => number,
    private dispatch: (cmd: ControlCommand, hostId: number) => Promise<unknown>,
    private totalShards: number,
    private shardsPerHost: number,
  ) {}

  /** Refuse before enqueueing, not halfway through. Partial fleets are worse. */
  admit(cmds: ControlCommand[]): { admitted: boolean; cost: number; reason?: string } {
    const cost = cmds.filter((c) => c.type === 'IDENTIFY_SHARD').length
    const remaining = this.getRemaining()
    // Keep 10% in reserve so an unattended crash-loop can still recover itself.
    const reserve = Math.ceil(remaining * 0.1)
    if (cost > remaining - reserve) {
      return {
        admitted: false,
        cost,
        reason: `Needs ${cost} session starts, ${remaining - reserve} available after reserve. Use reconnect (resume) instead — it costs none.`,
      }
    }
    this.queue.push(
      ...cmds.map((cmd) => ({
        cmd,
        bucketId: 'shardId' in cmd ? cmd.shardId % this.maxConcurrency : 0,
        cost: cmd.type === 'IDENTIFY_SHARD' ? 1 : 0,
      })),
    )
    return { admitted: true, cost }
  }

  /** One pass per tick. Respects 5s-per-bucket; free actions bypass the gate. */
  async tick() {
    const now = Date.now()
    const remaining: typeof this.queue = []

    for (const job of this.queue) {
      const hostId =
        'shardId' in job.cmd ? Math.floor(job.cmd.shardId / this.shardsPerHost) : 0

      if (job.cost === 0) {
        void this.dispatch(job.cmd, hostId) // resumes are unmetered
        continue
      }
      const last = this.lastIdentifyPerBucket.get(job.bucketId) ?? 0
      if (now - last < 5_000) {
        remaining.push(job)
        continue
      }
      this.lastIdentifyPerBucket.set(job.bucketId, now)
      void this.dispatch(job.cmd, hostId)
    }
    this.queue = remaining
  }

  get depth() {
    return this.queue.length
  }
}

/**
 * Wire it to your existing manager. ⚠️ ASSUMPTION: your control API reuses the
 * express listener from services/gateway/index.ts with the same AUTHORIZATION
 * header check.
 */
export function mountControlRoutes(app: any, GATEWAY: any, governor: IdentifyGovernor, redis: Redis) {
  app.post('/control/shards', async (req: any, res: any) => {
    const { action, shardIds, actor } = req.body as {
      action: ControlCommand['type']
      shardIds: number[]
      actor: string
    }
    const cmds = shardIds.map((shardId) => ({ type: action, shardId }) as ControlCommand)
    const verdict = governor.admit(cmds)

    await redis.xadd(REDIS_KEYS.audit, '*', 'actor', actor, 'action', action,
      'shards', String(shardIds.length), 'cost', String(verdict.cost),
      'admitted', String(verdict.admitted))

    return res.status(verdict.admitted ? 202 : 409).json(verdict)
  })

  /** Manual reshard. Zero-downtime: new set spins up before the old set drops. */
  app.post('/control/reshard', async (_req: any, res: any) => {
    await GATEWAY.resharding.checkIfReshardingIsNeeded()
    return res.status(202).json({ ok: true })
  })

  setInterval(() => void governor.tick(), 1_000)
}

// ---------------------------------------------------------------------------
// E. DASHBOARD BFF — SSE snapshot + delta stream
//    Separate process. Read-only against Redis. Safe to restart at any time.
// ---------------------------------------------------------------------------

/**
 * Full snapshot every 30s, deltas at 1 Hz in between. With ~5,000 shards a
 * steady-state fleet changes maybe 5–20 shards per second, so deltas are
 * ~120 bytes/s per connected operator instead of 20 KB/s.
 */
export function createTelemetryStream(redis: Redis, totalShards: number) {
  const last = new Uint8Array(totalShards * SHARD_RECORD_BYTES)

  async function readAll(): Promise<Uint8Array> {
    const buf = new Uint8Array(totalShards * SHARD_RECORD_BYTES)
    const view = new DataView(buf.buffer)
    const now = Date.now()

    // MGET-style pipeline. One round trip, not 5,000.
    const p = redis.pipeline()
    for (let i = 0; i < totalShards; i++) p.hgetall(REDIS_KEYS.shard(i))
    const rows = await p.exec()

    for (let i = 0; i < totalShards; i++) {
      const row = rows?.[i]?.[1] as Record<string, string> | undefined
      if (!row || !row.state) {
        packShard(view, i, ShardStateByte.Unspawned, 0, 0)
        continue
      }
      // 41.25s heartbeat; two missed ACKs means the connection is gone even if
      // the socket hasn't noticed yet. This is what catches zombie shards.
      const stale = now - Number(row.lastAck) > 90_000 ? FLAG_STALE_ACK : 0
      packShard(view, i, Number(row.state), Number(row.rtt), stale)
    }
    return buf
  }

  return {
    async snapshot() {
      const buf = await readAll()
      last.set(buf)
      return { kind: 'snapshot' as const, data: Buffer.from(buf).toString('base64') }
    },
    async delta() {
      const buf = await readAll()
      const changes: number[] = []
      for (let i = 0; i < totalShards; i++) {
        const o = i * SHARD_RECORD_BYTES
        if (
          buf[o] !== last[o] || buf[o + 1] !== last[o + 1] ||
          buf[o + 2] !== last[o + 2] || buf[o + 3] !== last[o + 3]
        ) {
          changes.push(i, buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
        }
      }
      last.set(buf)
      return { kind: 'delta' as const, changes }
    },
  }
}
