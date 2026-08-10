// api/src/routes/platformAppeals.ts
//
// Submission and status for PLATFORM ban appeals (see
// shared/schema/platformBans.ts for how these differ from guild ban appeals,
// which are an entirely separate feature). Mounted at /api/platform-appeals
// and exempted from banGate — these are the only endpoints a banned account
// may reach.
//
// The rules protect reviewers, not punish appellants
// --------------------------------------------------
// One open appeal, three lifetime attempts, thirty days after a denial.
// Without them one motivated person can put a hundred appeals in the queue and
// every genuine appeal behind them waits. The limits are stated on the form
// rather than discovered on submit, and each refusal says what to do next.
//
// The database enforces the important one anyway (platform_ban_appeals_one_open
// is a partial unique index) so a race or a Redis outage cannot flood the queue.

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireSession } from "../middleware/auth.ts";
import { publishBanChange } from "../middleware/banGate.ts";
import { APPEAL_RULES, toPublicBan } from "../../../shared/schema/platformBans.ts";
import { fetchUserGuilds } from "../services/discordOAuth.ts";
import { redis } from "../lib/redis.ts";

export const platformAppealsRouter: Router = Router();

platformAppealsRouter.use(requireSession);

platformAppealsRouter.post("/", async (req, res) => {
  const { banId, body } = req.body as { banId?: string; body?: string };
  const appellantId = req.userId!;

  if (!banId || typeof body !== "string") {
    return res.status(400).json({ error: "invalid_request" });
  }

  const ban = await db.query.platformBans.findFirst({ where: eq(schema.platformBans.id, banId) });
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
  // OAuth guilds payload — not a stored role, not a client claim, and not the
  // guilds table, which can be stale if the bot was removed.
  if (ban.subject === "guild") {
    const guilds = await fetchUserGuilds(req.discordAccessToken!);
    const g = guilds.find((x: { id: string }) => x.id === ban.subjectId.toString());
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

  const history = await db.query.platformBanAppeals.findMany({
    where: eq(schema.platformBanAppeals.banId, banId),
    orderBy: desc(schema.platformBanAppeals.createdAt),
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
  // Fails open — the partial unique index is the real guard.
  const fresh = await redis.set(`platform_appeals:rl:${appellantId}`, "1", "EX", 300, "NX").catch(() => "OK");
  if (!fresh) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many attempts. Try again in a few minutes.",
    });
  }

  const [row] = await db
    .insert(schema.platformBanAppeals)
    .values({ banId, appellantId, body: text })
    .returning({ id: schema.platformBanAppeals.id, createdAt: schema.platformBanAppeals.createdAt });

  return res.status(201).json({ id: row.id, createdAt: row.createdAt.toISOString() });
});

/** Status for the ban screen: the ban plus whatever the appellant is owed. */
platformAppealsRouter.get("/:banId", async (req, res) => {
  const ban = await db.query.platformBans.findFirst({
    where: eq(schema.platformBans.id, req.params.banId),
  });
  if (!ban) return res.status(404).json({ error: "not_found" });

  const appeals = await db.query.platformBanAppeals.findMany({
    where: eq(schema.platformBanAppeals.banId, ban.id),
    orderBy: desc(schema.platformBanAppeals.createdAt),
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

/** Staff action. Revoking is the only path that touches the live ban set. */
export async function acceptAppeal(appealId: string, staffId: bigint, note: string) {
  const appeal = await db.query.platformBanAppeals.findFirst({
    where: eq(schema.platformBanAppeals.id, appealId),
  });
  if (!appeal) throw new Error("appeal_not_found");

  const [row] = await db
    .update(schema.platformBans)
    .set({ revokedAt: new Date(), revokedBy: staffId, revokeReason: note })
    .where(and(eq(schema.platformBans.id, appeal.banId)))
    .returning();

  await db
    .update(schema.platformBanAppeals)
    .set({ status: "accepted", decidedAt: new Date(), decidedBy: staffId, decisionNote: note })
    .where(eq(schema.platformBanAppeals.id, appealId));

  await publishBanChange("remove", toPublicBan(row));
}
