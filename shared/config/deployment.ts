// shared/config/deployment.ts
//
// Platform mode vs self-hosted mode.
//
// This codebase does two jobs. It's the thing running at appealy.gg for many
// guilds under one bot token and one Stripe account, and it's an open-source
// Discord bot someone clones and runs for their own server. The difference
// isn't cosmetic:
//
//   - A self-hoster has no Stripe account. `required("STRIPE_SECRET_KEY")`
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
// 2. Otherwise it's inferred from whether Stripe is configured.
//
// The inference exists because both directions of "forgot to set it" used to
// fail badly:
//
//   - A self-hoster who never heard of DEPLOYMENT_MODE got a crash on a
//     missing Stripe key, which is a terrible first five minutes with an
//     open-source project.
//   - The hosted deployment that forgot the flag got `self` — billing routes
//     silently absent, every guild on flat caps, and nothing to notice until
//     a customer asks why they can't upgrade. A silent downgrade of a
//     production deployment is the worse of the two.
//
// Stripe keys are the honest signal. Nobody sets STRIPE_SECRET_KEY by accident,
// and nobody running this for their own server has one.
//
// The inference is always logged, never silent — a deployment mode that
// nobody chose and nobody can see is how you end up debugging the wrong
// thing for an afternoon.

export type DeploymentMode = "platform" | "self";

