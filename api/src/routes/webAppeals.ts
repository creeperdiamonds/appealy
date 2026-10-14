// api/src/routes/webAppeals.ts
//
// The web appeal link: appealy.app/appeal/<server id>
// (web/src/pages/WebAppeal.tsx). Someone banned from a server signs in with
// Discord and fills in that server's ban appeal form on the page, without
// needing to share another server with the bot or accept its DMs.
//
//   GET  /api/appeal/:guildId      public: the server and its appeal form
//   GET  /api/appeal/:guildId/me   signed in: banned here or not, last appeal
//   POST /api/appeal/:guildId      signed in: submit
//
// The bot does the deciding (bot/src/services/webAppeal.ts): it asks Discord
// whether the person is banned, checks the answers and the form's cooldown and
// pending rules, and posts the appeal for staff like any other. This file signs
// people in, reads what's public, and throttles.
//
// A server opts in by turning ban appeals on with a form, as for the DM. There
// is no separate switch: the link is only another way to reach the same form.

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireSession } from "../middleware/auth.ts";
import { banGate } from "../middleware/banGate.ts";
import { botCallFailure, submitWebAppeal, webAppealStatus } from "../services/botBridge.ts";
import { withRedis } from "../lib/redis.ts";
import { guildIconUrl } from "./auth.ts";

export const webAppealsRouter: Router = Router();

const SNOWFLAKE = /^\d{17,20}$/;

/** Seconds between two submits from one person to one server. */
const SUBMIT_THROTTLE_SECONDS = 30;

webAppealsRouter.get("/:guildId", async (req, res) => {
  const { guildId } = req.params;
  if (!SNOWFLAKE.test(guildId)) return res.status(404).json({ error: "unavailable" });
  const id = BigInt(guildId);

  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, id) });
  const config = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, id) });
  const form = config?.enabled && config.formId
    ? await db.query.forms.findFirst({
      where: and(eq(schema.forms.id, config.formId), eq(schema.forms.guildId, id)),
      with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
    })
    : null;

  // One answer for every reason, so the page can't be used to learn which
  // servers use Appealy without appeals.
  if (!guild?.botPresent || !form || form.kind !== "appeal" || !form.active) {
    return res.status(404).json({ error: "unavailable" });
  }

  res.json({
    guild: { id: guildId, name: guild.name, iconUrl: guildIconUrl(guildId, guild.iconHash) },
    form: {
      name: form.name,
      description: form.description ?? "",
      questions: form.questions.map((q) => ({
        id: q.id,
        label: q.label,
        placeholder: q.placeholder,
        type: q.type,
        required: q.required,
        minLength: q.minLength,
        maxLength: q.maxLength,
        validationType: q.validationType,
        validationPattern: q.validationPattern,
        validationErrorMessage: q.validationErrorMessage,
      })),
    },
  });
});

// Signed in from here on. banGate turns away accounts banned from Appealy
// itself, which may not file appeals anywhere.
webAppealsRouter.use("/:guildId", requireSession, banGate);

/** Status checks per person per minute. Each one asks Discord about a ban. */
const STATUS_PER_MINUTE = 20;

webAppealsRouter.get("/:guildId/me", async (req, res) => {
  const { guildId } = req.params;
  if (!SNOWFLAKE.test(guildId)) return res.status(404).json({ error: "unavailable" });
  // A page load is one check. Far more than that is a script spending the
  // bot's Discord rate limit. Fails open.
  const count = await withRedis(async (r) => {
    const key = `web_appeal:status:${req.userId}`;
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 60);
    return n;
  }, 0);
  if (count > STATUS_PER_MINUTE) {
    return res.status(429).json({ error: "refused", message: "Too many checks. Wait a minute and reload." });
  }
  try {
    res.json(await webAppealStatus(guildId, String(req.userId)));
  } catch (err) {
    res.status(502).json(botCallFailure(err));
  }
});

const submitBody = z.object({
  answers: z.record(z.string(), z.string().max(4000)),
  completionSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
});

webAppealsRouter.post("/:guildId", async (req, res) => {
  const { guildId } = req.params;
  if (!SNOWFLAKE.test(guildId)) return res.status(404).json({ error: "unavailable" });
  const body = submitBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "invalid_body" });

  // Double clicks and scripts. The form's own cooldown and one-pending rule,
  // checked by the bot, are the real limit; this fails open.
  const fresh = await withRedis(
    (r) => r.set(`web_appeal:rl:${guildId}:${req.userId}`, "1", "EX", SUBMIT_THROTTLE_SECONDS, "NX"),
    "OK",
  );
  if (!fresh) {
    return res.status(429).json({ error: "refused", message: "You just sent one. Wait a moment before trying again." });
  }

  try {
    const result = await submitWebAppeal(guildId, String(req.userId), body.data.answers, body.data.completionSeconds ?? null);
    const code = {
      submitted: 201,
      invalid: 400,
      not_banned: 403,
      unavailable: 404,
      cant_check: 409,
      refused: 429,
    }[result.status];
    res.status(code).json(result);
  } catch (err) {
    res.status(502).json(botCallFailure(err));
  }
});
