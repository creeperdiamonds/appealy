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
// WHY IT IS PER PERSON
//
// An answer is one admin's opinion of Appealy, not a fact about whichever
// server their dashboard happened to have open, so no server is recorded.
// It used to be mounted under /api/guilds/:guildId and stored that id; rows
// from before 2026-09-30 still carry it.
//
// WHAT IS TRUSTED
//
// The author comes from the session (requireSession, where this is mounted in
// app.ts), never the body: an author id a client could choose is not evidence
// of anything.

import { Router } from "express";
import { z } from "zod";

import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";

export const feedbackRouter = Router();

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

  const authorId = req.userId!;

  await db.insert(schema.feedback).values({
    authorId,
    usedFor: usedFor || null,
    annoyance: annoyance || null,
    missing: missing || null,
  });

  // Logged because feedback arriving is worth noticing the same day, not the
  // next time someone opens the ops page. The text is not logged: it belongs
  // in the table, not scattered through log storage.
  logger.info("Feedback received", {
    answered: [usedFor && "usedFor", annoyance && "annoyance", missing && "missing"].filter(Boolean),
  });

  res.status(201).json({ ok: true });
});
