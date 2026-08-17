// api/src/app.ts

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { env } from "./env.ts";
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
import { stripeWebhookRouter } from "./routes/stripeWebhook.ts";
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

  // Mounted BEFORE express.json() and using its own raw() body parser
  // (see routes/stripeWebhook.ts) — Stripe's signature is computed over
  // the exact raw request bytes, so this route must never see a body
  // that's already been parsed and would be re-serialized differently.
  app.use("/webhooks", stripeWebhookRouter);

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Reports the state of dependencies rather than just "the process is
  // running". A load balancer needs to know the difference between a
  // healthy API and one that's up but can't reach Redis — the second still
  // serves traffic here (see the fail-open notes in lib/redis.ts) but at
  // reduced protection, and that should be visible rather than silent.
  app.get("/health", async (_req, res) => {
    const redisOk = await redisHealthy();
    res.status(200).json({
      status: redisOk ? "ok" : "degraded",
      redis: redisOk ? "up" : "down",
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
