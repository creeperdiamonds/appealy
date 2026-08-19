// bot/src/core/dedicatedRunner.ts
//
// Runs several customers' dedicated bots inside one process.
//
// WHY NOT ONE CONTAINER EACH
//
// A Discord gateway connection has to stay open, which on Cloud Run means
// min-instances=1 and cpu-throttling off — billed continuously at roughly the
// price of an e2-micro VM, about $84 a year. Dedicated hosting sells for $10 a
// year (CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR). One container per customer
// loses money on every sale, and no amount of tuning closes an eight-fold gap.
//
// Several clients in one process do close it. A gateway connection is almost
// entirely idle — it waits on a socket and sends a heartbeat every 41 seconds
// — so the marginal CPU cost of another one is small. Fifteen bots sharing one
// host is about $5.60 each against $10 of revenue.
//
// WHAT THIS IS NOT
//
// It is not sharding. Each client is a separate bot identity on its own token,
// with its own rate limits and its own guilds. They share a process and a
// database pool, and nothing else.
//
// THE CONSTRAINTS THAT SHAPE IT
//
//   One connection per token. Discord permits a second one; it simply
//   delivers every event twice, so a customer's appeal gets accepted twice
//   and their applicant is DMed twice. Two runners must therefore never hold
//   the same guild, which is what the claim below is for.
//
//   One crash must not take fifteen customers down. Every client is started,
//   and every handler runs, inside its own error boundary. A token that
//   Discord rejects marks that one customer failed and leaves the rest alone.
//
//   Memory is the real ceiling, not CPU. Each client caches what
//   desiredProperties asks for; that is already trimmed hard, but fifteen
//   copies of it is what decides MAX_BOTS_PER_RUNNER rather than any CPU
//   figure.

import { and, eq, isNotNull, lt, or, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { createAppealyBot, startBot, type AppealyBot } from "./client.ts";
import { logger } from "../utils/logger.ts";
import { decryptWithKey } from "../../../shared/lib/tokenCrypto.ts";
import { env } from "./env.ts";

/**
 * How many dedicated bots one process will hold.
 *
 * Set by memory, not CPU. Raise it only against a measured RSS figure from a
 * runner that is actually full — a number picked hopefully here is paid for by
 * fifteen customers at once when the process is OOM-killed.
 */
export const MAX_BOTS_PER_RUNNER = 15;

/** How often a runner renews its claims. */
const HEARTBEAT_MS = 30_000;

/**
 * A claim older than this is treated as abandoned and may be taken over.
 *
 * Comfortably more than three missed heartbeats. Too short and a slow runner
 * has its bots stolen while still holding the connections — which produces
 * exactly the duplicate-event problem the claim exists to prevent. Too long
 * and a crashed runner's customers sit dark. Ninety seconds errs toward the
 * second, because dark is recoverable and duplicated moderation actions are
 * not.
 */
const CLAIM_STALE_MS = 90_000;

/** How often to look for newly-paid customers or freed-up claims. */
const SCAN_MS = 60_000;

interface Held {
  guildId: bigint;
  bot: AppealyBot;
}

const held = new Map<string, Held>();
let runnerId = "";
// Inferred rather than typed as number: this file resolves node: types
// through the shared crypto import, so setInterval returns Timeout here and
// number in a plain Deno file. ReturnType keeps it correct in both.
let timers: ReturnType<typeof setInterval>[] = [];

/**
 * Starts the runner loop.
 *
 * Non-fatal throughout: this runs alongside the platform bot, and a failure to
 * host somebody's dedicated instance must never take the platform down with
 * it. Every path logs and continues.
 */
export async function startDedicatedRunner(id: string): Promise<void> {
  runnerId = id;
  logger.info("Dedicated runner starting", { runnerId, capacity: MAX_BOTS_PER_RUNNER });

  await scan();
  timers.push(setInterval(() => void scan().catch(onLoopError), SCAN_MS));
  timers.push(setInterval(() => void heartbeat().catch(onLoopError), HEARTBEAT_MS));
}

export async function stopDedicatedRunner(): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers = [];
  // Released explicitly so a deliberate restart does not leave fifteen
  // customers waiting out CLAIM_STALE_MS before another runner picks them up.
  for (const [key, h] of held) {
    await release(h.guildId, "stopped").catch(() => {});
    held.delete(key);
  }
  logger.info("Dedicated runner stopped", { runnerId });
}

function onLoopError(err: unknown) {
  logger.error("Dedicated runner loop error", { runnerId, error: String(err) });
}

/** Claims what this runner has room for, and starts it. */
async function scan(): Promise<void> {
  const room = MAX_BOTS_PER_RUNNER - held.size;
  if (room <= 0) return;

  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);

  // Eligible: paying for dedicated hosting, has a token, and is either
  // unclaimed or claimed by a runner that has stopped saying so.
  const candidates = await db
    .select({ id: schema.guilds.id, tokenEnc: schema.guilds.customBotTokenEnc })
    .from(schema.guilds)
    .where(
      and(
        eq(schema.guilds.hostingMode, "custom"),
        isNotNull(schema.guilds.customBotTokenEnc),
        or(
          isNull(schema.guilds.customBotRunnerId),
          lt(schema.guilds.customBotHeartbeatAt, staleBefore),
        ),
      ),
    )
    .limit(room);

  for (const c of candidates) {
    if (held.has(c.id.toString())) continue;
    await claimAndStart(c.id, c.tokenEnc!).catch((err) =>
      logger.error("Failed to start dedicated bot", {
        guildId: c.id.toString(),
        error: String(err),
      }),
    );
  }
}