export interface DeploymentConfig {
  mode: DeploymentMode;
  /** null when Stripe isn't configured. Worth showing in ops UI — "test" on a
   *  production deployment is a whole class of bug that hides otherwise. */
  stripeKeyMode: StripeKeyMode | null;
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
export type StripeKeyMode = "live" | "test";

export interface StripeStatus {
  /** A real, usable-looking key. Placeholders don't count. */
  configured: boolean;
  keyMode: StripeKeyMode | null;
  /** Everything billing needs, not just the secret key. */
  complete: boolean;
  problems: string[];
}

// Values people leave behind after copying .env.example or a tutorial. Treated
// as "not configured" rather than as a key, because the alternative is a
// self-hoster who pasted a placeholder getting silently promoted into platform
// mode and then crashing on a Stripe API call at runtime.
const PLACEHOLDER = /^(your|my|the|insert|replace|change|todo|xxx+|<|\.\.\.|sk_live_xxx|sk_test_xxx|placeholder|example)/i;

// Secret keys and restricted keys, live or test. Publishable keys (pk_) are
// deliberately excluded — a pk_ here means someone pasted the wrong one, and
// silently accepting it produces 401s from Stripe much later.
const STRIPE_SECRET = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/;
const STRIPE_WEBHOOK = /^whsec_[A-Za-z0-9]{8,}$/;

/**
 * What Stripe config actually looks like, rather than whether a variable
 * happens to be non-empty.
 *
 * The distinction matters because "STRIPE_SECRET_KEY is set" is what decides
 * the deployment mode, and three different kinds of nonsense all satisfy it:
 * a leftover placeholder, a publishable key pasted into the secret slot, and
 * a valid secret key with no webhook secret beside it. The last one is the
 * worst — billing boots, checkout works, and subscription state never updates
 * because nothing can verify the webhook. That failure is invisible until a
 * customer's plan doesn't change after they pay.
 */
export function inspectStripe(get: (key: string) => string | undefined): StripeStatus {
  const secret = get("STRIPE_SECRET_KEY")?.trim() ?? "";
  const webhook = get("STRIPE_WEBHOOK_SECRET")?.trim() ?? "";
  const problems: string[] = [];

  if (!secret || PLACEHOLDER.test(secret)) {
    if (secret) {
      problems.push(
        `STRIPE_SECRET_KEY looks like a placeholder (${JSON.stringify(secret.slice(0, 12))}…), not a key — treating Stripe as unconfigured.`,
      );
    }
    return { configured: false, keyMode: null, complete: false, problems };
  }

  if (secret.startsWith("pk_")) {
    problems.push(
      "STRIPE_SECRET_KEY holds a publishable key (pk_…). That's the browser-side key — you want the secret key (sk_…) from Stripe → Developers → API keys.",
    );
    return { configured: false, keyMode: null, complete: false, problems };
  }

  if (!STRIPE_SECRET.test(secret)) {
    problems.push(
      "STRIPE_SECRET_KEY doesn't match the shape of a Stripe secret key (sk_live_… / sk_test_… / rk_…). Check for a truncated paste or stray quotes.",
    );
    return { configured: false, keyMode: null, complete: false, problems };
  }

  const keyMode: StripeKeyMode = secret.includes("_live_") ? "live" : "test";

  let complete = true;
  if (!webhook || PLACEHOLDER.test(webhook)) {
    complete = false;
    problems.push(
      "STRIPE_WEBHOOK_SECRET is missing. Billing will appear to work — checkout completes — but no subscription will ever activate, because nothing can verify Stripe's callbacks. Get it from Stripe → Developers → Webhooks → your endpoint → Signing secret.",
    );
  } else if (!STRIPE_WEBHOOK.test(webhook)) {
    complete = false;
    problems.push("STRIPE_WEBHOOK_SECRET should start with whsec_ — check the paste.");
  }

  return { configured: true, keyMode, complete, problems };
}

export function resolveDeployment(
  get: (key: string) => string | undefined,
  /** Injected so tests don't print, and so each runtime can use its own logger. */
  note: (message: string) => void = (m) => console.info(m),
): DeploymentConfig {
  const explicit = get("DEPLOYMENT_MODE")?.trim().toLowerCase();
  const stripe = inspectStripe(get);
  // Discord subscriptions are the other way to be a paid deployment. If SKUs
  // are mapped, this is a platform whether or not Stripe is involved.
  const discordSkus = !!get("DISCORD_SKU_TIERS")?.trim();
  const stripeConfigured = stripe.configured || discordSkus;

  let mode: DeploymentMode;

  if (explicit) {
    if (explicit !== "platform" && explicit !== "self") {
      throw new Error(
        `DEPLOYMENT_MODE must be "platform" or "self", got ${JSON.stringify(explicit)}`,
      );
    }
    mode = explicit;

    // Explicit platform mode with no Stripe key fails later anyway, inside
    // requiredInPlatformMode — but it fails with "Missing required environment
    // variable: STRIPE_SECRET_KEY", which doesn't mention the mode that made
    // it required. Say so here, while the reason is still obvious.
    if (mode === "platform" && !stripeConfigured) {
      throw new Error(
        [
          "DEPLOYMENT_MODE=platform requires a billing source: either working Stripe configuration or DISCORD_SKU_TIERS.",
          ...stripe.problems,
          'If you are self-hosting, remove DEPLOYMENT_MODE (or set it to "self") and no Stripe account is needed.',
        ].join(" "),
      );
    }
    // The reverse is harmless but almost always a leftover from copying a
    // production .env, and leftover live keys in a self-hosted deployment are
    // worth one line of noise.
    if (mode === "self" && stripeConfigured) {
      note(
        "[deployment] DEPLOYMENT_MODE=self — STRIPE_SECRET_KEY is set but will be ignored. " +
          "Remove it unless you meant DEPLOYMENT_MODE=platform.",
      );
    }
  } else {
    mode = stripeConfigured ? "platform" : "self";
    const why = discordSkus
      ? "DISCORD_SKU_TIERS is set"
      : stripe.configured
      ? "STRIPE_SECRET_KEY is configured"
      : "no billing is configured";
    note(
      `[deployment] DEPLOYMENT_MODE not set — inferred "${mode}" because ${why}. ` +
        "Set DEPLOYMENT_MODE explicitly to remove the guesswork.",
    );
  }

  const isPlatform = mode === "platform";

  // Surface every shape problem regardless of how the mode was reached. A
  // placeholder or a pk_ key that quietly demoted the deployment to `self` is
  // exactly the thing someone needs told, not hidden by the demotion working.
  for (const p of stripe.problems) note(`[deployment] ${p}`);

  if (isPlatform) {
    // Not a throw. A staging deployment on test keys is legitimate and common,
    // and refusing to boot would make staging harder than production.
    if (stripe.keyMode === "test") {
      note(
        "[deployment] Stripe is in TEST mode — no real charges will be made. " +
          "Expected for staging; wrong for production.",
      );
    }
    // This one is a throw. Platform mode with live keys and no verifiable
    // webhook means customers can pay and never receive what they paid for,
    // and nothing in the logs would say so.
    if (stripe.keyMode === "live" && !stripe.complete) {
      throw new Error(
        "Refusing to start in platform mode with live Stripe keys and no valid STRIPE_WEBHOOK_SECRET. " +
          "Checkout would succeed and no subscription would ever activate. " +
          "Set STRIPE_WEBHOOK_SECRET, or use test keys while you sort it out.",
      );
    }
  }

  return {
    mode,
    stripeKeyMode: stripe.keyMode,
    brandName: get("BRAND_NAME")?.trim() || (isPlatform ? "Appealy" : "This bot"),
    supportUrl: get("SUPPORT_URL")?.trim() ?? "",
    features: {
      // Never available self-hosted: there is no second Stripe account to
      // point at.
      billing: isPlatform,
      // Self-hosters get flat caps from env instead of a price-derived tier.
      // Caps still exist — they protect the host's own Postgres pool, which
      // is the real constraint — they're just not a product ladder.
      tieredRateLimits: isPlatform,
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
