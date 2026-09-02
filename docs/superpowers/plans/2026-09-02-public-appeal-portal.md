# Public Appeal Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A banned member signs in at Appealy, sees the servers that banned them, and appeals — without needing a DM, a shared server, or a link anyone remembered to send.

**Architecture:** Guild bans are recorded locally as they happen so the "who banned you" list is one indexed query rather than a REST fan-out. The API confirms each ban against Discord through the bot's existing control server before rendering a form, and refuses when it cannot confirm. Submissions become ordinary `submissions` rows, so the review side is untouched.

**Tech Stack:** TypeScript · Deno (bot) · Node + Express (api) · React (web) · Drizzle ORM · Discordeno v20 · `deno test` with `https://deno.land/std@0.224.0/assert/mod.ts`

**Spec:** `docs/superpowers/specs/2026-09-02-public-appeal-portal-design.md`

## Global Constraints

- **Refuse when the ban cannot be confirmed.** Bot offline, `GuildModeration` intent off, missing permission — all mean no form and no submission, with a message that does not blame the visitor, and a loud log. This deliberately differs from `bot/src/core/banGate.ts`, which fails open. Never copy that precedent here.
- **The public read endpoint is a security boundary.** It may return the guild's name and icon, the form's title, and its questions. Never reviewer roles, log channel ids, outcome definitions, staff configuration, or any internal id beyond the question ids needed to submit.
- **`publicCode` is stored, never resolved live against Discord.** Invite codes rotate; a live lookup would silently kill every appeal link ever posted, noticed by nobody because the affected people are banned.
- **Do not change the review side.** An appeal submitted here is a `submissions` row like any other.
- **Testable logic goes in `shared/`.** The API has no test runner — no test script and no test devDependencies — so any decision worth a test must be a pure function under `shared/`, covered by `deno test`.
- Tests run **from the repository root**. Shared: `deno test --allow-read -c bot/deno.json shared/`. Bot: `deno test --allow-read -c bot/deno.json bot/src/`. Bot type-check needs `-c bot/deno.json` or the import map is missing.
- API type-check: `cd api && npx tsc --noEmit -p tsconfig.json` must exit 0. **Never** install with `--omit=optional` — it strips TypeScript's platform-specific compiler binary.
- Migrations: run `cd api && npx drizzle-kit generate`. **Do not hardcode a migration number** — use whatever it produces.
- Converted interaction handlers use `defer()`/`finish()` and never call `sendInteractionResponse` directly; `bot/src/interactions/__tests__/deferGuard.test.ts` enforces this and must stay green.
- House style is comments that explain *why*, often at length.
- Commit after every task.

---

### Task 1: Schema and migration

Both schema changes land together because they share one generated migration, and a half-applied schema is worse than either half.

**Files:**
- Modify: `shared/schema/schema.ts` (add `guildBans`, extend `appealConfigs`)
- Create: the next migration in `db/migrations/` (generated)

**Interfaces:**
- Produces: `schema.guildBans` with columns `guildId`, `userId`, `bannedAt`, `reason`; `schema.appealConfigs.publicCode` and `.publicEnabled`.

- [ ] **Step 1: Add the `guildBans` table**

In `shared/schema/schema.ts`, after the `appealConfigs` table:

```ts
/**
 * Guild bans, as Discord reports them.
 *
 * Written by guildBanAdd, deleted by guildBanRemove. This exists so the
 * "which servers banned you" list on the appeal site is one indexed query
 * instead of one Discord REST call per guild the bot is in, per page load —
 * which does not work at ten guilds and is absurd at ten thousand.
 *
 * NOT the source of truth. It is an index. Every appeal still re-confirms the
 * ban against Discord before a form is shown, because this table can be stale
 * (an unban while the bot was offline delivers no event) and a stale row must
 * never be enough to open a staff review queue.
 *
 * Only knows bans that happened while the bot was present. Somebody banned
 * before the server installed Appealy will never appear here, which is why
 * the direct /appeal/<code> link is not dropped.
 */
export const guildBans = pgTable(
  "guild_bans",
  {
    guildId: bigint("guild_id", { mode: "bigint" })
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" }).notNull(),
    bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
    // Discord's ban reason, when the audit log gave us one. Never shown to the
    // banned person by default — a moderator's private note about somebody is
    // not automatically that person's to read.
    reason: text("reason"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.guildId, t.userId] }),
    // The list query: "which guilds banned me".
    userIdx: index("guild_ban_user_idx").on(t.userId),
  }),
);
```

- [ ] **Step 2: Extend `appealConfigs`**

In the same file, inside the `appealConfigs` table definition, after `dmOnBanEnabled`:

```ts
  /**
   * The URL segment for this guild's public appeal page: /appeal/<publicCode>.
   *
   * Seeded from the server's Discord invite so the link matches the
   * discord.gg/<code> people already have — that familiarity is the point,
   * because it is a link a moderator pastes into a ban reason.
   *
   * STORED, never resolved live against Discord. Invite codes expire and get
   * regenerated; a live lookup would mean rotating an invite silently killed
   * every appeal link ever posted, and the only people who would notice are
   * banned and cannot report it. After setup this is just an opaque string.
   */
  publicCode: text("public_code"),
  /**
   * Off by default. Publishing a public endpoint on behalf of a server is the
   * owner's decision, never a side effect of setting something else up.
   */
  publicEnabled: boolean("public_enabled").notNull().default(false),
```

And in the table's index callback (add one if `appealConfigs` has none, converting the object form to `(t) => ({ ... })`):

```ts
    // Partial, so the many guilds with no public page are exempt rather than
    // colliding on NULL. Same shape as platform_bans_active_uniq.
    publicCodeUniq: uniqueIndex("appeal_config_public_code_uniq")
      .on(t.publicCode).where(sql`public_code is not null`),
```