/**
 * Takes the claim, then connects.
 *
 * The claim is a conditional UPDATE rather than a read-then-write: two runners
 * scanning at the same moment both see the same free row, and only the one
 * whose UPDATE matches may proceed. Checking first and writing after would let
 * both through, and both would connect the same token.
 */
async function claimAndStart(guildId: bigint, tokenEnc: string): Promise<void> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);

  const claimed = await db
    .update(schema.guilds)
    .set({
      customBotRunnerId: runnerId,
      customBotHeartbeatAt: new Date(),
      customBotStatus: "starting",
      customBotError: null,
    })
    .where(
      and(
        eq(schema.guilds.id, guildId),
        eq(schema.guilds.hostingMode, "custom"),
        or(
          isNull(schema.guilds.customBotRunnerId),
          lt(schema.guilds.customBotHeartbeatAt, staleBefore),
        ),
      ),
    )
    .returning({ id: schema.guilds.id });

  if (claimed.length === 0) return; // another runner won it

  let token: string;
  try {
    token = decryptWithKey(tokenEnc, env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    // Undecryptable means TOKEN_ENCRYPTION_KEY has changed since it was
    // stored. Retrying cannot fix that, and the customer has to supply the
    // token again — so say so plainly rather than looping.
    await fail(guildId, "Stored token could not be read. Please re-enter your bot token.");
    logger.error("Dedicated token failed to decrypt", {
      guildId: guildId.toString(),
      error: String(err),
    });
    return;
  }

  try {
    const bot = createAppealyBot(token);
    await startBot(bot, token);
    held.set(guildId.toString(), { guildId, bot });
    await db
      .update(schema.guilds)
      .set({ customBotStatus: "running", customBotHeartbeatAt: new Date() })
      .where(eq(schema.guilds.id, guildId));
    logger.info("Dedicated bot connected", {
      guildId: guildId.toString(),
      runnerId,
      held: held.size,
    });
  } catch (err) {
    // Almost always a token Discord rejected — revoked, regenerated, or
    // pasted with whitespace. The message reaches the guild owner, so it names
    // what they can do rather than what the library threw.
    await fail(
      guildId,
      "Discord refused this bot token. Check it is current, and that the bot has not been deleted.",
    );
    logger.warn("Dedicated bot failed to connect", {
      guildId: guildId.toString(),
      error: String(err),
    });
  }
}

async function fail(guildId: bigint, message: string): Promise<void> {
  await db
    .update(schema.guilds)
    .set({
      customBotStatus: "failed",
      customBotError: message,
      customBotRunnerId: null,
      customBotHeartbeatAt: null,
    })
    .where(eq(schema.guilds.id, guildId));
}

async function release(guildId: bigint, status: "stopped" | "failed"): Promise<void> {
  await db
    .update(schema.guilds)
    .set({ customBotStatus: status, customBotRunnerId: null, customBotHeartbeatAt: null })
    .where(and(eq(schema.guilds.id, guildId), eq(schema.guilds.customBotRunnerId, runnerId)));
}

/**
 * Renews claims, and drops anyone who has stopped paying.
 *
 * The renewal is scoped to rows this runner still owns, so a claim already
 * taken over is not silently reclaimed by writing a fresh timestamp over it.
 */
async function heartbeat(): Promise<void> {
  if (held.size === 0) return;

  const ids = [...held.values()].map((h) => h.guildId);

  await db
    .update(schema.guilds)
    .set({ customBotHeartbeatAt: new Date() })
    .where(
      and(
        eq(schema.guilds.customBotRunnerId, runnerId),
        sql`${schema.guilds.id} IN ${ids}`,
      ),
    );

  // Someone whose hosting lapsed, was refunded, or removed their token stops
  // here rather than at the next restart — otherwise a refunded customer keeps
  // a running bot until the process happens to cycle.
  const stillPaying = await db
    .select({ id: schema.guilds.id })
    .from(schema.guilds)
    .where(
      and(
        eq(schema.guilds.hostingMode, "custom"),
        isNotNull(schema.guilds.customBotTokenEnc),
        sql`${schema.guilds.id} IN ${ids}`,
      ),
    );

  const keep = new Set(stillPaying.map((r) => r.id.toString()));
  for (const [key, h] of held) {
    if (keep.has(key)) continue;
    await shutdown(h).catch(() => {});
    await release(h.guildId, "stopped").catch(() => {});
    held.delete(key);
    logger.info("Dedicated bot stopped; hosting no longer active", { guildId: key });
  }
}

async function shutdown(h: Held): Promise<void> {
  // shutdown() is the documented name and closes the gateway connection;
  // guarded because this file already carries one note about the gateway
  // manager's shape moving between versions, and a failure to close cleanly
  // must not stop the row being released.
  const gw = (h.bot as unknown as { gateway?: { shutdown?: () => Promise<void> } }).gateway;
  if (gw?.shutdown) await gw.shutdown();
}

/** For the ops surface and the control server's health endpoint. */
export function dedicatedStatus() {
  return {
    runnerId,
    capacity: MAX_BOTS_PER_RUNNER,
    held: held.size,
    guildIds: [...held.keys()],
  };
}
