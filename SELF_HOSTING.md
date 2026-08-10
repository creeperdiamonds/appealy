# Running this yourself

`.env.example` ships with `DEPLOYMENT_MODE=self`. Leave it. Billing is off, no
Stripe account is needed, and caps come from the `CAP_*` values.

```bash
cp .env.example .env
# fill: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY,
#       DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET,
#       TOKEN_ENCRYPTION_KEY, OPS_USER_IDS
docker compose up
deno task sync-commands      # once, and after changing commands
```

No Stripe key needed. That was the blocker — `STRIPE_SECRET_KEY` was
unconditionally required, so a clone of an open-source project crashed on
startup asking for a payment processor.

| | `platform` | `self` |
|---|---|---|
| Stripe / billing | required | off, keys unread |
| Rate limits | tier from `pricing.ts` | flat `CAP_*` |
| Appeal link in ban notice | dashboard | `SUPPORT_URL`, or omitted |
| Public status page | on | off |
| Telemetry | none | none |

## Three decisions

**The template pins `self`; the inference is the fallback.** An explicit
`DEPLOYMENT_MODE` always wins. Blank it and the mode is inferred — a Stripe key
means `platform`, no Stripe key means `self`.

Pinned rather than left blank because `.env.example` is a file everybody
copies. Inference is right for a deployment someone deliberately configured and
wrong for a shared template: a stray Stripe key in a cloned `.env` would
silently promote a self-hosted instance into platform mode and switch on
billing routes nobody asked for. An explicit value can't be surprised into
changing.

A plain default was worse in both directions. Defaulting to `platform` crashed
a fresh clone on a missing Stripe key — a terrible first five minutes with an
open-source project. Defaulting to `self` silently downgraded the hosted
deployment whenever someone forgot the flag: billing routes gone, every guild
on flat caps, and nothing to notice until a customer asked why they couldn't
upgrade.

Stripe keys are the honest signal. Nobody sets one by accident, and nobody
running this for their own server has one. The inference is logged every
startup — a mode nobody chose and nobody can see is how you lose an afternoon
to the wrong bug.

The check is on shape, not presence, because "non-empty" turned out to be a bad
proxy for "configured":

| In `.env` | Result |
|---|---|
| blank | `self` |
| `your_stripe_key_here` | `self`, and says the placeholder was ignored |
| `pk_live_…` (publishable key) | `self`, and points at the right key |
| `sk_test_…` | `platform`, warns that no real charges happen |
| `sk_live_…` without webhook secret | **refuses to start** |
| `sk_live_…` + `whsec_…` | `platform` |

The refusal is the important one. Live keys with no verifiable webhook means
customers can pay and never receive what they paid for, with nothing in the
logs to say so. Failing at boot is much cheaper than finding out from a refund
request.

**Caps still exist.** No longer a price ladder, but they still protect your
Postgres pool — `max: 10`, and a runaway loop takes the gateway with it.
Defaults are roughly tier2. Raise them; it's your hardware.

**Empty `SUPPORT_URL` omits the appeal line** rather than falling back to the
upstream dashboard. Sending your users to someone else's support queue is worse
than offering no appeal.

## No telemetry

Asserted as `TELEMETRY_ENABLED = false` in `shared/config/deployment.ts` rather
than promised in prose, so it shows in a diff if it ever changes.

## Not handled

Sharding beyond one process; automatic migrations on upgrade; backups.
