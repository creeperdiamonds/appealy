// api/src/app.ts

import express from "express";
import cookieParser from "cookie-parser";
// Must be imported before any router is defined. Express 4 does not await an
// async handler, so a route that throws becomes an unhandled rejection and
// Node exits — one bad request takes the whole API down for everyone, which is
// exactly what a missing db.query table did. This patches Express to forward
// async errors to the errorHandler mounted at the bottom of this file, which
// was always the intent; it simply never received them.
//
// Express 5 does this natively. Remove this import when upgrading.
import "express-async-errors";
import cors from "cors";
import { env } from "./env.ts";
import { deployment } from "./env.ts";
import { useMemoryRedis } from "../../shared/lib/memoryRedis.ts";
import { authRouter } from "./routes/auth.ts";
import { formsRouter } from "./routes/forms.ts";
import { panelsRouter } from "./routes/panels.ts";
import { submissionsRouter } from "./routes/submissions.ts";
import { dmTemplatesRouter } from "./routes/dmTemplates.ts";
import { pollsRouter } from "./routes/polls.ts";
import { staffPermissionsRouter } from "./routes/staffPermissions.ts";
import { guildResourcesRouter } from "./routes/guildResources.ts";
import { ticketsRouter } from "./routes/tickets.ts";
import { giveawaysRouter } from "./routes/giveaways.ts";
import { verificationRouter } from "./routes/verification.ts";
import { welcomerRouter } from "./routes/welcomer.ts";
import { billingRouter } from "./routes/billing.ts";
import { tebexWebhookRouter } from "./routes/tebexWebhook.ts";
import { roleMenusRouter } from "./routes/roleMenus.ts";
import { antiRaidRouter } from "./routes/antiRaid.ts";
import { quickResponsesRouter } from "./routes/quickResponses.ts";
import { stickyMessagesRouter } from "./routes/stickyMessages.ts";
import { migrationRouter } from "./routes/migration.ts";
import { appealConfigRouter } from "./routes/appealConfig.ts";
import { outcomesRouter } from "./routes/outcomes.ts";
import { opsRouter } from "./routes/ops.ts";
import { platformAppealsRouter } from "./routes/platformAppeals.ts";
import { banGate } from "./middleware/banGate.ts";
import { requireOpsUser } from "./middleware/requireOpsUser.ts";
import { overviewRouter } from "./routes/overview.ts";
import { requireSession } from "./middleware/auth.ts";
import { guildApiRateLimit } from "./middleware/apiRateLimit.ts";
import { invalidateOnWrite } from "./services/cacheInvalidation.ts";
import { errorHandler } from "./middleware/errorHandler.ts";
import { redisHealthy } from "./lib/redis.ts";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    }),
  );

  // Mounted BEFORE express.json() and using its own raw() body parser (see
  // routes/tebexWebhook.ts) — the signature is computed over the exact raw
  // request bytes, so this route must never see a body that has already been
  // parsed and would re-serialise differently. Tebex's docs call out Express
  // by name for exactly this.
  app.use("/webhooks", tebexWebhookRouter);

  // Nothing this API returns may be cached, ever.
  //
  // Two separate reasons, either sufficient on its own:
  //
  //   Staleness. Express sets an ETag and no Cache-Control, which leaves the
  //   browser to guess — and it guesses "reusable". A soft reload (F5) then
  //   serves the previous body without asking. That is how a one-off degraded
  //   response — /auth/me/guilds answering 200 with an empty list because
  //   Discord was briefly unreachable — kept rendering "No servers yet" long
  //   after the real list was available again, on every reload but a hard one.
  //
  //   Disclosure. Every response here is scoped to one session: which servers
  //   someone administers, submission answers, ban appeals. Without no-store
  //   that sits in the browser's on-disk cache, and in any intermediary that
  //   takes the absence of a directive as permission.
  //
  // Mounted before the routers so it covers all of them rather than being
  // remembered per route.
  // Every snowflake in this schema is a Postgres bigint, and JSON.stringify
  // throws on one rather than guessing — so any route that returns a row
  // straight from drizzle dies with "Do not know how to serialize a BigInt"
  // the moment that table has data in it. Several did. It stayed hidden
  // because an empty table serialises fine, so the routes look healthy until
  // someone actually creates something.
  //
  // Strings, not numbers: a Discord snowflake exceeds Number.MAX_SAFE_INTEGER,
  // and JSON has one numeric type. Silently rounding an id is worse than
  // failing to send it. This is the convention the DTOs already follow by
  // hand; this makes it true for the routes that don't.
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Reports the state of dependencies rather than just "the process is
  // running". A load balancer needs to know the difference between a
  // healthy API and one that's up but can't reach Redis — the second still
  // serves traffic here (see the fail-open notes in lib/redis.ts) but at
  // reduced protection, and that should be visible rather than silent.
  // What kind of deployment this is, for the dashboard.
  //
  // The console had no way to ask. It was written for the hosted platform and
  // assumed it: billing screens, tier ladders and an ops surface that a
  // self-hosted instance has no account behind and no use for. Rendering them
  // anyway is the same failure as the uninvited-server one — a UI asserting
  // something untrue about the deployment it is running in.
  //
  // Unauthenticated on purpose. None of it is secret — a brand name, a support
  // link, and which features exist — and the login screen needs the brand
  // before anyone has a session to authenticate with.
  //
  // Under /api rather than /config so the dev proxy and nginx already forward
  // it; a third prefix would have to be added in two places and remembered in
  // a third.
  app.get("/api/config", (_req, res) => {
    res.json({
      mode: deployment.mode,
      brandName: deployment.brandName,
      supportUrl: deployment.supportUrl,
      features: deployment.features,
    });
  });

  app.get("/health", async (_req, res) => {
    // "memory" is a third state, not a degraded second one. Running on the
    // in-process substitute is a deliberate configuration (POC.md), and
    // reporting it as redis:down made a working deployment look broken —
    // which is how a real outage gets ignored later.
    const usingShim = useMemoryRedis(env.REDIS_URL);
    const redisOk = usingShim ? true : await redisHealthy();
    res.status(200).json({
      status: redisOk ? "ok" : "degraded",
      redis: usingShim ? "memory" : redisOk ? "up" : "down",
    });
  });

  app.use("/auth", authRouter);

  // Everything under /api/guilds/:guildId/* requires a valid session;
  // per-route guild-membership/permission checks happen in requireGuildAccess
  // inside each mounted router.
  // Order matters. Session first (cheap, no I/O beyond one indexed lookup),
  // then the per-guild request cap, then cache invalidation registration.
  //
  // Rate limiting deliberately sits AFTER auth: limiting by guild requires
  // knowing the request is legitimately for that guild, and letting
  // unauthenticated requests consume a paying customer's quota would turn
  // the rate limiter into a denial-of-service vector against them.
  // Order is the security here.
  //
  // Platform appeals mount FIRST and outside banGate — they are the only
  // endpoints a banned account may reach, and a ban screen whose form 403s is
  // worse than no appeal process at all.
  app.use("/api/platform-appeals", platformAppealsRouter);

  // Everything below requires a session. banGate then short-circuits a
  // user-banned account with a typed 403 the SPA renders as the ban screen.
  app.use("/api/ops", requireSession, requireOpsUser, opsRouter);

  app.use("/api/guilds/:guildId", requireSession);
  app.use("/api/guilds/:guildId", banGate);
  app.use("/api/guilds/:guildId", guildApiRateLimit);
  app.use("/api/guilds/:guildId", invalidateOnWrite);

  app.use("/api/guilds/:guildId/overview", overviewRouter);
  app.use("/api/guilds/:guildId/forms", formsRouter);
  app.use("/api/guilds/:guildId/forms/:formId/dm-templates", dmTemplatesRouter);
  app.use("/api/guilds/:guildId/panels", panelsRouter);
  app.use("/api/guilds/:guildId/submissions", submissionsRouter);
  app.use("/api/guilds/:guildId/polls", pollsRouter);
  app.use("/api/guilds/:guildId/staff-permissions", staffPermissionsRouter);
  app.use("/api/guilds/:guildId/resources", guildResourcesRouter);
  app.use("/api/guilds/:guildId/ticket-configs", ticketsRouter);
  app.use("/api/guilds/:guildId/giveaways", giveawaysRouter);
  app.use("/api/guilds/:guildId/verification", verificationRouter);
  app.use("/api/guilds/:guildId/appeal-config", appealConfigRouter);
  app.use("/api/guilds/:guildId/forms/:formId/outcomes", outcomesRouter);
  app.use("/api/guilds/:guildId/welcomer", welcomerRouter);
  app.use("/api/guilds/:guildId/billing", billingRouter);
  app.use("/api/guilds/:guildId/role-menus", roleMenusRouter);
  app.use("/api/guilds/:guildId/anti-raid", antiRaidRouter);
  app.use("/api/guilds/:guildId/quick-responses", quickResponsesRouter);
  app.use("/api/guilds/:guildId/sticky-messages", stickyMessagesRouter);
  app.use("/api/guilds/:guildId", migrationRouter);

  app.use(errorHandler);

  return app;
}