- [ ] **Step 3: Generate the migration**

Run: `cd api && npx drizzle-kit generate`
Expected: a new `db/migrations/00NN_*.sql`. Read it and confirm it contains `CREATE TABLE "guild_bans"`, two `ALTER TABLE "appeal_configs" ADD COLUMN`, and the partial index **with** its `WHERE public_code is not null` clause — drizzle's `.where()` on indexes has been inconsistent across versions, which is why `SETUP.md` records checking it every time.

- [ ] **Step 4: Confirm nothing destructive**

Run: `grep -icE "drop (table|column)|truncate" db/migrations/00NN_*.sql`
Expected: `0`. The deploy workflow refuses destructive migrations unless explicitly allowed.

- [ ] **Step 5: Type-check both runtimes**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add shared/schema/schema.ts db/migrations
git commit -m "Record guild bans, and give a guild a public appeal code"
```

---

### Task 2: Record bans as they happen

**Files:**
- Modify: `bot/src/events/guildBanAdd.ts`
- Create: `bot/src/events/guildBanRemove.ts`
- Modify: `bot/src/events/index.ts`

**Interfaces:**
- Consumes: `schema.guildBans` (Task 1).
- Produces: `onGuildBanRemove(bot): (user: { id: bigint }, guildId: bigint) => Promise<void>`.

- [ ] **Step 1: Write the ban row before the DM**

In `bot/src/events/guildBanAdd.ts`, inside `onGuildBanAdd`'s returned function, before the `sendBanAppealDm` call:

```ts
      // Recorded BEFORE the DM, and outside its try/catch, because the two
      // have opposite failure modes. The DM is best-effort by design — a
      // closed inbox is normal and not an error. This row is what the appeal
      // site reads, so losing it because a DM failed would silently remove
      // this ban from the one place the banned person can find it.
      await db
        .insert(schema.guildBans)
        .values({ guildId: payload.guildId, userId: payload.user.id })
        .onConflictDoNothing();
```

Discord can redeliver a ban event, and a re-ban after an unban is the same
`(guild, user)` pair, so `onConflictDoNothing` keeps the original `bannedAt`
rather than throwing on the composite primary key.

- [ ] **Step 2: Create the remove handler**

Create `bot/src/events/guildBanRemove.ts`:

```ts
// bot/src/events/guildBanRemove.ts
//
// Deletes the guild_bans row when somebody is unbanned.
//
// Without this the appeal site keeps listing a server for a person who is no
// longer banned by it, and offers them an appeal that the ban re-check will
// then refuse. That reads as broken to the one person guaranteed to notice —
// somebody who just got unbanned and is checking.
//
// There was no guildBanRemove handler before this; the gateway delivers the
// event under the same GuildModeration intent guildBanAdd already needs, so
// enabling it in the Developer Portal covers both (see SETUP.md).

