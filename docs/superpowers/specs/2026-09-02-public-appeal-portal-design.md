# Public appeal portal — design

**Date:** 2026-09-02
**Status:** approved, not implemented

## The problem

A guild ban appeal can only reach the banned person one way: a DM, sent once,
at the moment of the ban. `bot/src/events/guildBanAdd.ts` does it, appeal forms
are forced to `applicationType: "direct_message"`, and the handler's own comment
calls delivery *"best-effort by design"*.

Three groups therefore cannot appeal at all, and none of them can tell anyone,
because they are banned:

- **DMs closed.** Common, and disproportionately common among people who get
  banned.
- **Banned before the bot was installed.** They never received a DM and never
  will. For a server adopting Appealy, this is its entire existing ban list.
- **The DM failed.** No retry, no fallback, no second path.

Appeal.gg's whole mechanic is the missing piece: a public URL, opened in a
browser, with no dependency on DMs, shared servers, or when the ban happened.
Overlapping it is not a marketing exercise; the hole is real.

## What is being built

A public web page where a banned member proves who they are with Discord,
Appealy confirms they are actually banned in that server, and they submit the
server's existing appeal form. The submission lands in the same review queue,
as the same `submissions` row, reviewed by the same staff UI. Nothing about
review changes.

## Decisions

### The URL mirrors the Discord invite, but does not depend on it

`/appeal/<code>`, where `<code>` is seeded from the server's Discord invite so
that `appealy.creeperdiamonds.xyz/appeal/abc123` matches the
`discord.gg/abc123` people already have. That familiarity is the point — it is
a link a moderator can paste into a ban reason without explaining it.

**It is resolved once and stored**, as `appealConfigs.publicCode → guildId`.
It is NOT looked up live against Discord.

This is the difference between a feature and a trap. Invite codes expire and
get regenerated. A live lookup means that rotating an invite silently kills
every appeal link ever posted — and the only people who would notice are
banned and have no way to report it. Storing the mapping keeps the familiar
URL and removes the dependency that would break it.

Consequences to handle:

- `publicCode` is unique across all guilds and must be checked at write time.
- Two servers cannot claim the same code; first writer wins, with a clear error.
- A code is just an opaque string after setup. If the owner regenerates their
  Discord invite, the appeal link keeps working, and that is correct.

### Identity: Discord OAuth, then a real ban check

The visitor logs in with Discord. The API then asks the bot whether that user
id is banned in that guild, and only then renders the form.

Nothing in the codebase queries a guild ban list today — `getBans`/`getBan`
appear nowhere — so this is a new bot control-server endpoint,
`GET /internal/guilds/:guildId/bans/:userId`, reached through the existing
`botBridge` (which already runs API→bot).

Without the ban check the page is an open contact form that any member of the
server can flood, and every appeal in the queue becomes untrustworthy. With it,
an appeal in the queue is a fact: this person is banned, and this is them.

### When the ban cannot be confirmed, refuse

The bot may be offline, the `GuildModeration` intent may be off (`SETUP.md`
lists enabling it as a manual portal step), or the bot may lack permission.

In all of those cases: **no form, no submission**, and a message saying this
server has not finished configuring appeals — phrased so it does not read as
the visitor's fault, because it is not. Logged loudly so the admin discovers it.

This deliberately differs from `bot/src/core/banGate.ts`, which fails OPEN when
it cannot answer. That precedent is correct for what it guards: a ban gate
failing open briefly lets someone use a bot. This failing open would let
strangers into a staff review queue, and a queue that cannot be trusted is
worse than a queue that is temporarily empty.

The cost is real and accepted: while an admin's configuration is broken, people
with genuine appeals are turned away. The mitigation is that they are told why,
and the admin is told loudly.

## Architecture

```
banned member
   │  GET /appeal/<code>
   ▼
public page ──── OAuth ────► existing /auth flow (session, no guild access needed)
   │
   │  GET /api/appeal/<code>        → guild + form questions ONLY
   │  POST /api/appeal/<code>       → submit
   ▼
api ──── botBridge ────► bot  GET /internal/guilds/:id/bans/:userId
   │                            (new; Discord REST getBan)
   ▼
submissions row (kind: appeal) ──► existing review queue, unchanged
```

### Data model

`appealConfigs` gains:

| Column | Why |
|---|---|
| `publicCode` | The URL segment. Unique across guilds, nullable — a guild that never sets one up has no public page. |
| `publicEnabled` | Off by default. Publishing a public endpoint for a server is the owner's decision, not a side effect of upgrading. |

A partial unique index on `publicCode WHERE public_code IS NOT NULL`, matching
the shape already used by `platform_bans_active_uniq`.

### What the public read endpoint may return

Only what is needed to render a form: the guild's name and icon, the form's
title and its questions. Explicitly **not** reviewer roles, log channel ids,
outcome definitions, staff configuration, or any internal id beyond the
question ids needed to submit answers. This endpoint is readable by anyone with
a link, so its response shape is a security boundary, not a convenience.

### Abuse control reuses what exists

- **One open appeal per person** is already expressible: `forms.allowMultiplePending`
  plus the pending-count check `evaluateGate` performs on the panel path. The
  public route runs the same check rather than inventing a second rule.
- **Rate limiting** goes through the existing `apiRateLimit.ts` middleware.
- **`submissionsPerDay`** applies. An appeal is a submission and costs the guild
  one, exactly as a DM appeal does today.

## Out of scope

- Changing anything about how appeals are reviewed.
- Removing the DM path. Both exist; the DM is still the fastest route for
  someone whose DMs are open, and this is the fallback for everyone else.
- Custom domains per guild.
- Appeals for mutes or warnings. Discord has no API for either, and Appeal.gg
  handles them because it tracks its own punishments rather than Discord's.

## The claim this lets the site make

That anyone banned from a server running Appealy can appeal, whether or not
their DMs are open and whether or not they were banned before the bot arrived.
That is not currently true, which is why it is not currently written anywhere.
