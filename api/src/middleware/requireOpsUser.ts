// api/src/middleware/requireOpsUser.ts
//
// Gate for the operator surface (ban writes, appeal review, shard control).
//
// Where the security actually comes from
// --------------------------------------
// Not from OPS_USER_IDS being secret — a Discord user ID is public, it's in
// every mention. It comes from `req.userId`, which requireSession derives from
// the signed session cookie and the OAuth exchange behind it. This middleware
// reads that and nothing else.
//
// The invariant to protect in review: this file must never look at a header,
// query parameter, or request body. If it did, the allowlist would become a
// password that everyone can read.
//
// Fail CLOSED
// -----------
// The opposite of banGate, deliberately. If the ban set fails to load we let
// everyone through, because locking out the userbase to catch a few is a
// self-inflicted outage. Here, an unset or unparseable OPS_USER_IDS denies
// everyone — worst case operators can't reach the console until someone fixes
// the env, which is a bad afternoon rather than a breach.
//
// 404, not 403
// ------------
// A 403 confirms the route exists. No reason to tell an unauthorized visitor
// that /ops is real and worth attacking; operators already know where it is.

import type { Request, Response, NextFunction } from "express";
import { env } from "../env.ts";
import { logger } from "../utils/logger.ts";

/** Mount as: app.use("/api/ops", requireSession, requireOpsUser, opsRouter) */
export function requireOpsUser(req: Request, res: Response, next: NextFunction) {
  // requireSession must have run. If it hasn't, req.userId is undefined and we
  // deny — rather than treating "no session" as "not on the list, carry on".
  const userId = req.userId;

  if (!userId || env.OPS_USER_IDS.size === 0 || !env.OPS_USER_IDS.has(userId.toString())) {
    // Log every refusal. An authenticated non-operator probing /ops is a much
    // stronger signal than an anonymous 404, and you want the id when it happens.
    logger.warn("Operator surface refused", {
      userId: userId?.toString() ?? null,
      path: req.originalUrl,
      allowlistConfigured: env.OPS_USER_IDS.size > 0,
      ip: req.ip,
    });
    return res.status(404).json({ error: "not_found" });
  }

  logger.info("Operator action", {
    userId: userId.toString(),
    method: req.method,
    path: req.originalUrl,
  });
  next();
}

/**
 * For the client to decide whether to render a Control nav item.
 *
 * A convenience for the UI, NOT a security boundary. Every /ops route enforces
 * requireOpsUser independently — a hidden nav item stops nobody, and a build
 * relying on this flag alone is unprotected.
 */
export function opsCapability(req: Request) {
  return { ops: !!req.userId && env.OPS_USER_IDS.has(req.userId.toString()) };
}
