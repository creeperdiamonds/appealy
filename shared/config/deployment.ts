// shared/config/deployment.ts
//
// Platform mode vs self-hosted mode.
//
// This codebase does two jobs. It's the thing running at appealy.gg for many
// guilds under one bot token and one Tebex account, and it's an open-source
// Discord bot someone clones and runs for their own server. The difference
// isn't cosmetic:
//
//   - A self-hoster has no Tebex account. `required("TEBEX_PROJECT_ID")`
//     means a fresh clone doesn't boot — the single biggest barrier to anyone
//     actually running this.
//   - Rate limit tiers are a monetization construct. Capping a self-hoster at
//     the "free" preset caps them with someone else's price list on their own
//     hardware.
//   - Platform bans are us moderating our platform. A self-hoster is their own
//     platform; telling their users to appeal on our dashboard is wrong in
//     both directions.
//
// How the mode is decided
// -----------------------
// 1. An explicit DEPLOYMENT_MODE always wins. Nothing below overrides it.
// 2. Otherwise it's inferred from whether Tebex is configured.
//
// The inference exists because both directions of "forgot to set it" used to
// fail badly:
//
//   - A self-hoster who never heard of DEPLOYMENT_MODE got a crash on a
//     missing Tebex key, which is a terrible first five minutes with an
//     open-source project.
//   - The hosted deployment that forgot the flag got `self` — billing routes
//     silently absent, every guild on flat caps, and nothing to notice until
//     a customer asks why they can't upgrade. A silent downgrade of a
//     production deployment is the worse of the two.
//
// Tebex credentials are the honest signal. Nobody sets TEBEX_PRIVATE_KEY by
// accident, and nobody running this for their own server has one.
//
// The inference is always logged, never silent — a deployment mode that
// nobody chose and nobody can see is how you end up debugging the wrong
// thing for an afternoon.

export type DeploymentMode = "platform" | "self" | "test";

/**
 * What each mode is for.
 *
 *   platform  The hosted deployment. Billing on, tiers enforced, real money.
 *
 *   self      Someone running this for their own servers. No billing account
 *             of any kind, caps come from CAP_* rather than a price list.
 *
 *   test      Production in every respect EXCEPT money. Tiers, bans, the ops
 *             surface and every feature behave exactly as they do on the
 *             platform, so what is exercised here is what ships — but no
 *             payment credentials are required and no checkout exists.
 *
 * The reason test is its own mode rather than "platform without keys": those
 * are not the same deployment. Platform-with-no-keys is a misconfiguration
 * that should refuse to boot, because it means customers can be shown prices
 * they cannot pay. Test is a deliberate state, and saying so lets the first
 * case keep failing loudly while the second works.
 */

