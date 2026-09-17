// api/src/routes/feedback.ts
//
// Somewhere for "how is this working out for you" to land.
//
// WHY THIS IS NOT A DISCORD LINK
//
// The dashboard banner used to point at the Discord server. That asks someone
// to leave the thing they are using, join a server, find a channel and write a
// post — four steps to say "the forms page is confusing", which is three more
// than most people will spend. A form in front of them gets answers; a link
// gets a number you cannot interpret.
//
// WHY IT IS STORED RATHER THAN FORWARDED
//
// A webhook into a Discord channel would have been less code. But these
// answers are the record of why the product changed shape, and a channel
// scrolls: the reason behind a decision taken in October is unfindable by
// March. A table can be read in order, quoted in a commit message, and still
// answers the question "did anyone actually ask for this" a year later.
//
// WHAT IS TRUSTED
//
// The guild comes from the route, which requireGuildAccess has already checked
// against the session — so nobody can file feedback against a server they
// cannot administer. The author comes from the session, never the body: an
// author id a client could choose is not evidence of anything.

import { Router } from "express";
import { z } from "zod";

import { db, schema } from "../db/client.ts";
import { requireGuildAccess } from "../middleware/guildAccess.ts";
import { routeParams } from "../utils/routeParams.ts";
import { logger } from "../utils/logger.ts";

// mergeParams is load-bearing, not decoration: without it the :guildId from
// the parent mount is simply absent at runtime, and routeParams would hand
// back undefined while still typing it as a string.
export const feedbackRouter = Router({ mergeParams: true });

// Same gate as every other guild-scoped router. Feedback is low-stakes, but
// an ungated write keyed on a guild id from the URL would let anyone file
// answers against a server they have nothing to do with — which would quietly
// poison the one record of what users actually want.
feedbackRouter.use(requireGuildAccess);

/**
 * Every field optional, and that is deliberate: the most useful answer is
 * often one sentence in one box. Requiring all three would turn a 20-second
 * favour into a form to be abandoned halfway.
 *
 * Capped at 2000 characters each — long enough for a considered answer, short
 * enough that the column cannot be used as free storage.
 */
const Body = z.object({
  usedFor: z.string().trim().max(2000).optional(),
  annoyance: z.string().trim().max(2000).optional(),
  missing: z.string().trim().max(2000).optional(),
});

feedbackRouter.post("/", async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  const { usedFor, annoyance, missing } = parsed.data;
  if (!usedFor && !annoyance && !missing) {
    // An empty submission is a misclick, not an opinion. Refusing it keeps the
    // table something you can read top to bottom without skipping blanks.
    return res.status(400).json({ error: "empty", detail: "Answer at least one question." });
  }

  const guildId = BigInt(routeParams(req).guildId);
  const authorId = req.userId!;

  await db.insert(schema.feedback).values({
    guildId,
    authorId,
    usedFor: usedFor || null,
    annoyance: annoyance || null,
    missing: missing || null,
  });

  // Logged because feedback arriving is worth noticing the same day, not the
  // next time someone opens the ops page. The text is not logged: it belongs
  // in the table, not scattered through log storage.
  logger.info("Feedback received", {
    guildId: guildId.toString(),
    answered: [usedFor && "usedFor", annoyance && "annoyance", missing && "missing"].filter(Boolean),
  });

  res.status(201).json({ ok: true });
});