import { and, eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";

export function onGuildBanRemove(_bot: AppealyBot) {
  return async (user: { id: bigint }, guildId: bigint) => {
    try {
      await db
        .delete(schema.guildBans)
        .where(and(
          eq(schema.guildBans.guildId, guildId),
          eq(schema.guildBans.userId, user.id),
        ));
    } catch (err) {
      // Non-fatal. A stale row means the site offers an appeal that the live
      // ban check then refuses — wrong, but not harmful, and far better than
      // taking down the event handler for every other guild.
      logger.error("Failed to delete guild_bans row on unban", {
        guildId: guildId.toString(),
        userId: user.id.toString(),
        error: String(err),
      });
    }
  };
}
```

- [ ] **Step 3: Register it**

In `bot/src/events/index.ts`, add the import beside the others:

```ts
import { onGuildBanRemove } from "./guildBanRemove.ts";
```

and inside `registerEventHandlers`, next to the `banAdd` wiring:

```ts
  const banRemove = onGuildBanRemove(bot);
  // Same (user, guildId) argument order as guildBanAdd.
  bot.events.guildBanRemove = (user, guildId) => banRemove(user, guildId);
```

- [ ] **Step 4: Type-check and run the bot suite**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Expected: clean.
Run: `deno test --allow-read -c bot/deno.json bot/src/`
Expected: all pass — the deferGuard tests must stay green.

- [ ] **Step 5: Commit**

```bash
git add bot/src/events
git commit -m "Record and clear guild bans, so the appeal site has something to read"
```

---

### Task 3: The pure access policy

This is where every decision worth arguing about lives, so it is the part that gets tested. Everything after this is IO around it.

**Files:**
- Create: `shared/lib/appealAccess.ts`
- Create: `shared/lib/__tests__/appealAccess.test.ts`

**Interfaces:**
- Produces:
  - `type AppealDenial = "not_configured" | "not_enabled" | "no_form" | "ban_unverifiable" | "not_banned" | "already_open"`
  - `interface AppealAccessInput { publicEnabled: boolean; formId: string | null; formActive: boolean; banConfirmed: boolean | null; hasOpenAppeal: boolean; allowMultiplePending: boolean }`
  - `resolveAppealAccess(input: AppealAccessInput): { allowed: true } | { allowed: false; reason: AppealDenial }`
  - `describeAppealDenial(reason: AppealDenial): string`

- [ ] **Step 1: Write the failing test**

Create `shared/lib/__tests__/appealAccess.test.ts`:

```ts
// shared/lib/__tests__/appealAccess.test.ts
//
// Run with: deno test --allow-read -c bot/deno.json shared/lib/__tests__/appealAccess.test.ts
//
// The one rule worth stating twice: banConfirmed === null means "we could not
// find out", and that must REFUSE. banGate.ts fails open when it cannot
// answer, which is right for what it guards — a ban gate failing open briefly
// lets somebody use a bot. This failing open would let strangers into a staff
// review queue, and a queue that cannot be trusted is worse than one that is
// briefly empty.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeAppealDenial, resolveAppealAccess } from "../appealAccess.ts";

const ok = {
  publicEnabled: true,
  formId: "form-1",
  formActive: true,
  banConfirmed: true,
  hasOpenAppeal: false,
  allowMultiplePending: false,
};

function denial(over: Partial<typeof ok>) {
  const r = resolveAppealAccess({ ...ok, ...over });
  return r.allowed ? null : r.reason;
}

Deno.test("a banned person with a configured form may appeal", () => {
  assertEquals(resolveAppealAccess(ok).allowed, true);
});

Deno.test("an unverifiable ban is refused, never allowed through", () => {
  assertEquals(denial({ banConfirmed: null }), "ban_unverifiable");
});

Deno.test("somebody who is not banned is refused", () => {
  assertEquals(denial({ banConfirmed: false }), "not_banned");
});

Deno.test("a disabled public page is refused", () => {
  assertEquals(denial({ publicEnabled: false }), "not_enabled");
});

Deno.test("no form, or an inactive one, is refused", () => {
  assertEquals(denial({ formId: null }), "no_form");
  assertEquals(denial({ formActive: false }), "no_form");
});

Deno.test("a second appeal while one is open is refused", () => {
  assertEquals(denial({ hasOpenAppeal: true }), "already_open");
});

// The rule is the form's, not this feature's. A guild that has deliberately
// allowed multiple pending submissions has already answered this question,
// and inventing a stricter answer here would make the public page behave
// differently from the panel path for the same form.
Deno.test("a form that allows multiple pending is not blocked", () => {
  assertEquals(
    resolveAppealAccess({ ...ok, hasOpenAppeal: true, allowMultiplePending: true }).allowed,
    true,
  );
});

// Configuration is checked before the person, so somebody who is not banned
// cannot learn whether a server has appeals set up by probing this endpoint.
Deno.test("configuration problems are reported before personal ones", () => {
  assertEquals(denial({ publicEnabled: false, banConfirmed: false }), "not_enabled");
  assertEquals(denial({ formId: null, banConfirmed: null }), "no_form");
});

// Every message is read by somebody who has just been banned and is probably
// upset. None of them may imply the refusal is their fault when it is not.
Deno.test("an unverifiable ban blames the configuration, not the visitor", () => {
  const msg = describeAppealDenial("ban_unverifiable").toLowerCase();
  assertEquals(msg.includes("hasn't finished setting up") || msg.includes("has not finished setting up"), true);
});

Deno.test("every denial has a message", () => {
  const reasons = [
    "not_configured", "not_enabled", "no_form",
    "ban_unverifiable", "not_banned", "already_open",
  ] as const;
  for (const r of reasons) {
    assertEquals(describeAppealDenial(r).length > 20, true, r);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/appealAccess.test.ts`
Expected: FAIL — `Module not found ".../appealAccess.ts"`

- [ ] **Step 3: Write the implementation**

Create `shared/lib/appealAccess.ts`:

```ts
// shared/lib/appealAccess.ts
//
// Whether a given person may appeal to a given guild through the public site.
//
// Pure, because this is the decision the whole feature turns on and the API
// has no test runner. Every caller resolves the inputs however it likes and
// then asks this one function, so the bot, the API and any future surface
// cannot drift into three different answers.

export type AppealDenial =
  | "not_configured"
  | "not_enabled"
  | "no_form"
  | "ban_unverifiable"
  | "not_banned"
  | "already_open";

export interface AppealAccessInput {
  /** appealConfigs.publicEnabled. */
  publicEnabled: boolean;
  /** appealConfigs.formId. */
  formId: string | null;
  /** Whether that form exists and is active. */
  formActive: boolean;
  /**
   * true = Discord says banned. false = Discord says not banned.
   * null = WE COULD NOT FIND OUT — bot offline, GuildModeration intent off,
   * missing permission. Null refuses. See the test file's header.
   */
  banConfirmed: boolean | null;
  /** Whether this person already has an appeal awaiting review here. */
  hasOpenAppeal: boolean;
  /**
   * forms.allowMultiplePending, for the form being appealed through.
   *
   * The one-open-appeal rule belongs to the form and is already enforced on
   * the panel path by evaluateGate. Reading it here rather than inventing a
   * stricter rule keeps the public page behaving like every other entry point
   * into the same form.
   */
  allowMultiplePending: boolean;
}

export function resolveAppealAccess(
  input: AppealAccessInput,
): { allowed: true } | { allowed: false; reason: AppealDenial } {
  // Configuration first, deliberately. Checking the person first would let
  // anyone probe whether a server has appeals configured by watching which
  // refusal they get, and a server's moderation setup is not public.
  if (!input.publicEnabled) return { allowed: false, reason: "not_enabled" };
  if (!input.formId || !input.formActive) return { allowed: false, reason: "no_form" };

  if (input.banConfirmed === null) return { allowed: false, reason: "ban_unverifiable" };
  if (input.banConfirmed === false) return { allowed: false, reason: "not_banned" };

  if (input.hasOpenAppeal && !input.allowMultiplePending) {
    return { allowed: false, reason: "already_open" };
  }

  return { allowed: true };
}

/**
 * The sentence shown to the visitor.
 *
 * Every one of these is read by somebody who has just been banned. None of
 * them may imply the refusal is their fault when it is not: "ban_unverifiable"
 * is the server's configuration, not their mistake, and telling them
 * otherwise sends them to argue with a moderator about something the
 * moderator's own setup caused.
 */
export function describeAppealDenial(reason: AppealDenial): string {
  switch (reason) {
    case "not_configured":
    case "not_enabled":
      return "This server hasn't set up appeals through Appealy. You'll need to contact its staff another way.";
    case "no_form":
      return "This server has appeals switched on but hasn't finished setting up its appeal form yet. Nothing you can do from here — its staff need to finish it.";
    case "ban_unverifiable":
      return "This server hasn't finished setting up appeals — we can't check your ban, so we can't accept an appeal yet. This isn't something you did, and its staff have been told.";
    case "not_banned":
      return "You don't appear to be banned from this server, so there's nothing to appeal. If you were just unbanned, that's why.";
    case "already_open":
      return "You already have an appeal waiting for review here. Its staff will see it — sending another won't make it faster.";
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/appealAccess.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/appealAccess.ts shared/lib/__tests__/appealAccess.test.ts
git commit -m "The appeal access policy, as a pure function that refuses on doubt"
```

---

### Task 4: Ask Discord whether the ban is real

**Files:**
- Modify: `bot/src/core/controlServer.ts`
- Modify: `api/src/services/botBridge.ts`

**Interfaces:**
- Produces: `POST /internal/guilds/ban-check` accepting `{ guildId: string, userId: string }`, returning `{ banned: boolean }`.
- Produces: `checkGuildBan(guildId: string, userId: string): Promise<boolean | null>` in `botBridge.ts`. **`null` means could not determine** and maps straight to `AppealAccessInput.banConfirmed`.

- [ ] **Step 1: Add the bot endpoint**

In `bot/src/core/controlServer.ts`, beside the `/internal/cache/ban` handler:

```ts
      // Is this person actually banned here?
      //
      // Nothing else in the bot queries a ban list. This asks Discord rather
      // than reading guild_bans, because that table is an index and can be
      // stale — an unban delivered while the bot was offline leaves a row
      // behind, and a stale row must never be enough to open a staff review
      // queue to a stranger.
      if (url.pathname === "/internal/guilds/ban-check" && req.method === "POST") {
        const { guildId, userId } = await req.json();
        try {
          await bot.helpers.getBan(BigInt(guildId), BigInt(userId));
          return Response.json({ banned: true });
        } catch (err) {
          // Discord answers 404 for "not banned", which is a real answer and
          // not a failure. Anything else — missing GuildModeration intent, no
          // Ban Members permission, the bot not being in the guild — means we
          // do not know, and the caller must refuse rather than guess.
          const status = (err as { status?: number })?.status;
          if (status === 404) return Response.json({ banned: false });
          logger.warn("Ban check could not be answered", {
            guildId: String(guildId),
            error: String(err),
          });
          return Response.json({ error: "ban_unverifiable" }, { status: 503 });
        }
      }
```

- [ ] **Step 2: Add the API side**

In `api/src/services/botBridge.ts`, after `requestBanChange`:

```ts
/**
 * Whether Discord says this user is banned in this guild.
 *
 * Returns null for "could not find out", which is a THIRD state and not a
 * synonym for false. The caller feeds it straight into resolveAppealAccess,
 * where null refuses — the whole point being that we never let somebody into
 * a staff review queue on a guess.
 */
export async function checkGuildBan(
  guildId: string,
  userId: string,
): Promise<boolean | null> {
  try {
    const res = await callBot("/internal/guilds/ban-check", { guildId, userId }) as {
      banned?: boolean;
    };
    return typeof res.banned === "boolean" ? res.banned : null;
  } catch {
    // Bot offline, timeout, 503 from the handler above. All of them mean the
    // same thing here: we do not know.
    return null;
  }
}
```

- [ ] **Step 3: Type-check both runtimes**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: both clean. If `bot.helpers.getBan` does not type-check, check the helper name against the Discordeno v20 typings in the Deno cache before inventing one — no existing code in this repo calls it, so there is no local precedent to copy.

- [ ] **Step 4: Commit**

```bash
git add bot/src/core/controlServer.ts api/src/services/botBridge.ts
git commit -m "Ask Discord whether a ban is real, and say so when we cannot"
```

---

### Task 5: A daily cap the API can actually consume

Task 6 meters appeals against `submissionsPerDay`, and the function that does
it lives only in the bot. This is its own task because the key format is shared
state between two processes: get it wrong and each counts its own counter, so a
guild's real limit silently doubles with nothing failing.

**Files:**
- Create: `shared/lib/rateLimitKeys.ts`
- Create: `shared/lib/__tests__/rateLimitKeys.test.ts`
- Modify: `bot/src/services/rateLimitService.ts` (use the shared key)
- Modify: `api/src/services/rateLimitService.ts` (add the function)

**Interfaces:**
- Produces: `dailyCapKey(guildId: bigint, capName: string, now?: Date): string`
- Produces: `checkAndConsumeDailyCap(guildId: bigint, capName: DailyCapName): Promise<{ allowed: boolean; current: number; limit: number }>` in the **API's** rateLimitService, matching the bot's existing signature.

- [ ] **Step 1: Write the failing test**

Create `shared/lib/__tests__/rateLimitKeys.test.ts`:

```ts
// Two processes increment this counter. If their key formats ever differ they
// count separately and the guild silently gets twice the cap it pays for --
// with nothing failing, which is why this is a test and not a comment.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dailyCapKey } from "../rateLimitKeys.ts";

const AT = new Date("2026-09-02T13:45:00.000Z");

Deno.test("the key matches the format already in Redis", () => {
  assertEquals(
    dailyCapKey(123n, "submissionsPerDay", AT),
    "appealy:ratelimit:123:submissionsPerDay:2026-09-02",
  );
});

Deno.test("the bucket is the UTC day, not the local one", () => {
  assertEquals(
    dailyCapKey(1n, "x", new Date("2026-09-02T23:30:00.000Z")).endsWith("2026-09-02"),
    true,
  );
  assertEquals(
    dailyCapKey(1n, "x", new Date("2026-09-03T00:30:00.000Z")).endsWith("2026-09-03"),
    true,
  );
});

Deno.test("different guilds and caps never share a key", () => {
  assertEquals(dailyCapKey(1n, "a", AT) === dailyCapKey(2n, "a", AT), false);
  assertEquals(dailyCapKey(1n, "a", AT) === dailyCapKey(1n, "b", AT), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/rateLimitKeys.test.ts`
Expected: FAIL -- module not found.

- [ ] **Step 3: Implement the shared key**

Create `shared/lib/rateLimitKeys.ts`:

```ts
// shared/lib/rateLimitKeys.ts
//
// The Redis key a daily cap counts against.
//
// Shared because the bot and the API both increment it. The bot has counted
// submissions since it shipped; the API needs to count the ones submitted
// through the public appeal page. If the two ever disagree about the key they
// count separately, the guild gets double the cap it paid for, and nothing
// anywhere fails -- exactly the class of bug this repository keeps finding
// long after the fact.
//
// `now` is a parameter so the UTC-day boundary is testable without waiting
// for midnight.

export function dailyCapKey(guildId: bigint, capName: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD, always UTC
  return `appealy:ratelimit:${guildId}:${capName}:${day}`;
}
```

- [ ] **Step 4: Run the test**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/rateLimitKeys.test.ts`
Expected: PASS -- 3 tests.

**If the first test fails on the day format**, do NOT change the test to match
the code. Read `capKey` and `dayBucket` in `bot/src/services/rateLimitService.ts`
and make `dailyCapKey` produce exactly what the bot already writes -- there are
live counters in Redis using that format, and changing it resets every guild's
usage to zero mid-day.

- [ ] **Step 5: Point the bot at the shared key**

In `bot/src/services/rateLimitService.ts`, replace the body of the private
`capKey` with the shared one, keeping the local name so no call site changes:

```ts
import { dailyCapKey } from "../../../shared/lib/rateLimitKeys.ts";

function capKey(guildId: bigint, capName: string): string {
  return dailyCapKey(guildId, capName);
}
```

- [ ] **Step 6: Add the API's copy**

In `api/src/services/rateLimitService.ts`:

```ts
import { withRedis } from "../lib/redis.ts";
import { dailyCapKey } from "../../../shared/lib/rateLimitKeys.ts";

export type DailyCapName = "submissionsPerDay" | "ticketsPerDay" | "giveawayEntriesPerDay";

/**
 * Consume one unit of a daily cap.
 *
 * Deliberately identical in behaviour to the bot's function of the same name,
 * including the key and the 25-hour expiry, because they increment the SAME
 * counter -- a submission is a submission whether it arrived through Discord
 * or through the appeal page.
 *
 * FAILS CLOSED when Redis is unreachable. The header of the bot's copy gives
 * the reason and it holds here: failing open means the caps being charged for
 * stop existing during an outage.
 */
export async function checkAndConsumeDailyCap(
  guildId: bigint,
  capName: DailyCapName,
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const limit = (guild ? resolveEffectiveCaps(guild) : FREE_CAPS)[capName];
  const key = dailyCapKey(guildId, capName);

  const current = await withRedis(async (r) => {
    const n = await r.incr(key);
    // Only on the first increment of a window, so this costs one extra round
    // trip per guild per day rather than one per action.
    if (n === 1) await r.expire(key, 25 * 60 * 60);
    return n;
  }, null);

  if (current === null) return { allowed: false, current: 0, limit };
  return { allowed: current <= limit, current, limit };
}
```

- [ ] **Step 7: Verify both runtimes and the whole suite**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Run: `deno test --allow-read -c bot/deno.json bot/src/ shared/`
Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: all clean. The bot's own rate-limit tests must still pass -- the key
did not change, only where it is written.

- [ ] **Step 8: Commit**

```bash
git add shared/lib/rateLimitKeys.ts shared/lib/__tests__/rateLimitKeys.test.ts bot/src/services/rateLimitService.ts api/src/services/rateLimitService.ts
git commit -m "One daily-cap key, so the bot and API cannot count separately"
```

---

### Task 6: The public appeal endpoints

**Files:**
- Create: `api/src/routes/publicAppeals.ts`
- Modify: `api/src/app.ts`

**Interfaces:**
- Consumes: `resolveAppealAccess`, `describeAppealDenial` (Task 3); `checkGuildBan` (Task 4); `schema.guildBans`, `appealConfigs.publicCode`/`.publicEnabled` (Task 1).
- Produces: `GET /api/appeal/:code`, `POST /api/appeal/:code`, `GET /api/appeals`.

- [ ] **Step 1: Write the route file**

Create `api/src/routes/publicAppeals.ts`:

```ts
// api/src/routes/publicAppeals.ts
//
// The public appeal surface. Mounted at /api (see app.ts) and reachable by
// anybody with a Discord login — which is the point: the people this serves
// are banned, so no guild-scoped middleware can apply to them.
//
// THREE RULES THIS FILE EXISTS TO KEEP.
//
// 1. It never answers from guild_bans alone. That table is an index for the
//    list; every appeal re-confirms against Discord, because a stale row must
//    not be enough to open a staff review queue.
// 2. It leaks nothing about a server's configuration. The GET returns a
//    guild name, an icon, a form title and its questions. Nothing else.
// 3. It refuses when it cannot confirm. See shared/lib/appealAccess.ts.

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.ts";
import { requireSession } from "../middleware/auth.ts";
import { checkGuildBan } from "../services/botBridge.ts";
import { checkAndConsumeDailyCap } from "../services/rateLimitService.ts";
import {
  describeAppealDenial,
  resolveAppealAccess,
} from "../../../shared/lib/appealAccess.ts";

export const publicAppealsRouter = Router();

// Every route needs a Discord identity and nothing more. requireSession does
// not imply guild access, which is exactly right here — a banned user has
// none, and demanding any would lock out everybody this feature is for.
publicAppealsRouter.use(requireSession);

/** The servers we know have banned this person. */
publicAppealsRouter.get("/appeals", async (req, res) => {
  const userId = BigInt(req.userId!);

  const bans = await db
    .select({ guildId: schema.guildBans.guildId, bannedAt: schema.guildBans.bannedAt })
    .from(schema.guildBans)
    .where(eq(schema.guildBans.userId, userId));

  if (bans.length === 0) return res.json({ appeals: [] });

  const guildIds = bans.map((b) => b.guildId);
  const configs = await db
    .select({
      guildId: schema.appealConfigs.guildId,
      publicCode: schema.appealConfigs.publicCode,
      publicEnabled: schema.appealConfigs.publicEnabled,
    })
    .from(schema.appealConfigs)
    .where(inArray(schema.appealConfigs.guildId, guildIds));

  const guilds = await db
    .select({ id: schema.guilds.id, name: schema.guilds.name, icon: schema.guilds.icon })
    .from(schema.guilds)
    .where(inArray(schema.guilds.id, guildIds));

  const byGuild = new Map(configs.map((c) => [c.guildId.toString(), c]));
  const nameOf = new Map(guilds.map((g) => [g.id.toString(), g]));

  // Only servers that actually have a public page are listed. Showing one that
  // does not would offer a door that opens onto a refusal.
  res.json({
    appeals: bans
      .map((b) => {
        const cfg = byGuild.get(b.guildId.toString());
        const guild = nameOf.get(b.guildId.toString());
        if (!cfg?.publicEnabled || !cfg.publicCode || !guild) return null;
        return {
          code: cfg.publicCode,
          guildName: guild.name,
          guildIcon: guild.icon ?? null,
          bannedAt: b.bannedAt,
        };
      })
      .filter(Boolean),
  });
});

/** Resolve a code to everything the page needs, or to a denial. */
async function loadByCode(code: string, userId: bigint) {
  const config = await db.query.appealConfigs.findFirst({
    where: eq(schema.appealConfigs.publicCode, code),
  });
  if (!config) return { denial: "not_configured" as const };

  const form = config.formId
    ? await db.query.forms.findFirst({
      where: eq(schema.forms.id, config.formId),
      with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
    })
    : null;

  const banConfirmed = await checkGuildBan(
    config.guildId.toString(),
    userId.toString(),
  );

  const openAppeals = form
    ? await db
      .select({ id: schema.submissions.id })
      .from(schema.submissions)
      .where(and(
        eq(schema.submissions.formId, form.id),
        eq(schema.submissions.applicantId, userId),
        eq(schema.submissions.status, "pending"),
      ))
      .limit(1)
    : [];

  const access = resolveAppealAccess({
    publicEnabled: config.publicEnabled,
    formId: config.formId,
    formActive: Boolean(form?.active),
    banConfirmed,
    hasOpenAppeal: openAppeals.length > 0,
    allowMultiplePending: Boolean(form?.allowMultiplePending),
  });

  return { config, form, access };
}

publicAppealsRouter.get("/appeal/:code", async (req, res) => {
  const userId = BigInt(req.userId!);
  const loaded = await loadByCode(req.params.code, userId);

  if ("denial" in loaded) {
    return res.status(404).json({
      error: "unavailable",
      detail: describeAppealDenial(loaded.denial),
    });
  }
  if (!loaded.access.allowed) {
    return res.status(403).json({
      error: "unavailable",
      reason: loaded.access.reason,
      detail: describeAppealDenial(loaded.access.reason),
    });
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.id, loaded.config.guildId),
  });

  // Deliberately narrow. Adding a field here is a security decision, not a
  // convenience — this response is readable by anyone with a link.
  res.json({
    guildName: guild?.name ?? "this server",
    guildIcon: guild?.icon ?? null,
    formName: loaded.form!.name,
    confirmationMessage: loaded.form!.confirmationMessage,
    questions: loaded.form!.questions.map((q) => ({
      id: q.id,
      label: q.label,
      placeholder: q.placeholder,
      type: q.type,
      required: q.required,
      options: q.options,
      minLength: q.minLength,
      maxLength: q.maxLength,
    })),
  });
});

const submitSchema = z.object({
  answers: z.record(z.string(), z.string().max(4000)),
});

publicAppealsRouter.post("/appeal/:code", async (req, res) => {
  const userId = BigInt(req.userId!);
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }

  // Re-resolved on submit rather than trusting the GET. The two are separate
  // requests and an unban, a config change or a first appeal can land between
  // them.
  const loaded = await loadByCode(req.params.code, userId);
  if ("denial" in loaded) {
    return res.status(404).json({ error: "unavailable", detail: describeAppealDenial(loaded.denial) });
  }
  if (!loaded.access.allowed) {
    return res.status(403).json({
      error: "unavailable",
      reason: loaded.access.reason,
      detail: describeAppealDenial(loaded.access.reason),
    });
  }

  const form = loaded.form!;

  // An appeal is a submission and costs the guild one, exactly as a DM appeal
  // does. Consumed only after every access check has passed, so a refused
  // attempt never bills the guild for work it did not accept.
  const rateLimit = await checkAndConsumeDailyCap(loaded.config.guildId, "submissionsPerDay");
  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      detail:
        "This server has reached the number of submissions it can take today. " +
        "Try again tomorrow — this isn't something you did wrong.",
    });
  }

  const submission = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.submissions)
      .values({
        formId: form.id,
        guildId: loaded.config.guildId,
        applicantId: userId,
        status: "pending",
      })
      .returning();

    const rows = form.questions
      .filter((q) => {
        const v = parsed.data.answers[q.id];
        return v !== undefined && v !== "";
      })
      .map((q) => ({
        submissionId: created.id,
        questionId: q.id,
        value: parsed.data.answers[q.id],
      }));
    if (rows.length > 0) await tx.insert(schema.answers).values(rows);

    return created;
  });

  res.status(201).json({ submissionId: submission.id });
});
```

- [ ] **Step 2: Mount it**

In `api/src/app.ts`, mount beside the other `/api` routers:

```ts
// Mounted OUTSIDE any guild-scoped middleware. The people this serves are
// banned from the guild in question and have no access to it by definition;
// requiring guild access would lock out exactly the audience.
app.use("/api", publicAppealsRouter);
```

with the matching import at the top of the file.

- [ ] **Step 3: Type-check**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0. If `req.userId` is not typed, copy how `api/src/routes/migration.ts` reads it.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/publicAppeals.ts api/src/app.ts
git commit -m "Public appeal endpoints: list, read, submit"
```

---

### Task 7: Owner configuration

Nothing above is reachable until an owner turns it on and picks a code.

**Files:**
- Modify: `api/src/routes/appealConfig.ts`
- Create: `shared/lib/__tests__/appealCode.test.ts`
- Create: `shared/lib/appealCode.ts`

**Interfaces:**
- Produces: `normalizeAppealCode(raw: string): string | null` and `RESERVED_APPEAL_CODES: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `shared/lib/__tests__/appealCode.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeAppealCode } from "../appealCode.ts";

Deno.test("a Discord invite code passes through", () => {
  assertEquals(normalizeAppealCode("abc123"), "abc123");
  assertEquals(normalizeAppealCode("HkQ8sT2"), "hkq8st2");
});

Deno.test("a pasted invite URL is reduced to its code", () => {
  assertEquals(normalizeAppealCode("https://discord.gg/abc123"), "abc123");
  assertEquals(normalizeAppealCode("discord.gg/abc123"), "abc123");
});

Deno.test("surrounding whitespace is ignored", () => {
  assertEquals(normalizeAppealCode("  abc123  "), "abc123");
});

// These are real paths on the site. A guild claiming one would shadow it.
Deno.test("reserved words are refused", () => {
  for (const w of ["pricing", "privacy", "terms", "appeals", "dashboard", "api"]) {
    assertEquals(normalizeAppealCode(w), null, w);
  }
});

Deno.test("anything that is not a plausible code is refused", () => {
  assertEquals(normalizeAppealCode(""), null);
  assertEquals(normalizeAppealCode("a"), null);          // too short
  assertEquals(normalizeAppealCode("has spaces"), null);
  assertEquals(normalizeAppealCode("slash/es"), null);
  assertEquals(normalizeAppealCode("x".repeat(65)), null); // too long
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/appealCode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `shared/lib/appealCode.ts`:

```ts
// shared/lib/appealCode.ts
//
// Normalises what an owner types into the public appeal code.
//
// They will paste a full invite URL, because that is what Discord's UI gives
// them. Accepting only the bare code would make the obvious action fail with a
// validation error, so the URL forms are handled here rather than in an
// error message.

/**
 * Paths that already exist on the site. A guild claiming one would shadow a
 * real page — /appeal/pricing is harmless, but this list also guards the
 * reverse mistake of someone later routing /appeals/<code> and colliding.
 */
export const RESERVED_APPEAL_CODES = [
  "api", "appeal", "appeals", "auth", "brand", "dashboard", "img",
  "pricing", "privacy", "robots", "sitemap", "status", "tebex", "terms",
  "appy-alternative",
] as const;

export function normalizeAppealCode(raw: string): string | null {
  let code = raw.trim().toLowerCase();

  // Strip the invite forms people paste.
  code = code.replace(/^https?:\/\//, "").replace(/^(www\.)?discord\.gg\//, "");
  code = code.replace(/[?#].*$/, "").replace(/\/+$/, "");

  if (!/^[a-z0-9-]{2,64}$/.test(code)) return null;
  if ((RESERVED_APPEAL_CODES as readonly string[]).includes(code)) return null;
  return code;
}
```

- [ ] **Step 4: Run the tests**

Run: `deno test --allow-read -c bot/deno.json shared/lib/__tests__/appealCode.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Accept the fields in the config route**

In `api/src/routes/appealConfig.ts`, extend `appealConfigSchema` with:

```ts
  publicCode: z.string().max(100).nullable().optional(),
  publicEnabled: z.boolean().optional(),
```

and in the write handler, before persisting:

```ts
  // Normalised here rather than trusted, and rejected loudly: a code that
  // silently became something else would give the owner a link that does not
  // match the one they are about to paste into a ban reason.
  let publicCode = existing?.publicCode ?? null;
  if (data.publicCode !== undefined) {
    if (data.publicCode === null) {
      publicCode = null;
    } else {
      const normalized = normalizeAppealCode(data.publicCode);
      if (!normalized) {
        return res.status(400).json({
          error: "invalid_appeal_code",
          detail:
            "Use the code from your server's invite — letters, numbers and dashes, 2 to 64 characters. " +
            "Some words are reserved because they are already pages on this site.",
        });
      }
      const taken = await db.query.appealConfigs.findFirst({
        where: eq(schema.appealConfigs.publicCode, normalized),
      });
      if (taken && taken.guildId !== guildId) {
        return res.status(409).json({
          error: "appeal_code_taken",
          detail: "Another server is already using that code. Pick a different one.",
        });
      }
      publicCode = normalized;
    }
  }
```

Persist `publicCode` and `data.publicEnabled ?? existing?.publicEnabled ?? false` with the rest of the row.

- [ ] **Step 6: Type-check**

Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add shared/lib/appealCode.ts shared/lib/__tests__/appealCode.test.ts api/src/routes/appealConfig.ts
git commit -m "Let an owner claim a public appeal code, and refuse the ones that collide"
```

---

### Task 8: The public pages

**Files:**
- Create: `web/src/pages/PublicAppeals.tsx`
- Create: `web/src/pages/PublicAppealForm.tsx`
- Modify: `web/src/App.tsx` (routes)
- Modify: `web/nginx.conf`

**Interfaces:**
- Consumes: `GET /api/appeals`, `GET /api/appeal/:code`, `POST /api/appeal/:code` (Task 5).

- [ ] **Step 1: Read how an existing page calls the API**

Read `web/src/pages/AppealConfig.tsx` in full and copy its fetch/loading/error idiom rather than inventing one. Note how it reads the session and how it renders an error — these pages must degrade the same way.

- [ ] **Step 2: Build the list page**

Create `web/src/pages/PublicAppeals.tsx`, rendering `GET /api/appeals`:

- One card per server: icon, name, when the ban was recorded, an **Appeal** button linking to `/appeal/<code>`.
- Empty state that is not a dead end: *"We don't know of any servers that have banned you. If you have an appeal link from a server, open that instead — servers that installed Appealy after you were banned won't show up here."* This is the honest statement of the design's known limit and must not be softened into "you have no bans".
- Unauthenticated: send to the existing Discord login and return here afterwards.

- [ ] **Step 3: Build the form page**

Create `web/src/pages/PublicAppealForm.tsx` for `/appeal/:code`:

- Fetch the GET. On 403/404 render `detail` from the response verbatim — those sentences were written in `describeAppealDenial` precisely so the UI does not reword them.
- Render text and paragraph questions as inputs, select questions as dropdowns using `options`, honouring `required`, `minLength`, `maxLength`.
- Submit to the POST. On 201 show a confirmation that says the appeal is with the server's staff and that sending another will not speed it up.

- [ ] **Step 4: Add the routes**

In `web/src/App.tsx`, register `/appeals` and `/appeal/:code` as routes that do **not** require a guild context or the console shell.

- [ ] **Step 5: Serve them**

In `web/nginx.conf`, inside the default server block, add alongside `location /dashboard/`:

```nginx
  # The public appeal surface. Served by the same SPA bundle as the console
  # but deliberately outside /dashboard/, because the audience is people who
  # have no dashboard access and must never be bounced into a login that
  # implies they should.
  location /appeals { try_files $uri /dashboard/index.html; }
  location /appeal/ { try_files $uri /dashboard/index.html; }
```

- [ ] **Step 6: Build**

Run: `cd web && npm run build`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add web/src web/nginx.conf
git commit -m "The pages a banned person actually uses"
```

---

### Task 9: Documentation, and the claim this earns

**Files:**
- Modify: `APPEALS.md`
- Modify: `SETUP.md`
- Modify: `site/index.html`, `site/appy-alternative.html`

- [ ] **Step 1: Document the flow in `APPEALS.md`**

Add a section covering: the two entry points, that `guild_bans` is an index and not the source of truth, that every appeal re-confirms against Discord, and that the whole thing refuses when it cannot confirm — with the reason that differs from `banGate.ts`.

- [ ] **Step 2: Add the intent note to `SETUP.md`**

In "Things only you can do", extend the `GuildModeration` entry: it is now required for the public appeal portal as well as `guildBanAdd`, because both the ban check and `guildBanRemove` depend on it. Without it, every public appeal is refused with `ban_unverifiable` — which is correct behaviour and looks like a bug.

- [ ] **Step 3: Update the site**

The claim this feature earns, and not before: that anyone banned from a server running Appealy can appeal, whether or not their DMs are open. Add it to the Ban appeals feature list on `site/index.html`, and to the "Does it handle ban appeals?" answer on `site/appy-alternative.html` — the visible copy **and** its FAQ JSON-LD, which must stay in step.

- [ ] **Step 4: Full verification**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Run: `deno test --allow-read -c bot/deno.json bot/src/ shared/`
Run: `cd api && npx tsc --noEmit -p tsconfig.json`
Run: `cd web && npm run build`
Run: `sh scripts/build-site.sh`
Expected: all clean; test count up by 18 from this plan's four test files.

- [ ] **Step 5: Commit**

```bash
git add APPEALS.md SETUP.md site
git commit -m "Document the appeal portal, and make the claim it earns"
```

---

## Verification before calling this done

- [ ] `grep -c "getBan" bot/src/core/controlServer.ts` → at least 1
- [ ] The generated migration contains the partial index **with** its `WHERE public_code is not null`
- [ ] `deno test --allow-read -c bot/deno.json shared/` includes `appealAccess`, `appealCode` and `rateLimitKeys`
- [ ] `dailyCapKey` produces exactly what the bot already writes to Redis -- a changed format resets every guild's usage mid-day
- [ ] `resolveAppealAccess({ ...ok, banConfirmed: null })` refuses — the single most important line in the feature
- [ ] The `GET /api/appeal/:code` response contains no reviewer roles, log channel ids or outcome definitions
- [ ] A form with `allowMultiplePending` true accepts a second appeal; one without it does not
- [ ] A refused appeal does NOT consume `submissionsPerDay`
- [ ] `/appeals` and `/appeal/<code>` load without a guild context and without console access

Live, after deploy:

- [ ] A user who is genuinely banned can complete an appeal end to end
- [ ] A user who is **not** banned is refused at both GET and POST
- [ ] With the bot stopped, the page refuses and says the server is not set up — it does not show a form
- [ ] Unbanning someone removes the server from their `/appeals` list
