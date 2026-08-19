// web/src/pages/Billing.tsx
//
// Plan, caps, and checkout.
//
// The one rule this file exists to obey: it never computes a price. Every
// figure on screen — annual total, monthly equivalent, per-cap line items,
// what's above the free baseline — comes back from POST /billing/quote, which
// delegates to shared/schema/pricing.ts, which is also what checkout charges
// and what the bot enforces. A client-side copy of that arithmetic would be
// correct for exactly as long as nobody edits the price table, and the first
// time it drifted the symptom would be a customer being quoted one number and
// billed another. So the page is a form that POSTs on every change and renders
// whatever comes back, including the parts it would be trivial to derive.
//
// Money is integer cents everywhere, start to finish. usd() below divides only
// at the last moment, with integer division and a padded remainder, so no float
// ever touches a price. Same reason the calculator is integers-only: fractional
// cents accumulate error that is individually invisible and collectively a bug.
//
// Billing is ANNUAL ONLY, deliberately and permanently. Card processing is
// roughly 2.9% + $0.30 per transaction; twelve small monthly charges hand the
// processor ~9% of revenue where one annual charge costs ~3%. There is no
// monthly option anywhere in pricing.ts and there is no monthly option here.
// The monthly figure shown next to each price is a comparison aid, computed by
// the server (never hardcoded, never derived here) and labelled as such — it is
// never presented as something you can buy.
//
// Billing can also be absent entirely. In "self" mode there is no billing
// account and caps come from CAP_* env vars; in "test" mode everything works
// except money. Both are deliberate configurations, not failures, so this page
// says so instead of rendering an error — and it also survives the routes
// simply 404ing, since a deployment can be reconfigured without this page
// hearing about it.

import { useCallback, useEffect, useState } from "react";
import { DedicatedBotPanel } from "../components/DedicatedBotPanel";
import { http, ApiError } from "../lib/api";
import { Panel, Banner, Loading, Stat, Pill } from "../components/ui";

type RateLimitTier = "free" | "tier1" | "tier2" | "custom";
type HostingMode = "shared" | "custom";

interface Caps {
  submissionsPerDay: number;
  ticketsPerDay: number;
  giveawayEntriesPerDay: number;
  apiRequestsPerMinute: number;
  formsPerGuild: number;
  panelsPerGuild: number;
  rolesPerRuleType: number;
  historyRetentionDays: number;
}

interface AnnualPrice {
  annualUsdCents: number;
  /** Computed server-side from the annual price. Comparison only — see header. */
  monthlyEquivalentUsdCents: number;
}

interface CapLine {
  cap: keyof Caps;
  requested: number;
  freeBaseline: number;
  maximum: number;
  unitsAboveBaseline: number;
  lineTotalUsdCents: number;
}

interface CapError {
  cap: keyof Caps;
  requested: number;
  maximum: number;
}

interface FullQuote {
  valid: boolean;
  errors: CapError[];
  throughput: {
    tier: RateLimitTier;
    caps: Caps;
    price: AnnualPrice;
    customQuote?: { valid: boolean; errors: CapError[]; lines: CapLine[]; totalUsdCentsPerYear: number };
  };
  hosting: { mode: HostingMode; price: AnnualPrice | null };
  totalUsdCentsPerYear: number;
  totalMonthlyEquivalentUsdCents: number;
  belowMinimumCharge: boolean;
}

interface PresetsResponse {
  presets: Record<Exclude<RateLimitTier, "custom">, { caps: Caps; priceUsdCentsPerYear: number }>;
  customCapMaximums: Caps;
  customBotHosting: AnnualPrice;
  minimumChargeUsdCents: number;
}

interface CurrentResponse {
  current: FullQuote;
  customBillingRenewsAt: string | null;
}

interface DeploymentInfo {
  mode: "platform" | "self" | "test";
  brandName: string;
  features: { billing: boolean };
}

const CAP_ORDER: (keyof Caps)[] = [
  "submissionsPerDay",
  "ticketsPerDay",
  "giveawayEntriesPerDay",
  "apiRequestsPerMinute",
  "formsPerGuild",
  "panelsPerGuild",
  "rolesPerRuleType",
  "historyRetentionDays",
];