export interface DeploymentConfig {
  mode: DeploymentMode;
  /** True when billing credentials are present but incomplete — checkout
   *  would work and nothing would ever activate. Worth showing in ops UI. */
  billingIncomplete: boolean;
  brandName: string;
  /** Where a banned user or server is told to go. Empty disables appeals. */
  supportUrl: string;
  features: {
    billing: boolean;
    tieredRateLimits: boolean;
    bans: boolean;
    publicStatus: boolean;
  };
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Built from an env accessor so this stays importable by both the Deno bot
 * (`Deno.env.get`) and the Node API (`(k) => process.env[k]`) without either
 * reaching for a runtime the other doesn't have.
 */
export interface TebexStatus {
  /** Real, usable-looking credentials. Placeholders don't count. */
  configured: boolean;
  /** Everything billing needs, not just the API credentials. */
  complete: boolean;
  problems: string[];
}

// Values people leave behind after copying .env.example or a tutorial. Treated
// as "not configured" rather than as a credential, because the alternative is
// a self-hoster who pasted a placeholder getting silently promoted into
// platform mode and then crashing on an API call at runtime.
const PLACEHOLDER = /^(your|my|the|insert|replace|change|todo|xxx+|<|\.\.\.|placeholder|example)/i;

// There is deliberately no shape check on Tebex credentials, unlike the
// sk_live_/whsec_ prefixes this used to match against.
//
// Stripe publishes its key formats and they are stable enough to validate a
// paste against. Tebex does not document one for the Checkout API pair, and a
// regex invented from a handful of observed keys would reject valid ones from
// a different account or a later format change — turning a working deployment
// into a refusal to boot, which is far worse than not catching a typo. What is
// checked below is what can be checked honestly: presence, and that it isn't a
// placeholder someone forgot to replace.

/**
 * What the Tebex config actually looks like, rather than whether a variable
 * happens to be non-empty.
 *
 * The distinction matters because "the credentials are set" is what decides
 * the deployment mode, and two different kinds of nonsense satisfy it: a
 * leftover placeholder, and real credentials with no webhook secret beside
 * them. The second is the worse one — billing boots, checkout works, the
 * customer is charged, and the plan never activates because nothing can verify
 * the callback that grants it. That failure is invisible until someone's plan
 * doesn't change after they pay.
 */
export function inspectTebex(get: (key: string) => string | undefined): TebexStatus {
  const projectId = get("TEBEX_PROJECT_ID")?.trim() ?? "";
  const privateKey = get("TEBEX_PRIVATE_KEY")?.trim() ?? "";
  const webhook = get("TEBEX_WEBHOOK_SECRET")?.trim() ?? "";
  const problems: string[] = [];

  const usable = (v: string) => v !== "" && !PLACEHOLDER.test(v);

  if (!usable(projectId) || !usable(privateKey)) {
    // Only worth a message if something was actually there — an unset variable
    // on a self-hosted clone is the expected case, not a problem.
    if (projectId || privateKey) {
      problems.push(
        "TEBEX_PROJECT_ID / TEBEX_PRIVATE_KEY look like placeholders rather than credentials — treating Tebex as unconfigured. Both come from creator.tebex.io → Developers → API Keys.",
      );
    }
    return { configured: false, complete: false, problems };
  }

  let complete = true;
  if (!usable(webhook)) {
    complete = false;
    problems.push(
      "TEBEX_WEBHOOK_SECRET is missing. Billing will appear to work — checkout completes and the customer is charged — but no plan will ever activate, because nothing can verify the callback that grants it. Get it from the webhook endpoint's settings in the Tebex creator panel.",
    );
  }

  return { configured: true, complete, problems };
}

export function resolveDeployment(
  get: (key: string) => string | undefined,
  /** Injected so tests don't print, and so each runtime can use its own logger. */
  note: (message: string) => void = (m) => console.info(m),
): DeploymentConfig {
  const explicit = get("DEPLOYMENT_MODE")?.trim().toLowerCase();
  const tebex = inspectTebex(get);
  // Discord subscriptions are the other way to be a paid deployment. If SKUs
  // are mapped, this is a platform whether or not Tebex is involved.
  const discordSkus = !!get("DISCORD_SKU_TIERS")?.trim();
  const billingConfigured = tebex.configured || discordSkus;

  let mode: DeploymentMode;

  if (explicit) {
    if (explicit !== "platform" && explicit !== "self" && explicit !== "test") {
      throw new Error(
        `DEPLOYMENT_MODE must be "platform", "self" or "test", got ${JSON.stringify(explicit)}`,
      );
    }
    mode = explicit;

    // Explicit platform mode with no credentials fails later anyway, inside
    // requiredInPlatformMode — but it fails with "Missing required environment
    // variable: TEBEX_PROJECT_ID", which doesn't mention the mode that made it
    // required. Say so here, while the reason is still obvious.
    // Deliberately platform-only. Test mode is the supported way to run
    // everything-but-money, so a platform deployment with no billing source
    // stays an error rather than quietly becoming one.
    if (mode === "platform" && !billingConfigured) {
      throw new Error(
        [
          "DEPLOYMENT_MODE=platform requires a billing source: either working Tebex configuration or DISCORD_SKU_TIERS.",
          ...tebex.problems,
          'If you are self-hosting, remove DEPLOYMENT_MODE (or set it to "self") and no Tebex account is needed.',
        ].join(" "),
      );
    }
    // The reverse is harmless but almost always a leftover from copying a
    // production .env, and leftover live keys in a self-hosted deployment are
    // worth one line of noise.
    if (mode === "test") {
      note(
        "[deployment] DEPLOYMENT_MODE=test — everything behaves as production except billing, " +
          "which is off. Nothing here can take a payment. Do not point real customers at this.",
      );
    }
    if (mode === "self" && billingConfigured) {
      note(
        "[deployment] DEPLOYMENT_MODE=self — Tebex credentials are set but will be ignored. " +
          "Remove them unless you meant DEPLOYMENT_MODE=platform.",
      );
    }
  } else {
    mode = billingConfigured ? "platform" : "self";
    const why = discordSkus
      ? "DISCORD_SKU_TIERS is set"
      : tebex.configured
      ? "Tebex credentials are configured"
      : "no billing is configured";
    note(
      `[deployment] DEPLOYMENT_MODE not set — inferred "${mode}" because ${why}. ` +
        "Set DEPLOYMENT_MODE explicitly to remove the guesswork.",
    );
  }

  const isPlatform = mode === "platform";
  // Test gets the platform's feature surface. That is the whole point: what
  // gets exercised in test should be what ships, minus the money.
  const hasPlatformFeatures = mode === "platform" || mode === "test";

  // Surface every shape problem regardless of how the mode was reached. A
  // placeholder or a pk_ key that quietly demoted the deployment to `self` is
  // exactly the thing someone needs told, not hidden by the demotion working.
  for (const p of tebex.problems) note(`[deployment] ${p}`);

  if (isPlatform) {
    // A throw, not a warning. Platform mode with working API credentials and
    // no webhook secret means customers can be charged and never receive what
    // they paid for, and nothing in the logs would say so.
    //
    // This used to be conditional on the keys being live ones, so a staging
    // deployment on test keys could boot without a webhook. Tebex publishes no
    // way to tell a test credential from a live one, so that exemption cannot
    // be made safely and is gone: if billing is configured at all, the half
    // that grants what was bought has to be configured too.
    if (isPlatform && tebex.configured && !tebex.complete) {
      throw new Error(
        "Refusing to start in platform mode with Tebex credentials and no TEBEX_WEBHOOK_SECRET. " +
          "Checkout would succeed and no plan would ever activate. " +
          "Set TEBEX_WEBHOOK_SECRET, or unset the Tebex credentials while you sort it out.",
      );
    }
  }

  return {
    mode,
    billingIncomplete: tebex.configured && !tebex.complete,
    brandName: get("BRAND_NAME")?.trim() || (isPlatform ? "Appealy" : "This bot"),
    supportUrl: get("SUPPORT_URL")?.trim() ?? "",
    features: {
      // Never available self-hosted: there is no second Tebex account to point
      // at. Off in test too — that is what makes it test.
      billing: isPlatform,
      // Self-hosters get flat caps from env instead of a price-derived tier.
      // Caps still exist — they protect the host's own Postgres pool, which
      // is the real constraint — they're just not a product ladder.
      tieredRateLimits: hasPlatformFeatures,
      // Stays available: an abusive user is an abusive user. Appeals need
      // somewhere to go, so they key off SUPPORT_URL rather than the mode.
      bans: bool(get("ENABLE_BANS"), true),
      // A one-shard self-host has nothing to report.
      publicStatus: bool(get("ENABLE_PUBLIC_STATUS"), isPlatform),
    },
  };
}

/**
 * Flat caps for self-hosted deployments.
 *
 * Deliberately generous — roughly tier2 — because the person setting these
 * owns the database they protect. A guard against a runaway loop, not a
 * product boundary.
 */
export function selfHostedCaps(get: (key: string) => string | undefined) {
  const num = (key: string, fallback: number) => {
    const v = get(key);
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(v)}`);
    }
    return n;
  };
  return {
    formsPerGuild: num("CAP_FORMS_PER_GUILD", 100),
    questionsPerForm: num("CAP_QUESTIONS_PER_FORM", 50),
    submissionsPerDay: num("CAP_SUBMISSIONS_PER_DAY", 10_000),
    ticketsPerDay: num("CAP_TICKETS_PER_DAY", 5_000),
    panelsPerGuild: num("CAP_PANELS_PER_GUILD", 100),
    pollsPerGuild: num("CAP_POLLS_PER_GUILD", 100),
    giveawaysPerGuild: num("CAP_GIVEAWAYS_PER_GUILD", 100),
    roleMenusPerGuild: num("CAP_ROLE_MENUS_PER_GUILD", 100),
  };
}

/**
 * Guilds the operator has granted raised caps to — typically your own server
 * and your support server.
 *
 * Why this is allowed to exceed CUSTOM_CAP_MAXIMUMS
 * ------------------------------------------------
 * pricing.ts calls that ceiling "the deliberate no-unlimited backstop", and
 * it stays exactly that for everyone it was written for: it stops a CUSTOMER
 * self-serving unbounded throughput through the custom-tier slider, where the
 * only thing standing between them and your database is a price.
 *
 * An operator editing their own .env is a different trust context. There is no
 * purchase to bound, and the person raising the number is the person who gets
 * paged when it's wrong. So overrides here are not clamped.
 *
 * They are still finite by default. Granting a guild CUSTOM_CAP_MAXIMUMS is
 * "as high as this system was designed to go"; granting it Infinity is
 * removing the last thing between one runaway loop in your own server and a
 * Postgres pool of ten that every other guild shares. If you want a number
 * larger than the ceiling, set it explicitly and pick a real number.
 *
 * Format:
 *   PRIVILEGED_GUILD_IDS=123456789012345678,987654321098765432
 *   PRIVILEGED_CAP_SUBMISSIONS_PER_DAY=100000     (optional, per-cap)
 *   PRIVILEGED_CAP_FORMS_PER_GUILD=1000
 *
 * Unset caps fall back to CUSTOM_CAP_MAXIMUMS, resolved in rateLimitService so
 * this module doesn't have to import pricing.ts.
 */
export interface PrivilegedGuilds {
  ids: ReadonlySet<string>;
  /** Only the caps explicitly overridden. Everything else uses the ceiling. */
  overrides: Record<string, number>;
}

const PRIVILEGED_CAP_KEYS: Record<string, string> = {
  PRIVILEGED_CAP_SUBMISSIONS_PER_DAY: "submissionsPerDay",
  PRIVILEGED_CAP_TICKETS_PER_DAY: "ticketsPerDay",
  PRIVILEGED_CAP_GIVEAWAY_ENTRIES_PER_DAY: "giveawayEntriesPerDay",
  PRIVILEGED_CAP_API_REQUESTS_PER_MINUTE: "apiRequestsPerMinute",
  PRIVILEGED_CAP_FORMS_PER_GUILD: "formsPerGuild",
  PRIVILEGED_CAP_PANELS_PER_GUILD: "panelsPerGuild",
  PRIVILEGED_CAP_ROLES_PER_RULE_TYPE: "rolesPerRuleType",
  PRIVILEGED_CAP_HISTORY_RETENTION_DAYS: "historyRetentionDays",
};

export function privilegedGuilds(
  get: (key: string) => string | undefined,
  note: (message: string) => void = (m) => console.info(m),
): PrivilegedGuilds {
  const raw = get("PRIVILEGED_GUILD_IDS")?.trim();
  const ids = new Set<string>();

  if (raw) {
    for (const id of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      // Strict, and fatal. A typo'd id here fails silently forever otherwise —
      // the guild just keeps hitting normal caps and nobody connects the two.
      if (!/^\d{15,25}$/.test(id)) {
        throw new Error(
          `PRIVILEGED_GUILD_IDS contains something that isn't a Discord guild ID: ${JSON.stringify(id)}`,
        );
      }
      ids.add(id);
    }
  }

  const overrides: Record<string, number> = {};
  for (const [envKey, capKey] of Object.entries(PRIVILEGED_CAP_KEYS)) {
    const v = get(envKey)?.trim();
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${envKey} must be a non-negative finite number, got ${JSON.stringify(v)}`);
    }
    overrides[capKey] = n;
  }

  if (ids.size > 0) {
    note(
      `[deployment] ${ids.size} privileged guild(s) exempt from tier caps` +
        (Object.keys(overrides).length > 0
          ? `, with ${Object.keys(overrides).length} custom cap override(s).`
          : " — using CUSTOM_CAP_MAXIMUMS."),
    );
  } else if (Object.keys(overrides).length > 0) {
    note(
      "[deployment] PRIVILEGED_CAP_* values are set but PRIVILEGED_GUILD_IDS is empty, so they apply to nothing.",
    );
  }

  return { ids, overrides };
}

/**
 * No telemetry, in either mode.
 *
 * Asserted as code rather than promised in a README, so it shows up in a diff
 * if it ever stops being true.
 */
export const TELEMETRY_ENABLED = false as const;
