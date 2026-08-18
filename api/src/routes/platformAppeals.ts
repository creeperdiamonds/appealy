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
import { routeParams } from "../utils/routeParams.ts";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireSession } from "../middleware/auth.ts";
import { publishBanChange } from "../middleware/banGate.ts";
import { APPEAL_RULES, apologyEligibility, attemptsAllowed, toPublicBan } from "../../../shared/schema/platformBans.ts";
import { fetchUserGuilds } from "../services/discordOAuth.ts";
import { redis } from "../lib/redis.ts";

export const platformAppealsRouter: Router = Router();

platformAppealsRouter.use(requireSession);

/** Every apology this person has ever filed, on any of their bans. */
async function apologiesUsedBy(appellantId: bigint): Promise<number> {
  const rows = await db
    .select({ id: schema.platformBanAppeals.id })
    .from(schema.platformBanAppeals)
    .where(
      and(
        eq(schema.platformBanAppeals.appellantId, appellantId),
        eq(schema.platformBanAppeals.kind, "apology"),
      ),
    );
  return rows.length;
}

platformAppealsRouter.post("/", async (req, res) => {
  const { banId, body, kind: rawKind } = req.body as {
    banId?: string;
    body?: string;
    kind?: string;
  };
  const appellantId = req.userId!;

  if (!banId || typeof body !== "string") {
    return res.status(400).json({ error: "invalid_request" });
  }

  // Defaults to "appeal", so an older client that does not know about
  // apologies keeps working and cannot spend one by omission.
  if (rawKind !== undefined && rawKind !== "appeal" && rawKind !== "apology") {
    return res.status(400).json({ error: "invalid_request", message: "Unknown submission kind." });
  }
  const kind: "appeal" | "apology" = rawKind === "apology" ? "apology" : "appeal";

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

  const all = await db.query.platformBanAppeals.findMany({
    where: eq(schema.platformBanAppeals.banId, banId),
    orderBy: desc(schema.platformBanAppeals.createdAt),
  });

  // One open submission per ban, whichever kind. The partial unique index
  // enforces this too; an apology filed while an appeal is being read would
  // hit it as a 500 rather than the sentence below.
  if (all.some((a) => a.status === "open")) {
    return res.status(409).json({
      error: "already_open",
      message: "You already have something under review here. We'll show the outcome on this page.",
    });
  }

  // The two lanes count separately. An apology must not consume an appeal
  // attempt — it makes no argument, so spending an attempt that could have
  // carried one would be a straight downgrade — and appeals must not eat into
  // the lifetime apology allowance either.
  const history = all.filter((a) => a.kind !== "apology");

  if (kind === "apology") {
    const eligibility = apologyEligibility(ban, await apologiesUsedBy(appellantId));

    if (eligibility.reason === "not_a_user_ban") {
      return res.status(422).json({
        error: "not_a_user_ban",
        message:
          "Apologies are for personal bans only. A server appeal argues what happened, " +
          "which is the right way round for an account other people share.",
      });
    }
    if (eligibility.reason === "none_left") {
      return res.status(409).json({
        error: "no_apologies_left",
        message:
          `You've used both of your apologies. That doesn't close anything — appeals for this ban ` +
          `run on their own schedule and are the route that can actually overturn it.`,
      });
    }

    // Deliberately skips the appeal attempt count, the reopen window and the
    // post-denial cooldown below. Those exist to stop the queue filling with
    // re-argued cases; two submissions in a lifetime cannot fill anything, and
    // making someone wait 30 days to say sorry is the kind of rule this
    // project exists to not have.
    const fresh = await redis
      .set(`platform_appeals:rl:${appellantId}`, "1", "EX", 300, "NX")
      .catch(() => "OK");
    if (!fresh) {
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many attempts. Try again in a few minutes.",
      });
    }

    const [apology] = await db
      .insert(schema.platformBanAppeals)
      .values({ banId, appellantId, body: text, kind: "apology" })
      .returning({
        id: schema.platformBanAppeals.id,
        createdAt: schema.platformBanAppeals.createdAt,
      });

    return res.status(201).json({
      id: apology.id,
      createdAt: apology.createdAt.toISOString(),
      kind: "apology",
      apologiesRemaining: eligibility.remaining - 1,
    });
  }
  // Attempts are counted since the last reopen, not for all time. Running out
  // pauses appeals; it never ends them. The word "final" does not appear here,
  // and shouldn't appear anywhere in this file — that sentence is why this
  // project exists.
  const allowed = attemptsAllowed(ban);
  const reopenAt = new Date(
    (history[history.length - 1]?.createdAt ?? ban.createdAt).getTime() +
      APPEAL_RULES.reopenAfterDays * 864e5,
  );
  const countedAttempts = history.filter((a) => a.createdAt >= new Date(reopenAt.getTime() - APPEAL_RULES.reopenAfterDays * 864e5)).length;

  if (countedAttempts >= allowed && Date.now() < reopenAt.getTime()) {
    const days = Math.ceil((reopenAt.getTime() - Date.now()) / 864e5);
    return res.status(409).json({
      error: "paused",
      message:
        `We've reviewed this ${allowed} times, so appeals are paused for now. ` +
        `You can appeal again in ${days} day${days === 1 ? "" : "s"}. ` +
        `If something has changed in the meantime — new information, or you've been able to fix what caused this — say so then and it'll be read properly.`,
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
    .values({ banId, appellantId, body: text, kind: "appeal" })
    .returning({ id: schema.platformBanAppeals.id, createdAt: schema.platformBanAppeals.createdAt });

  return res.status(201).json({ id: row.id, createdAt: row.createdAt.toISOString() });
});

/** Status for the ban screen: the ban plus whatever the appellant is owed. */
platformAppealsRouter.get("/:banId", async (req, res) => {
  const ban = await db.query.platformBans.findFirst({
    where: eq(schema.platformBans.id, routeParams(req).banId),
  });
  if (!ban) return res.status(404).json({ error: "not_found" });

  const all = await db.query.platformBanAppeals.findMany({
    where: eq(schema.platformBanAppeals.banId, ban.id),
    orderBy: desc(schema.platformBanAppeals.createdAt),
  });
  const open = all.find((a) => a.status === "open") ?? null;

  // Appeals only, for every count below. An apology is not an attempt at the
  // appeal, and letting it decrement that counter would quietly shorten the
  // rope for saying sorry — the opposite of the intent.
  const appeals = all.filter((a) => a.kind !== "apology");

  // Scoped to the viewer rather than the ban: the allowance follows the person
  // across every ban they have had. On a guild ban this is still the requester's
  // own count, which is what the screen needs to explain why the option is
  // absent — apologyEligibility refuses guild bans regardless.
  const apology = apologyEligibility(ban, await apologiesUsedBy(req.userId!));

  return res.json({
    ban: toPublicBan(ban, open),
    attemptsUsed: appeals.length,
    attemptsAllowed: attemptsAllowed(ban),
    // Surfaced even when unavailable, with the reason, so the ban screen can
    // say why rather than silently omitting a route out.
    apology: {
      available: apology.available,
      remaining: apology.remaining,
      reason: apology.reason,
      allowedLifetime: APPEAL_RULES.maxApologiesLifetime,
    },
    // Sent so the ban screen can say when, not just that it's paused. "Come
    // back in 34 days" is a thing someone can plan around; "you're out of
    // appeals" is not.
    appealsReopenAt: appeals.length >= attemptsAllowed(ban)
      ? new Date(appeals[0].createdAt.getTime() + APPEAL_RULES.reopenAfterDays * 864e5).toISOString()
      : null,
    // Only the decision note is exposed, never the reviewer's identity.
    //
    // Reports the row that was actually found, not all[0]. It read the most
    // recent submission regardless of which one matched, so as soon as a newer
    // submission was open the "last decision" came back with status "open" and
    // a null note — the screen then showed someone an empty outcome for a
    // decision that had really been made and really had a note attached.
    lastDecision: (() => {
      const decided = all.find((a) => a.status !== "open");
      if (!decided) return null;
      return {
        status: decided.status,
        kind: decided.kind,
        note: decided.decisionNote,
        decidedAt: decided.decidedAt?.toISOString() ?? null,
      };
    })(),
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