const CAP_LABELS: Record<keyof Caps, string> = {
  submissionsPerDay: "Applications per day",
  ticketsPerDay: "Tickets per day",
  giveawayEntriesPerDay: "Giveaway entries per day",
  apiRequestsPerMinute: "Dashboard requests per minute",
  formsPerGuild: "Forms",
  panelsPerGuild: "Panels",
  rolesPerRuleType: "Roles per rule",
  historyRetentionDays: "History kept (days)",
};

const TIER_LABELS: Record<RateLimitTier, string> = {
  free: "Free",
  tier1: "Tier 1",
  tier2: "Tier 2",
  custom: "Custom caps",
};

/**
 * Integer cents to a display string. The only division in this file, and it's
 * integer division plus a zero-padded remainder rather than `cents / 100`,
 * because the moment a price becomes a float it can be off by a cent in a
 * direction nobody chose.
 */
function usd(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, "0")}`;
}

function describe(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.isUnavailable) return "Discord didn't answer, so your permissions couldn't be checked. Try again in a moment.";
  if (e.code === "admin_access_required") return "Only server admins can change the plan or start a checkout.";
  if (e.code === "invalid_body") return "The server rejected those caps. Check that every value is a whole number.";
  // Everything else — below_minimum_charge, invalid_custom_caps,
  // nothing_to_charge, checkout_creation_failed — ships a written `detail`,
  // and the API's own sentence is more accurate than anything paraphrased
  // here. It names the minimum, the offending field, or the alternative route.
  return e.message || fallback;
}

/** Billing routes vanishing is a valid deployment, not a failure. 401 is
 * already handled inside api.ts, and a real permission refusal has its own
 * code, so what's left at 403/404 is "this deployment has no billing". */
function looksAbsent(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "guild_not_found") return false;
  if (e.code === "insufficient_permissions" || e.code === "admin_access_required") return false;
  return e.status === 404 || e.status === 403;
}

export default function Billing({ guildId }: { guildId: string }) {
  const base = `/api/guilds/${guildId}/billing`;

  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [current, setCurrent] = useState<CurrentResponse | null>(null);
  const [absent, setAbsent] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  // The selection being priced. Separate from `current` so an admin can look
  // at what a change would cost without having changed anything yet.
  const [tier, setTier] = useState<RateLimitTier>("free");
  const [hosting, setHosting] = useState<HostingMode>("shared");
  const [caps, setCaps] = useState<Caps | null>(null);

  const [quote, setQuote] = useState<FullQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);

  const load = useCallback(async () => {
    // /config is unauthenticated and tells us whether billing exists at all,
    // which is a better answer than inferring it from a 404 after the fact.
    // It's allowed to fail — an older API won't have it — in which case the
    // billing routes themselves decide.
    const [cfg, cur, pre] = await Promise.allSettled([
      http.get<DeploymentInfo>("/config"),
      http.get<CurrentResponse>(`/api/guilds/${guildId}/billing`),
      http.get<PresetsResponse>(`/api/guilds/${guildId}/billing/presets`),
    ]);

    if (cfg.status === "fulfilled") {
      setDeployment(cfg.value);
      if (!cfg.value.features.billing) {
        setAbsent(true);
        return;
      }
    }

    if (cur.status === "rejected" || pre.status === "rejected") {
      const reason = cur.status === "rejected" ? cur.reason : (pre as PromiseRejectedResult).reason;
      if (looksAbsent(reason)) setAbsent(true);
      else setFatal(describe(reason, "Couldn't load billing."));
      return;
    }

    setCurrent(cur.value);
    setPresets(pre.value);
    setTier(cur.value.current.throughput.tier);
    setHosting(cur.value.current.hosting.mode);
    // Seed the custom editor from whatever is in force, so switching to
    // "custom" starts from today's plan rather than resetting someone to free.
    setCaps(cur.value.current.throughput.caps);
    setQuote(cur.value.current);
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Live quoting. Every change re-asks the server, debounced so dragging a
   * number field doesn't fire a request per keystroke, and sequenced so a slow
   * earlier response can't overwrite a newer one — which would show a price
   * that belongs to a selection no longer on screen.
   */
  useEffect(() => {
    if (absent || !caps || !current) return;
    let live = true;
    const timer = setTimeout(async () => {
      setQuoting(true);
      try {
        const q = await http.post<FullQuote>(`/api/guilds/${guildId}/billing/quote`, {
          rateLimitTier: tier,
          hostingMode: hosting,
          ...(tier === "custom" ? { customCaps: caps } : {}),
        });
        if (live) setQuote(q);
      } catch (e) {
        if (live) setError(describe(e, "Couldn't price that selection."));
      } finally {
        if (live) setQuoting(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [guildId, tier, hosting, caps, absent, current]);

  if (absent) {
    const mode = deployment?.mode;
    return (
      <div className="stack">
        <header className="page-head">
          <h1>Billing</h1>
        </header>
        <Banner level="watch" title="This deployment doesn't have billing">
          {mode === "self"
            ? "This is a self-hosted install. There's no billing account behind it and no plan to change — the limits below come from the operator's configuration, not a price list."
            : mode === "test"
              ? "This is a test deployment. Tiers and limits behave exactly as they do on the hosted platform, but no payment provider is configured, so there's nothing to buy here."
              : "The billing routes aren't available on this deployment. Nothing is wrong with your server — this install simply doesn't sell plans."}
        </Banner>
      </div>
    );
  }

  if (fatal) return <Banner level="act" title="Couldn't load billing">{fatal}</Banner>;
  if (!current || !presets || !caps) return <Loading rows={6} />;

  const changed =
    tier !== current.current.throughput.tier || hosting !== current.current.hosting.mode;

  const isFreeSelection = quote !== null && quote.totalUsdCentsPerYear === 0;
  const alreadyFree =
    current.current.throughput.tier === "free" && current.current.hosting.mode === "shared";

  function setCap(key: keyof Caps, raw: string) {
    const n = Number.parseInt(raw, 10);
    setCaps((prev) => (prev ? { ...prev, [key]: Number.isFinite(n) ? Math.max(0, n) : 0 } : prev));
  }

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const res = await http.post<{ checkoutUrl: string }>(`${base}/checkout`, {
        rateLimitTier: tier,
        hostingMode: hosting,
        ...(tier === "custom" ? { customCaps: caps } : {}),
      });
      // The plan does not change here — the Tebex webhook applies it once the
      // payment actually clears. Leaving the console is expected.
      window.location.href = res.checkoutUrl;
    } catch (e) {
      setError(describe(e, "Couldn't start checkout."));
      setBusy(false);
    }
  }

  async function downgrade() {
    setBusy(true);
    setError(null);
    try {
      // This route answers { quote, customBillingRenewsAt } — a different
      // shape from GET /billing's { current, ... }, so it's reshaped here
      // rather than assumed to match.
      const res = await http.put<{ quote: FullQuote; customBillingRenewsAt: string | null }>(
        `${base}/downgrade-to-free`,
        {},
      );
      setCurrent({ current: res.quote, customBillingRenewsAt: res.customBillingRenewsAt });
      setTier(res.quote.throughput.tier);
      setHosting(res.quote.hosting.mode);
      setCaps(res.quote.throughput.caps);
      setQuote(res.quote);
    } catch (e) {
      setError(describe(e, "Couldn't downgrade."));
    } finally {
      setBusy(false);
      setConfirmDowngrade(false);
    }
  }

  const freeCaps = presets.presets.free.caps;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Plan &amp; limits</h1>
        <p className="dim">
          Two things are priced, independently: how much throughput this server gets,
          and whether it runs on the shared bot or a dedicated one. Everything is
          billed once a year.
        </p>
      </header>

      {deployment?.mode === "test" && (
        <Banner level="watch" title="Test deployment">
          Tiers and limits behave exactly as on the hosted platform, but checkout may
          not complete — no real payment provider is attached.
        </Banner>
      )}

      {error && <Banner level="act" title="That didn't go through">{error}</Banner>}

      <Panel
        title="Current plan"
        action={<Pill level={alreadyFree ? undefined : "ok"}>{TIER_LABELS[current.current.throughput.tier]}</Pill>}
      >
        <div className="grid grid-3">
          <Stat
            label="Throughput"
            value={TIER_LABELS[current.current.throughput.tier]}
            sub={`${usd(current.current.throughput.price.annualUsdCents)} per year`}
          />
          <Stat
            label="Hosting"
            value={current.current.hosting.mode === "custom" ? "Dedicated bot" : "Shared bot"}
            sub={
              current.current.hosting.price
                ? `${usd(current.current.hosting.price.annualUsdCents)} per year`
                : "Included"
            }
          />
          <Stat
            label="Billed"
            value={usd(current.current.totalUsdCentsPerYear)}
            sub={
              current.customBillingRenewsAt
                ? `Renews ${new Date(current.customBillingRenewsAt).toLocaleDateString()}`
                : "Annually"
            }
          />
        </div>

        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Now</th>
              <th>Free tier</th>
            </tr>
          </thead>
          <tbody>
            {CAP_ORDER.map((key) => (
              <tr key={key}>
                <td>{CAP_LABELS[key]}</td>
                <td className="mono">{current.current.throughput.caps[key].toLocaleString()}</td>
                <td className="mono dim">{freeCaps[key].toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <DedicatedBotPanel guildId={guildId} />

      <Panel title="Change plan">
        <label className="field">
          <span className="eyebrow">Throughput</span>
          <select value={tier} onChange={(e) => setTier(e.target.value as RateLimitTier)}>
            {(["free", "tier1", "tier2"] as const).map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]} — {usd(presets.presets[t].priceUsdCentsPerYear)}/year
              </option>
            ))}
            <option value="custom">{TIER_LABELS.custom} — priced per limit</option>
          </select>
        </label>

        <label className="field">
          <span className="eyebrow">Hosting</span>
          <select value={hosting} onChange={(e) => setHosting(e.target.value as HostingMode)}>
            <option value="shared">Shared bot — included</option>
            <option value="custom">
              Dedicated bot — {usd(presets.customBotHosting.annualUsdCents)}/year
            </option>
          </select>
          <span className="dim">
            A dedicated instance of the open-source bot, under your own application and
            avatar. Unrelated to throughput — the two are priced and charged separately,
            with no bundle.
          </span>
        </label>

        {tier === "custom" && (
          <>
            <span className="eyebrow" style={{ marginTop: 8 }}>
              Custom limits — you pay for what's above the free tier
            </span>
            <table className="table">
              <thead>
                <tr>
                  <th>Limit</th>
                  <th>Wanted</th>
                  <th>Free</th>
                  <th>Max</th>
                  <th>Cost / year</th>
                </tr>
              </thead>
              <tbody>
                {CAP_ORDER.map((key) => {
                  const line = quote?.throughput.customQuote?.lines.find((l) => l.cap === key);
                  const capError = quote?.errors.find((x) => x.cap === key);
                  return (
                    <tr key={key}>
                      <td>{CAP_LABELS[key]}</td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={presets.customCapMaximums[key]}
                          step={1}
                          value={caps[key]}
                          style={{ width: 110 }}
                          aria-label={CAP_LABELS[key]}
                          onChange={(e) => setCap(key, e.target.value)}
                        />
                      </td>
                      <td className="mono dim">{freeCaps[key].toLocaleString()}</td>
                      <td className="mono dim">{presets.customCapMaximums[key].toLocaleString()}</td>
                      <td className="mono">
                        {capError ? (
                          // The API's own refusal, per field, rather than a
                          // guess at which field is the problem.
                          <span style={{ color: "var(--act)" }}>
                            over the {capError.maximum.toLocaleString()} ceiling
                          </span>
                        ) : line ? (
                          usd(line.lineTotalUsdCents)
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <span className="dim" style={{ fontSize: 12 }}>
              There is no unlimited tier. Every limit has a hard ceiling, including
              custom ones — an unbounded cap makes worst-case cost impossible to reason
              about and abuse free to attempt.
            </span>
          </>
        )}
      </Panel>

      <Panel
        title="What this costs"
        action={quoting ? <Pill live>pricing…</Pill> : undefined}
      >
        {!quote ? (
          <Loading rows={2} />
        ) : (
          <>
            <div className="grid grid-3">
              <Stat
                label="Total per year"
                value={usd(quote.totalUsdCentsPerYear)}
                sub={isFreeSelection ? "Nothing to pay" : "One charge, once a year"}
              />
              <Stat
                label="Throughput"
                value={usd(quote.throughput.price.annualUsdCents)}
                sub={TIER_LABELS[quote.throughput.tier]}
              />
              <Stat
                label="Hosting"
                value={usd(quote.hosting.price?.annualUsdCents ?? 0)}
                sub={quote.hosting.mode === "custom" ? "Dedicated bot" : "Shared — included"}
              />
            </div>

            {/* Comparison only. Deliberately not a Stat, not next to the
                button, and not phrased as a rate you could choose: there is no
                monthly plan and never will be. */}
            <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
              For comparison when shopping around, {usd(quote.totalUsdCentsPerYear)} a year
              works out at {usd(quote.totalMonthlyEquivalentUsdCents)} a month. Monthly
              billing isn't offered: per-transaction card fees would take roughly three
              times as much of it, which buys neither of us anything.
            </p>

            {!quote.valid && (
              <Banner level="act" title="Some limits are above their ceiling">
                {quote.errors
                  .map(
                    (x) =>
                      `${CAP_LABELS[x.cap]}: asked for ${x.requested.toLocaleString()}, max is ${x.maximum.toLocaleString()}`,
                  )
                  .join(" · ")}
              </Banner>
            )}

            {quote.belowMinimumCharge && (
              <Banner level="watch" title="Below the minimum charge">
                This selection comes to {usd(quote.totalUsdCentsPerYear)}, under the{" "}
                {usd(presets.minimumChargeUsdCents)} minimum a card charge is worth firing.
                Checkout will refuse it — raise the limits, or pick a preset tier.
              </Banner>
            )}

            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                onClick={() => void checkout()}
                // Left clickable when the quote is below the minimum on
                // purpose: the API's refusal names the exact figure and the
                // way out, and that is a better sentence than any disabled
                // button can show.
                disabled={busy || quoting || isFreeSelection || !quote.valid}
              >
                {busy ? "Opening checkout…" : "Continue to checkout"}
              </button>
              <span className="dim" style={{ fontSize: 12 }}>
                {isFreeSelection
                  ? "This selection is free — there's nothing to check out."
                  : changed
                    ? "You'll be sent to the payment page. Your plan changes only once the payment clears."
                    : "This is your current plan. Checking out renews it."}
              </span>
            </div>
          </>
        )}
      </Panel>

      <Panel title="Downgrade to free">
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>
          Drops throughput to the free tier and moves back to the shared bot. It applies
          immediately, with no refund for time remaining, and applications past{" "}
          {freeCaps.submissionsPerDay.toLocaleString()} a day will be turned away from
          that moment on.
        </p>
        <div className="actions" style={{ marginTop: 10 }}>
          {alreadyFree ? (
            <span className="dim" style={{ fontSize: 12 }}>
              Already on the free plan with shared hosting.
            </span>
          ) : confirmDowngrade ? (
            <>
              <button className="btn btn-danger" onClick={() => void downgrade()} disabled={busy}>
                {busy ? "Downgrading…" : "Yes, downgrade now"}
              </button>
              <button className="btn" onClick={() => setConfirmDowngrade(false)} disabled={busy}>
                Cancel
              </button>
              <span className="dim" style={{ fontSize: 12 }}>
                {current.customBillingRenewsAt
                  ? `You've paid through ${new Date(current.customBillingRenewsAt).toLocaleDateString()}; that time is not refunded.`
                  : "This can't be undone without paying again."}
              </span>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirmDowngrade(true)}>
              Downgrade to free
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}
