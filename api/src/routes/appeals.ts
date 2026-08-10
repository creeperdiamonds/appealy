// api/src/routes/appeals.ts
//
// Submission and status for ban appeals. Mounted at /appeals, and exempted
// from banGate — these are the only endpoints a banned account may reach.
//
// The rules exist to protect reviewers, not to punish appellants
// --------------------------------------------------------------
// One open appeal at a time, three lifetime attempts, thirty days after a
// denial. Without those, a single motivated person can put a hundred appeals
// in the queue and every genuine appeal behind them waits. The limits are
// stated on the form rather than discovered on submit, and the copy for each
// refusal says what to do next.
//
// The database enforces the important one anyway (`ban_appeals_one_open` is a
// partial unique index) so a race or a Redis outage cannot flood the queue.

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireSession } from "../middleware/auth.ts";
import { publishBanChange } from "../middleware/banGate.ts";
import { APPEAL_RULES, toPublicBan } from "../../../shared/schema/bans.ts";
import { fetchUserGuilds } from "../services/discordOAuth.ts";
import { redis } from "../lib/redis.ts";

export const appealsRouter: Router = Router();

appealsRouter.use(requireSession);

appealsRouter.post("/", async (req, res) => {
  const { banId, body } = req.body as { banId?: string; body?: string };
  const appellantId = req.userId!;

  if (!banId || typeof body !== "string") {
    return res.status(400).json({ error: "invalid_request" });
  }

  const ban = await db.query.bans.findFirst({ where: eq(schema.bans.id, banId) });
  if (!ban || ban.revokedAt) {
    return res.status(404).json({ error: "not_found", message: "That ban is no longer active." });
  }

  const text = body.trim();
  if (text.length < APPEAL_RULES.minLength) {
    return res.status(422).json({
      error: "too_short",
      message: `Add a bit more detail — at least ${APPEAL_RULES.minLength} characters.`,
    });
  }
  if (text.length > APPEAL_RULES.maxLength) {
    return res.status(422).json({
      error: "too_long",
      message: `Keep it under ${APPEAL_RULES.maxLength} characters.`,
    });
  }

  // Authorization. For a guild ban, verify Manage Server against the live
  // OAuth guilds payload — not a stored role, not a client claim, not the
  // guilds table, which can be stale if the bot was removed.
  if (ban.subject === "guild") {
    const guilds = await fetchUserGuilds(req.discordAccessToken!);
    const g = guilds.find((x) => x.id === ban.subjectId.toString());
    const perms = BigInt(g?.permissions ?? 0);
    if (!g || (!g.owner && (perms & APPEAL_RULES.manageGuild) === 0n)) {
      return res.status(403).json({
        error: "not_permitted",
        message: "Only someone with Manage Server can appeal for this server.",
      });
    }
  } else if (ban.subjectId !== appellantId) {
    return res.status(403).json({
      error: "not_permitted",
      message: "You can only appeal your own ban.",
    });
  }

  const history = await db.query.banAppeals.findMany({
    where: eq(schema.banAppeals.banId, banId),
    orderBy: desc(schema.banAppeals.createdAt),
  });

  if (history.some((a) => a.status === "open")) {
    return res.status(409).json({
      error: "already_open",
      message: "You already have an appeal under review. We'll show the outcome here.",
    });
  }
  if (history.length >= APPEAL_RULES.maxAttempts) {
    return res.status(409).json({
      error: "exhausted",
      message: "This ban has been appealed the maximum number of times. The decision is final.",
    });
  }

  const lastDenial = history.find((a) => a.status === "denied");
  if (lastDenial?.decidedAt) {
    const eligibleAt = lastDenial.decidedAt.getTime() + APPEAL_RULES.cooldownDays * 864e5;
    if (Date.now() < eligibleAt) {
      const days = Math.ceil((eligibleAt - Date.now()) / 864e5);
      return res.status(429).json({
        error: "cooldown",
        message: `You can appeal again in ${days} day${days === 1 ? "" : "s"}.`,
      });
    }
  }

  // Throttle on top of the rules above, to absorb double-submits and scripts.
  const fresh = await redis
    .set(`appeals:rl:${appellantId}`, "1", "EX", 300, "NX")
    .catch(() => "OK"); // fail open; the unique index is the real guard
  if (!fresh) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many attempts. Try again in a few minutes.",
    });
  }

  const [row] = await db
    .insert(schema.banAppeals)
    .values({ banId, appellantId, body: text })
    .returning({ id: schema.banAppeals.id, createdAt: schema.banAppeals.createdAt });

  return res.status(201).json({ id: row.id, createdAt: row.createdAt.toISOString() });
});

/** Status for the ban screen: the ban plus whatever the appellant is owed. */
appealsRouter.get("/:banId", async (req, res) => {
  const ban = await db.query.bans.findFirst({ where: eq(schema.bans.id, req.params.banId) });
  if (!ban) return res.status(404).json({ error: "not_found" });

  const appeals = await db.query.banAppeals.findMany({
    where: eq(schema.banAppeals.banId, ban.id),
    orderBy: desc(schema.banAppeals.createdAt),
  });
  const open = appeals.find((a) => a.status === "open") ?? null;

  return res.json({
    ban: toPublicBan(ban, open),
    attemptsUsed: appeals.length,
    attemptsAllowed: APPEAL_RULES.maxAttempts,
    // Only the decision note is exposed, never the reviewer's identity.
    lastDecision: appeals.find((a) => a.status !== "open")
      ? {
          status: appeals[0].status,
          note: appeals[0].decisionNote,
          decidedAt: appeals[0].decidedAt?.toISOString() ?? null,
        }
      : null,
  });
});

/** Staff action. Revoking is the only path that touches the ban set. */
export async function acceptAppeal(appealId: string, staffId: bigint, note: string) {
  const appeal = await db.query.banAppeals.findFirst({
    where: eq(schema.banAppeals.id, appealId),
  });
  if (!appeal) throw new Error("appeal_not_found");

  const [row] = await db
    .update(schema.bans)
    .set({ revokedAt: new Date(), revokedBy: staffId, revokeReason: note })
    .where(and(eq(schema.bans.id, appeal.banId)))
    .returning();

  await db
    .update(schema.banAppeals)
    .set({ status: "accepted", decidedAt: new Date(), decidedBy: staffId, decisionNote: note })
    .where(eq(schema.banAppeals.id, appealId));

  await publishBanChange("remove", toPublicBan(row));
}
