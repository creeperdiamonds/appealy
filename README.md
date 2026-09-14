# Documentation

Four documents, written from the code rather than around it. Each one says what Appealy actually does, and where the reasoning behind it lives.

-   **[Getting started](getting-started/README.md)** — Invite the bot, build a form, publish a panel. The three things that have to happen outside the dashboard, and the seventeen slash commands.
-   **[Ban appeals](getting-started/ban-appeals.md)** — The feature the product is named after — and the three separate things called an appeal: a server’s own, and ours against an account or a server.
-   **[Review outcomes](getting-started/outcomes.md)** — “Accept, as Trainee” rather than one Accept button — and the two guards that stop a review form becoming a privilege-escalation path.
-   **[Self-hosting](self-hosting/README.md)** — Run the whole thing on your own hardware for nothing. Billing off, caps yours, no telemetry, and the one configuration mistake that breaks login.

## How these are written

Every page here cites the file it is describing. That is not decoration: it is the only way a document like this stays true. A claim with a filename beside it can be checked in ten seconds by anyone reading the repository, and it fails loudly when the code moves. A claim without one quietly rots.

Where something is unfinished, these pages say so rather than describing the intended version. Denial outcomes do not exist yet; the history purge ships disabled; there is no ban-creation UI. Those are all stated on the page that would otherwise imply otherwise.

> **Nothing here is a promise about a future release.** If a feature is described in the present tense on this site, it is in `main` today. The roadmap lives in the repository's issues, where it can be argued with.

## What is deliberately not here

The repository carries a second class of document — engineering notes written for whoever is changing the code, not for whoever is running it. Those stay in the repository, because putting them on a public site would present internal working notes as product documentation:

| In the repository | Is |
| --- | --- |
| [SCALING.md](https://github.com/creeperdiamonds/appealy/blob/main/SCALING.md) | A scaling audit against the real code — what breaks first, and why it is the Postgres pool rather than the dashboard |
| [STARTUP.md](https://github.com/creeperdiamonds/appealy/blob/main/STARTUP.md) | Why command registration is a deploy step and not a boot step, and the Discord rate limit that decides it |
| [DOCKER.md](https://github.com/creeperdiamonds/appealy/blob/main/DOCKER.md) | Container and Cloud Run specifics: the port, the proxy, the domain mapping |
| [SETUP.md](https://github.com/creeperdiamonds/appealy/blob/main/SETUP.md) | The operator checklist for the hosted deployment — migrations, caps, sharding, billing |
| [PI.md](https://github.com/creeperdiamonds/appealy/blob/main/PI.md) | Running the stack on a Raspberry Pi, including the parts that are about power supplies rather than software |

---

Something on these pages wrong, or missing? [Open an issue](https://github.com/creeperdiamonds/appealy/issues) — a documentation bug is a bug.
