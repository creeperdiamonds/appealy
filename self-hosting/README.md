# Self-hosting

Run the whole thing on your own hardware for nothing. Billing off, no merchant account, caps yours to raise, and no telemetry — asserted in code rather than promised in prose.

## Start it

```
cp .env.example .env
# fill: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY,
#       DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET,
#       TOKEN_ENCRYPTION_KEY, OPS_USER_IDS

docker compose up
cd bot && deno task sync-commands   # once, and after changing commands
```

Then open **`http://localhost:5173/dashboard/`**. One container serves all three surfaces, split by path:

| URL | Is |
| --- | --- |
| `/` | The marketing site |
| `/dashboard/` | The console — where you log in |
| `/status/` | The shard status page |
| `/auth/`, `/api/` | Proxied straight through to the API |

`.env.example` ships with the deployment mode pinned to **self**. Leave it. Billing is off, no payment account is needed, and caps come from the flat values in your own environment. That was the blocker worth fixing: the payment credentials used to be unconditionally required, so a clone of an open-source project crashed on startup asking for a merchant account.

## The one mistake that breaks login

It is worth reading this section before you put the stack behind a domain, because the failure is silent and does not look like what it is.

The session is an httpOnly cookie marked `SameSite=Lax`. A Lax cookie is attached to a cross-origin request only when that request is same-**site**, and “site” means the registrable domain, not the origin. Serve the console on one hostname and the API on another and the browser simply never sends the cookie: **login appears to succeed and every request after it is anonymous.**

> **CORS does not fix this and never could.** CORS decides whether a response may be *read*. `SameSite` decides whether the cookie is *attached* in the first place. Getting CORS right and the cookie wrong produces a clean 200 on the preflight followed by a 401 on the real request, which reads as a session bug rather than a cookie-scoping one — and sends you looking in exactly the wrong file.

So the console’s nginx proxies `/auth/` and `/api/` from its own origin, the browser only ever talks to one host, and the cookie is first-party by construction. Two consequences for your configuration:

-   **`VITE_API_URL` stays empty.** It is baked into the bundle at build time. Pointing it at an absolute URL puts the console and the API back on separate origins and reintroduces the bug.
-   **The redirect URI is the console’s URL**, never the API’s. It defaults to `http://localhost:5173/auth/discord/callback` — port 5173. Port 3001 is published so you can call the API with `curl`; no browser should ever be pointed at it.

Behind a real domain, the whole set moves together, and all three name the console:

```
DISCORD_REDIRECT_URI=https://appeals.example.com/auth/discord/callback
FRONTEND_ORIGIN=https://appeals.example.com
DASHBOARD_BASE_URL=https://appeals.example.com
```

Paste that redirect URI into the Developer Portal under **OAuth2 → Redirects** character for character, and note that it has to be HTTPS — Discord rejects plain HTTP on anything that is not `localhost`.

> **Local development hides the entire problem.** `localhost:5173` and `localhost:3001` differ only by port, and ports are not part of a site — so the cookie flows, everything works, and it keeps working right up until the day it is deployed. That is why this is written down here rather than left to be discovered.

## What changes between the two modes

|  | Hosted | Self-hosted |
| --- | --- | --- |
| Billing | Required | Off, credentials unread |
| Rate limits | Tier from the price list | Flat, from your own environment |
| Appeal link in a ban notice | The dashboard | Your support URL, or omitted |
| Public status page | On | Off |
| Telemetry | None | None |

An explicit mode always wins; blank it and the mode is inferred from whether payment credentials are present. The template pins *self* rather than leaving it blank because `.env.example` is a file everybody copies, and stray credentials in a cloned environment would otherwise promote a self-hosted instance into hosted mode and switch on billing routes nobody asked for. An explicit value cannot be surprised into changing.

Placeholders count as blank, because “non-empty” turned out to be a bad proxy for “configured”: a leftover `your_key_here` is ignored, and the log says it was ignored rather than failing mysteriously later.

One combination refuses to start: real payment credentials with no webhook secret. That pairing means checkout succeeds, the customer is charged, and no plan ever activates, with nothing in the logs to say so. Failing at boot is much cheaper than finding out from a refund request.

## Caps are still there, and they are yours

Not a price ladder any more, but they still protect your database — the connection pool is small on purpose, and a runaway loop takes the gateway down with it. The defaults are roughly the middle paid tier. Raise them: **it is your hardware.**

They are still finite, though. Infinity is rejected at startup, because “as high as this was designed to go” is a real answer and an invented number is not.

## No telemetry

Asserted as a constant in `shared/config/deployment.ts` rather than promised in prose, so it shows up in a diff if it ever changes. Nothing here counts installs, users or servers, and there is nothing to opt out of.

## Not handled

Stated plainly rather than left to be discovered: sharding beyond a single process, automatic migrations on upgrade, and backups. If you are running this for a community that would notice losing its application history, the third one is yours to solve.

---

The full version of this page, with the environment variable names and the reasoning behind each decision, is [SELF\_HOSTING.md](https://github.com/creeperdiamonds/appealy/blob/main/SELF_HOSTING.md) in the repository. For a Raspberry Pi specifically, see [PI.md](https://github.com/creeperdiamonds/appealy/blob/main/PI.md).
