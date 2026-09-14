# Getting started

Invite the bot, build a form, publish a panel. Most of it happens in the dashboard; three things cannot, and they are the three that cause the “it installed but nothing happens” support ticket.

## 1. Add the bot

The **Add to Discord** button on this site is a redirect the API builds from its own client id, so it always invites the deployment you are actually looking at. It carries no server id, which is why Discord shows you the picker rather than assuming.

The invite requests nine permissions. They are the set the features need, and every one of them is load-bearing somewhere: manage roles to grant what an accept grants, ban members to lift a ban when an appeal succeeds, manage channels for ticket panels. An invite missing one produces a feature that silently does nothing, which is the failure the dashboard’s invite flow exists to prevent.

## 2. Turn on the intents — including the moderation one

Only relevant if you are running your own instance; on the hosted deployment these are already on. In the [Discord Developer Portal](https://discord.com/developers/applications), under **Bot**:

-   **Server Members Intent** — without it the welcomer, the verification gate and the auto-kick timer never see anyone join.
-   **Message Content Intent**
-   **Server Moderation** — this is the one people miss. Ban appeals are driven by the `guildBanAdd` gateway event, and Discord does not send it until the portal agrees. The code is complete either way, so the symptom is a ban appeal system that is configured, enabled, and silent.

## 3. Register the slash commands

Once per deployment, and again after changing a command:

```
cd bot && deno task sync-commands
```

This is deliberately a deploy step rather than something that happens on boot. Discord allows **200 global command creates per day per application**, and a bot that registers on every start spends that budget on crash loops — at which point it cannot start at all until the window resets, which is a far worse outage than whatever caused the loop.

## 4. Build a form

Open [the dashboard](https://appealy.app/dashboard/) and pick your server. A form is a list of questions plus what happens when one is accepted: which roles are granted, which are removed, what the applicant is sent, and where it is logged.

Two things worth setting up front:

-   **Cooldowns and limits.** A form with neither is a form one person can submit forty times. `/reset-cooldown` exists for when you want to let a specific person retry.
-   **Answer validation.** Questions can require a minimum and maximum length, and optionally a regular expression — `^[A-Za-z0-9_]{3,16}$` for a Minecraft username, say. It is enforced at both submission points, the in-server modal and the DM flow, through the same shared code so the two cannot drift apart.

## 5. Publish a panel

A panel is the message with the button on it. `/panel` creates and publishes one; the dashboard manages them. This is the step that makes a form reachable — a form with no panel exists and nobody can find it.

Applicants can also use `/apply`, and `/forms` lists what is available in the server.

## The commands

Seventeen, and this is all of them:

| Command | Does |
| --- | --- |
| `/apply` | Apply for an application form in this server |
| `/forms` | List all application forms configured in this server |
| `/panel` | Manage application panels |
| `/ticket-panel` | Manage ticket panels |
| `/role-menu` | Manage self-assignable role menus |
| `/verify-setup` | Configure and publish server verification |
| `/anti-raid` | Configure join-velocity raid detection |
| `/giveaway` | Manage giveaways |
| `/poll` | Create and publish a poll |
| `/reset-cooldown` | Clear one user’s cooldown or limit for one application form |
| `/dashboard` | Get a link to the web dashboard for this server |
| `/botstats` | Show bot health and usage stats |
| `/ping` | Check the bot’s latency |
| `/export_applications` | Export submitted applications to a CSV file |
| `/export` | Export all of this server’s Appealy data as a JSON file (owner only) |
| `/import-appealy` | Import another server’s Appealy setup from an `/export` file |
| `/import-appy` | Import Appy application submissions into an Appealy form (owner only) |

> **`/export` is not a formality.** It writes every form, panel, submission and answer this server has as one JSON file, and `/import-appealy` reads it back. Leaving is a supported operation rather than something you negotiate with support — which is the point of it existing before you need it.

## Signing in

The dashboard signs you in through Discord in a popup rather than by navigating the page away, so the console keeps its state instead of being torn down and rebuilt around a redirect. If the popup is blocked — no user gesture, or Discord’s own in-app browser, which does not give a popup an opener to talk back through — it falls back to a full-page redirect on its own.

Nothing sensitive crosses that boundary. The session is an httpOnly cookie the browser holds and no script can read; the message the popup posts back carries only whether it worked.

---

Next: [Ban appeals](ban-appeals.md), or [Review outcomes](outcomes.md) if you are setting up a staff application with more than one possible yes.
