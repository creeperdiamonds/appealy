// api/src/routes/topggWebhook.ts
//
// Receives top.gg votes. A vote doesn't do anything by itself: it's stored as
// an unspent vote for that Discord user, and the user spends it on one server
// with /vote in the bot (bot/src/commands/vote.ts). See
// shared/schema/votePerks.ts for what it buys and why that is small.
//
// AUTHENTICITY. top.gg signs each request: header
// `x-topgg-signature: t=<unix>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>`
// with the webhook's secret. Verified over the raw bytes, so this router,
// like the Paddle one, is mounted before express.json(). Without the check,
// anyone who finds the URL can mint votes for themselves.
//
// RETRIES. top.gg retries timeouts and 5xx, never 4xx. So a bad signature
// gets a 4xx (retrying it can't help) and a Redis failure gets a 503 (it
// can).
//
// Mounted at /webhooks/topgg. Set it up on top.gg under your bot's
// Webhooks page, and put the secret in TOPGG_WEBHOOK_SECRET.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import { env } from "../env.ts";
import { withRedis } from "../lib/redis.ts";
import { logger } from "../utils/logger.ts";
import { UNSPENT_VOTE_SECONDS, voteKey } from "../../../shared/schema/votePerks.ts";

export const topggWebhookRouter = Router();

/** How old a signed timestamp may be. Covers top.gg's retries (seconds
 * apart) and clock skew; a replay after that is refused. */
const MAX_AGE_SECONDS = 15 * 60;

/** Checks `x-topgg-signature` against the raw body. Exported for tests. */
export function verifyTopggSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) return false;
  if (Math.abs(nowSeconds - Number(t)) > MAX_AGE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const received = Buffer.from(v1, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

interface TopggEvent {
  type?: string;
  data?: {
    expires_at?: string;
    created_at?: string;
    user?: { platform_id?: string };
  };
}

/** Seconds until the vote can be cast again, which is how long it stays
 * spendable. Clamped so a bad date can't park a key forever. */
export function unspentSeconds(expiresAt: string | undefined, now = Date.now()): number {
  const ms = expiresAt ? Date.parse(expiresAt) - now : NaN;
  if (!Number.isFinite(ms)) return UNSPENT_VOTE_SECONDS;
  return Math.min(Math.max(Math.ceil(ms / 1000), 60), UNSPENT_VOTE_SECONDS + 60 * 60);
}

topggWebhookRouter.post("/topgg", raw({ type: "*/*" }), async (req, res) => {
  if (!env.TOPGG_WEBHOOK_SECRET) {
    logger.error("top.gg webhook: TOPGG_WEBHOOK_SECRET is unset, cannot verify");
    return res.status(503).send("top.gg webhooks are not configured");
  }

  const signature = req.headers["x-topgg-signature"];
  const rawBody = req.body as Buffer;
  if (typeof signature !== "string" || !Buffer.isBuffer(rawBody)) {
    return res.status(400).send("Missing signature or body");
  }

  const body = rawBody.toString("utf8");
  if (!verifyTopggSignature(body, signature, env.TOPGG_WEBHOOK_SECRET)) {
    logger.warn("top.gg webhook: signature verification failed");
    return res.status(401).send("Invalid signature");
  }

  let event: TopggEvent;
  try {
    event = JSON.parse(body) as TopggEvent;
  } catch {
    return res.status(400).send("Malformed body");
  }

  const userId = event.data?.user?.platform_id;
  if (event.type === "webhook.test") {
    logger.info("top.gg webhook: test received", { userId });
    return res.status(204).end();
  }
  if (event.type !== "vote.create") {
    // Acknowledged so top.gg doesn't retry something we don't act on.
    return res.status(204).end();
  }
  if (!userId || !/^\d{15,22}$/.test(userId)) {
    return res.status(400).send("Vote without a Discord user");
  }

  const stored = await withRedis(async (r) => {
    await r.set(
      voteKey(userId),
      event.data?.created_at ?? new Date().toISOString(),
      "EX",
      unspentSeconds(event.data?.expires_at),
    );
    return true;
  }, false);
  if (!stored) {
    logger.error("top.gg webhook: couldn't store the vote", { userId });
    return res.status(503).send("Try again");
  }

  logger.info("top.gg vote recorded", { userId });
  return res.status(204).end();
});
