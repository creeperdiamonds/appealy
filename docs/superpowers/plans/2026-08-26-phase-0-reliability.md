# Phase 0: Stop Looking Broken — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Appealy's interaction handlers answer Discord inside its three-second window, report real errors when they don't, keep the bot's caches correct without buying Memorystore, and stop the site advertising a price the billing code doesn't charge.

**Architecture:** Two new leaf utilities (`discordError.ts`, `interactionResponse.ts`) with no project dependencies, guarded by a source-level invariant test that is written to fail first and goes green as handlers are converted. Cache invalidation reuses the existing authenticated bot control server rather than adding infrastructure.

**Tech Stack:** Deno + Discordeno v20 (bot), Node + Express (api), Drizzle ORM, `deno test` with `https://deno.land/std@0.224.0/assert/mod.ts`.

**Spec:** `docs/superpowers/specs/2026-08-26-appealy-reliability-and-marketing-design.md`

## Global Constraints

- **Discord allows three seconds** for a first interaction response. After that the token is dead and every call against it fails with `10062 Unknown Interaction`.
- **A modal response must be the first response.** You cannot defer and then open a modal. The three modal-opening handlers (`panelOpen.ts:182`, `reviewDeny.ts:94`, `verify.ts:50`) must never call `defer()`, and their pre-checks must stay cache-backed — a REST call before the modal blows the same window with no fix available.
- **The ephemeral flag belongs on the deferred response**, `type: 5, data: { flags: 64 }` — never on the edit. Defer publicly and it cannot be retracted.
- **Tests run from the repository root** with `deno test -c bot/deno.json`. Bot code resolves `@discordeno/bot` through `bot/deno.json`'s import map; without `-c` the type-check fails.
- **Converted handlers use `defer()`/`finish()` exclusively** and never call `bot.helpers.sendInteractionResponse` directly. This is the invariant Task 3 enforces.
- **Cache invalidation must never fail a write.** The existing contract in `api/src/services/cacheInvalidation.ts` is fire-and-forget and never throws; the new path keeps it.
- Commit after every task.

---

### Task 1: `describeDiscordError`

Discordeno throws `Error("Failed to send request to discord.")` for everything — no status, no Discord error code, no body. That is why a three-day outage in the flagship action looked like a network blip.

The helper walks the error, its `body`, and its `cause` chain rather than assuming a shape, so it degrades gracefully whatever Discordeno actually throws.

**Files:**
- Create: `bot/src/utils/discordError.ts`
- Test: `bot/src/utils/__tests__/discordError.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DiscordErrorInfo { status: number | null; code: number | null; message: string; raw: string }`
  - `describeDiscordError(err: unknown): DiscordErrorInfo`
  - `isUnknownInteraction(info: DiscordErrorInfo): boolean`

- [ ] **Step 1: Write the failing test**

Create `bot/src/utils/__tests__/discordError.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeDiscordError, isUnknownInteraction } from "../discordError.ts";

Deno.test("bare error keeps its message and finds nothing else", () => {
  const info = describeDiscordError(new Error("Failed to send request to discord."));
  assertEquals(info.status, null);
  assertEquals(info.code, null);
  assertEquals(info.message, "Failed to send request to discord.");
});

Deno.test("reads a JSON string body", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: '{"message":"Unknown interaction","code":10062}',
    status: 404,
  });
  const info = describeDiscordError(err);
  assertEquals(info.status, 404);
  assertEquals(info.code, 10062);
  assertEquals(info.message, "Unknown interaction");
});

Deno.test("reads an object body and a statusCode alias", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: { message: "Missing Permissions", code: 50013 },
    statusCode: 403,
  });
  const info = describeDiscordError(err);
  assertEquals(info.status, 403);
  assertEquals(info.code, 50013);
  assertEquals(info.message, "Missing Permissions");
});

Deno.test("follows the cause chain", () => {
  const inner = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  const err = new Error("Failed to send request to discord.", { cause: inner });
  const info = describeDiscordError(err);
  assertEquals(info.code, 10062);
  assertEquals(info.message, "Unknown interaction");
});

Deno.test("prefers a specific message over the generic wrapper", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: { message: "Cannot send messages to this user", code: 50007 },
  });
  assertEquals(describeDiscordError(err).message, "Cannot send messages to this user");
});

Deno.test("survives a non-error", () => {
  assertEquals(describeDiscordError("boom").message, "boom");
  assertEquals(describeDiscordError(null).message, "null");
});

Deno.test("isUnknownInteraction only matches 10062", () => {
  assertEquals(isUnknownInteraction(describeDiscordError(Object.assign(new Error("x"), { code: 10062 }))), true);
  assertEquals(isUnknownInteraction(describeDiscordError(Object.assign(new Error("x"), { code: 50013 }))), false);
  assertEquals(isUnknownInteraction(describeDiscordError(new Error("x"))), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -c bot/deno.json bot/src/utils/__tests__/discordError.test.ts`
Expected: FAIL — `Module not found ".../discordError.ts"`

- [ ] **Step 3: Write the implementation**

Create `bot/src/utils/discordError.ts`:

```ts
// bot/src/utils/discordError.ts
//
// Discordeno v20 rejects with Error("Failed to send request to discord.")
// for every REST failure — a closed DM, a missing permission, an expired
// interaction token and a DNS blip all produce that same sentence. On
// 2026-08-23 the flagship review action failed for three days and the logs
// were indistinguishable from noise.
//
// Rather than assume a shape that may change between library versions, this
// walks the error, any `body` it carries, and its `cause` chain, taking the
// first usable value it finds at each level. Anything it cannot read
// degrades to the original message rather than throwing.

/** Discordeno's wrapper message, which tells you nothing on its own. */
const GENERIC = "Failed to send request to discord.";

/** How far down a cause chain to look before giving up. */
const MAX_DEPTH = 4;

/** Keep `raw` bounded — this goes into structured logs on every failure. */
const MAX_RAW = 500;

export interface DiscordErrorInfo {
  /** HTTP status, when discoverable. */
  status: number | null;
  /** Discord's JSON error code, e.g. 10062 Unknown Interaction. */
  code: number | null;
  /** The most specific human-readable message available. */
  message: string;
  /** Bounded debug string for the log line. */
  raw: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

export function describeDiscordError(err: unknown): DiscordErrorInfo {
  const levels: Record<string, unknown>[] = [];
  let cursor: unknown = err;

  for (let depth = 0; depth < MAX_DEPTH && cursor != null; depth++) {
    const record = asRecord(cursor);
    if (!record) break;
    levels.push(record);
    const body = asRecord(record.body);
    if (body) levels.push(body);
    cursor = record.cause;
  }

  let status: number | null = null;
  let code: number | null = null;
  const messages: string[] = [];

  for (const level of levels) {
    if (status === null) status = pickNumber(level, ["status", "statusCode", "httpStatus"]);
    if (code === null) code = pickNumber(level, ["code", "errorCode"]);
    if (typeof level.message === "string" && level.message) messages.push(level.message);
  }

  // The wrapper's own message is the least useful one available, so it is
  // only chosen when nothing deeper offered anything.
  const message = messages.find((m) => m !== GENERIC) ?? messages[0] ?? String(err);

  const raw = JSON.stringify({ status, code, message }).slice(0, MAX_RAW);

  return { status, code, message, raw };
}

/**
 * True when Discord rejected the interaction token as unknown.
 *
 * In practice this means the handler took longer than three seconds to make
 * its first response. Treat it as a latency bug in the handler, not as a
 * transient Discord failure — retrying cannot help, because the token is
 * already gone.
 */
export function isUnknownInteraction(info: DiscordErrorInfo): boolean {
  return info.code === 10062;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test -c bot/deno.json bot/src/utils/__tests__/discordError.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/discordError.ts bot/src/utils/__tests__/discordError.test.ts
git commit -m "Describe Discord errors instead of logging one useless sentence"
```

---

### Task 2: `defer` and `finish` helpers

**Files:**
- Create: `bot/src/utils/interactionResponse.ts`
- Test: `bot/src/utils/__tests__/interactionResponse.test.ts`

**Interfaces:**
- Consumes: `AppealyBot` and `AppealyInteraction` types from `bot/src/core/client.ts`.
- Produces:
  - `defer(bot: AppealyBot, interaction: AppealyInteraction, opts?: { ephemeral?: boolean }): Promise<void>`
  - `finish(bot: AppealyBot, interaction: AppealyInteraction, payload: string | InteractionEditPayload): Promise<void>`
  - `interface InteractionEditPayload { content?: string; embeds?: unknown[]; components?: unknown[] }`

- [ ] **Step 1: Write the failing test**

Create `bot/src/utils/__tests__/interactionResponse.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AppealyBot, AppealyInteraction } from "../../core/client.ts";
import { defer, finish } from "../interactionResponse.ts";

interface Call { name: string; args: unknown[] }

function fakeBot(): { bot: AppealyBot; calls: Call[] } {
  const calls: Call[] = [];
  const bot = {
    helpers: {
      sendInteractionResponse: (...args: unknown[]) => {
        calls.push({ name: "send", args });
        return Promise.resolve();
      },
      editOriginalInteractionResponse: (...args: unknown[]) => {
        calls.push({ name: "edit", args });
        return Promise.resolve();
      },
    },
  } as unknown as AppealyBot;
  return { bot, calls };
}

const interaction = { id: 123n, token: "tok" } as unknown as AppealyInteraction;

Deno.test("defer sends type 5 with the ephemeral flag", async () => {
  const { bot, calls } = fakeBot();
  await defer(bot, interaction, { ephemeral: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "send");
  assertEquals(calls[0].args[0], 123n);
  assertEquals(calls[0].args[1], "tok");
  assertEquals(calls[0].args[2], { type: 5, data: { flags: 64 } });
});

Deno.test("defer without ephemeral carries no flags", async () => {
  const { bot, calls } = fakeBot();
  await defer(bot, interaction);
  assertEquals(calls[0].args[2], { type: 5, data: {} });
});

Deno.test("finish edits the original response with a string", async () => {
  const { bot, calls } = fakeBot();
  await finish(bot, interaction, "done");
  assertEquals(calls[0].name, "edit");
  assertEquals(calls[0].args[0], "tok");
  assertEquals(calls[0].args[1], { content: "done" });
});

Deno.test("finish passes a payload through untouched and adds no flags", async () => {
  const { bot, calls } = fakeBot();
  await finish(bot, interaction, { content: "hi", components: [] });
  assertEquals(calls[0].args[1], { content: "hi", components: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test -c bot/deno.json bot/src/utils/__tests__/interactionResponse.test.ts`
Expected: FAIL — `Module not found ".../interactionResponse.ts"`

- [ ] **Step 3: Write the implementation**

Create `bot/src/utils/interactionResponse.ts`:

```ts
// bot/src/utils/interactionResponse.ts
//
// Discord gives a handler three seconds to make its FIRST response to an
// interaction. Anything slower and the token is dead: every later call
// against it fails with 10062, and the user is shown "This interaction
// failed" even when the work succeeded — which is the worst outcome
// available, because it invites them to click again.
//
// Deferring answers Discord immediately and extends the deadline to fifteen
// minutes. The pattern is: defer, work, finish.
//
// THE ONE THING THAT CANNOT BE DEFERRED
//
// A modal response must be the FIRST response — you cannot defer and then
// open a modal. Handlers that open modals (panelOpen, reviewDeny, verify)
// therefore must not call defer(), and must keep their pre-checks
// cache-backed: a REST call before the modal blows the same three-second
// window with no fix available.

import type { AppealyBot, AppealyInteraction } from "../core/client.ts";

/** Discord's MessageFlags.Ephemeral. */
const EPHEMERAL = 64;

/** InteractionResponseTypes.DeferredChannelMessageWithSource. */
const DEFERRED = 5;

export interface InteractionEditPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

/**
 * Answers Discord immediately so the work below has fifteen minutes.
 *
 * The ephemeral flag is set HERE and cannot be set later: once a deferred
 * response is public, editing it cannot make it private, and the channel is
 * left with a visible "thinking…" from a bot that meant to answer quietly.
 */
export async function defer(
  bot: AppealyBot,
  interaction: AppealyInteraction,
  opts: { ephemeral?: boolean } = {},
): Promise<void> {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: DEFERRED,
    data: opts.ephemeral ? { flags: EPHEMERAL } : {},
  });
}

/**
 * Delivers the result of a deferred interaction.
 *
 * No flags here — see defer(). Passing them would be silently ignored by
 * Discord, which is worse than being rejected.
 */
export async function finish(
  bot: AppealyBot,
  interaction: AppealyInteraction,
  payload: string | InteractionEditPayload,
): Promise<void> {
  const data = typeof payload === "string" ? { content: payload } : payload;
  await bot.helpers.editOriginalInteractionResponse(interaction.token, data);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test -c bot/deno.json bot/src/utils/__tests__/interactionResponse.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/interactionResponse.ts bot/src/utils/__tests__/interactionResponse.test.ts
git commit -m "Add defer/finish helpers for interaction responses"
```

---

### Task 3: The guard test (written to fail)

This is the RED step for Tasks 4–7. It enumerates every handler that must defer and asserts the invariant. It will fail loudly now and go green a handler at a time.

The invariant is deliberately coarse and textual rather than a TypeScript parse: **a converted handler calls `defer(` and never calls `sendInteractionResponse` directly; a modal handler is the exact inverse.** That is checkable without a parser and catches the regression that matters — someone adding handler number 33 the old way.

**Files:**
- Create: `bot/src/interactions/__tests__/deferGuard.test.ts`

**Interfaces:**
- Consumes: `defer` from `bot/src/utils/interactionResponse.ts` (by name, textually).
- Produces: nothing importable. Later tasks make it pass.

- [ ] **Step 1: Write the failing test**

Create `bot/src/interactions/__tests__/deferGuard.test.ts`:

```ts
// bot/src/interactions/__tests__/deferGuard.test.ts
//
// A source-level invariant, not a behavioural test. The interaction flows
// cannot be exercised without Discord, but the property that actually broke
// production is textual and checkable: handlers that do work before
// responding must defer first.
//
// Run from the repository root.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Handlers that await something before they can answer. Every one of these
 * must defer, and must route its responses through the helpers so the
 * ephemeral flag lands on the deferral rather than the edit.
 */
const MUST_DEFER = [
  "bot/src/interactions/buttons/reviewAccept.ts",
  "bot/src/interactions/buttons/ticketOpen.ts",
  "bot/src/interactions/buttons/ticketClose.ts",
  "bot/src/interactions/buttons/giveawayEnter.ts",
  "bot/src/interactions/modals/formSubmit.ts",
  "bot/src/interactions/modals/denyReason.ts",
  "bot/src/interactions/modals/verifyCaptcha.ts",
  "bot/src/interactions/selects/roleMenuSelect.ts",
  "bot/src/interactions/selects/pollVote.ts",
  "bot/src/interactions/selects/formSelectStep.ts",
];

/**
 * Handlers whose first response IS a modal. Deferring here is not a style
 * choice — Discord rejects a modal that follows a deferral, so these must
 * never call defer(), and their pre-checks must stay off the network.
 */
const MUST_NOT_DEFER = [
  "bot/src/interactions/buttons/panelOpen.ts",
  "bot/src/interactions/buttons/reviewDeny.ts",
  "bot/src/interactions/buttons/verify.ts",
];

for (const path of MUST_DEFER) {
  Deno.test(`${path} defers before working`, async () => {
    const src = await Deno.readTextFile(path);
    assert(src.includes("defer("), `${path} must call defer() before doing work`);
    assert(
      !src.includes("sendInteractionResponse"),
      `${path} must respond through finish(), not sendInteractionResponse directly`,
    );
  });
}

for (const path of MUST_NOT_DEFER) {
  Deno.test(`${path} opens a modal and must not defer`, async () => {
    const src = await Deno.readTextFile(path);
    assert(src.includes("type: 9"), `${path} was expected to open a modal`);
    assert(
      !src.includes("defer("),
      `${path} opens a modal; a deferred interaction cannot show one`,
    );
  });
}
```

- [ ] **Step 2: Run it and confirm the shape of the failure**

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts`
Expected: FAIL — all 10 `MUST_DEFER` cases fail with "must call defer() before doing work". The 3 `MUST_NOT_DEFER` cases should already PASS, since no handler defers yet.

- [ ] **Step 3: Commit the failing guard**

Committing a red test deliberately: it is the specification for the next four tasks, and its going green is how they are verified.

```bash
git add bot/src/interactions/__tests__/deferGuard.test.ts
git commit -m "Add a failing guard for handlers that must defer"
```

---

### Task 4: Convert `reviewAccept`

The flagship action, and the one confirmed failing in production: ten to fifteen sequential Discord round trips plus five database queries before it answers at line 352.

**Files:**
- Modify: `bot/src/interactions/buttons/reviewAccept.ts`

**Interfaces:**
- Consumes: `defer`, `finish` from `bot/src/utils/interactionResponse.ts`.
- Produces: nothing.

- [ ] **Step 1: Run the guard to see this file fail**

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts --filter reviewAccept`
Expected: FAIL — "must call defer() before doing work"

- [ ] **Step 2: Add the import and defer first**

Add to the imports at the top of `bot/src/interactions/buttons/reviewAccept.ts`:

```ts
import { defer, finish } from "../../utils/interactionResponse.ts";
```

Insert a deferral as the **first** statement of the handler, before the database query at line 39 — after any pure guard clauses that return without responding, and before the first `await`:

```ts
  // Answer Discord before doing any of it. What follows is ten to fifteen
  // sequential REST calls plus five queries; the three-second window is not
  // close, and the reviewer was being shown "This interaction failed" while
  // the role, the DM and the unban all went through.
  await defer(bot, interaction, { ephemeral: true });
```

- [ ] **Step 3: Replace every response with `finish`**

Replace the local `respond` helper at the bottom of the file:

```ts
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
```

with a delegation, so the call sites do not all have to change:

```ts
// Kept as a one-line wrapper rather than rewriting ~6 call sites: the flag
// now lives on the deferral, so there is nothing left for this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
```

Then replace the two direct early-return calls at lines 120 and 172 — each currently `return bot.helpers.sendInteractionResponse(interaction.id, interaction.token, { type: 4, data: { ... } })` — with `return finish(bot, interaction, { ... })`, dropping the `type` wrapper and moving any `content`/`embeds`/`components` up one level. Remove the now-unused `EPHEMERAL` constant if nothing else references it.

- [ ] **Step 4: Type-check and run the guard**

Run: `deno check -c bot/deno.json bot/src/interactions/buttons/reviewAccept.ts`
Expected: no errors

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts --filter reviewAccept`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bot/src/interactions/buttons/reviewAccept.ts
git commit -m "Defer the review-accept interaction before doing its work"
```

---

### Task 5: Convert the ticket handlers

`ticketOpen` creates a channel and adds a member before responding; `ticketClose` generates a transcript, sends a DM and archives a channel. Both are confirmed failing in the 2026-08-23 logs.

**Files:**
- Modify: `bot/src/interactions/buttons/ticketOpen.ts`
- Modify: `bot/src/interactions/buttons/ticketClose.ts`

**Interfaces:**
- Consumes: `defer`, `finish` from `bot/src/utils/interactionResponse.ts`.
- Produces: nothing.

- [ ] **Step 1: Run the guard to see both fail**

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts --filter ticket`
Expected: FAIL for both files

- [ ] **Step 2: Convert `ticketOpen.ts`**

Replace the whole file body with:

```ts
// bot/src/interactions/buttons/ticketOpen.ts
// Fires when a user clicks a ticket-panel's "Open Ticket" button.

import type { AppealyBot } from "../../core/client.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { openTicket } from "../../services/ticketService.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleTicketOpenButton(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
) {
  const guildId = interaction.guildId;
  const opener = interaction.member?.user ?? interaction.user;
  if (!guildId || !opener) return;

  // openTicket() creates a channel or thread and adds a member — two REST
  // round trips plus several queries. On 2026-08-23 this exceeded the
  // three-second window repeatedly: the ticket was created, and the user was
  // told the interaction failed, so they opened another one.
  await defer(bot, interaction, { ephemeral: true });

  const result = await openTicket(bot, guildId, configId, opener.id, opener.username);

  if (!result.ok) {
    const message =
      result.reason === "max_open_reached"
        ? "You already have an open ticket for this. Please use your existing ticket."
        : result.reason === "config_inactive"
        ? "This ticket type is not currently accepting new tickets."
        : result.reason === "guild_rate_limited"
        ? "This server has reached its daily ticket limit. Please try again tomorrow, or ask staff about raising the limit."
        : "Something went wrong creating your ticket. Please contact staff directly.";
    return finish(bot, interaction, message);
  }

  await finish(bot, interaction, `Your ticket has been created: <#${result.channelId}>`);
}
```

- [ ] **Step 3: Convert `ticketClose.ts`**

Read the file, then apply the same three changes:
1. Add `import { defer, finish } from "../../utils/interactionResponse.ts";`
2. Insert `await defer(bot, interaction, { ephemeral: true });` as the first statement after the pure guard clauses and before the first `await`.
3. Replace every `bot.helpers.sendInteractionResponse(interaction.id, interaction.token, { type: 4, data: { content, flags: 64 } })` with `finish(bot, interaction, content)`, and remove the now-unused ephemeral constant.

- [ ] **Step 4: Type-check and run the guard**

Run: `deno check -c bot/deno.json bot/src/interactions/buttons/ticketOpen.ts bot/src/interactions/buttons/ticketClose.ts`
Expected: no errors

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts --filter ticket`
Expected: PASS for both

- [ ] **Step 5: Commit**

```bash
git add bot/src/interactions/buttons/ticketOpen.ts bot/src/interactions/buttons/ticketClose.ts
git commit -m "Defer the ticket open and close interactions"
```

---

### Task 6: Convert the remaining interaction handlers

Seven files, same three edits each. The modal-submit handlers matter most: they carry the work that the modal-opening handlers could not defer.

**Files:**
- Modify: `bot/src/interactions/modals/formSubmit.ts`
- Modify: `bot/src/interactions/modals/denyReason.ts`
- Modify: `bot/src/interactions/modals/verifyCaptcha.ts`
- Modify: `bot/src/interactions/buttons/giveawayEnter.ts`
- Modify: `bot/src/interactions/selects/roleMenuSelect.ts`
- Modify: `bot/src/interactions/selects/pollVote.ts`
- Modify: `bot/src/interactions/selects/formSelectStep.ts`

**Interfaces:**
- Consumes: `defer`, `finish` from `bot/src/utils/interactionResponse.ts`.
- Produces: nothing.

- [ ] **Step 1: Run the guard to see the remaining failures**

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts`
Expected: FAIL for exactly these seven; `reviewAccept` and both ticket files now PASS.

- [ ] **Step 2: Apply the three edits to each file**

For every file above, in order:

1. Add the import, with the path depth matching the file's directory (`../../utils/interactionResponse.ts` for all seven):

```ts
import { defer, finish } from "../../utils/interactionResponse.ts";
```

2. Insert as the first statement after any pure guard clauses that return without responding, and before the first `await`:

```ts
await defer(bot, interaction, { ephemeral: true });
```

3. Replace each response. A call of the shape:

```ts
await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
  type: 4,
  data: { content: "...", flags: 64 },
});
```

becomes:

```ts
await finish(bot, interaction, "...");
```

and one carrying embeds or components:

```ts
await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
  type: 4,
  data: { embeds: [...], components: [...], flags: 64 },
});
```

becomes:

```ts
await finish(bot, interaction, { embeds: [...], components: [...] });
```

**`formSelectStep.ts` needs care.** A multi-step form advances by showing the *next* modal, and a modal cannot follow a deferral. If the file opens a modal (`type: 9`) on any path, it belongs in `MUST_NOT_DEFER`, not here — move it to that list in the guard test, leave it unconverted, and note in the commit message that its pre-checks must stay cache-backed. Decide by reading the file, not by assuming.

- [ ] **Step 3: Type-check**

Run: `deno check -c bot/deno.json bot/src/interactions/modals/*.ts bot/src/interactions/selects/*.ts bot/src/interactions/buttons/giveawayEnter.ts`
Expected: no errors

- [ ] **Step 4: Run the whole guard**

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts`
Expected: PASS — all 13 cases

- [ ] **Step 5: Commit**

```bash
git add bot/src/interactions
git commit -m "Defer the remaining interaction handlers"
```

---

### Task 7: Convert the slash commands that do work first

Slash commands have the same three-second window. These thirteen do database or REST work before answering.

**Files:**
- Modify: `bot/src/commands/exportData.ts`, `exportApplications.ts`, `panelCreate.ts`, `pollCreate.ts`, `giveaway.ts`, `roleMenu.ts`, `ticketPanel.ts`, `verifySetup.ts`, `antiRaid.ts`, `resetCooldown.ts`, `formList.ts`, `apply.ts`, `botStats.ts`

**Interfaces:**
- Consumes: `defer`, `finish` from `bot/src/utils/interactionResponse.ts` (import path `../utils/interactionResponse.ts` from `bot/src/commands/`).
- Produces: nothing.

- [ ] **Step 1: Confirm which actually need it**

Run: `grep -n "await" bot/src/commands/<file>.ts | head -5` for each file.

A command that responds before its first `await` is already correct and must be left alone — `ping.ts` is the existing example and is not in this list. Convert only files where an `await` precedes the first response.

- [ ] **Step 2: Apply the same three edits**

Identical to Task 6 Step 2, with the import path `../utils/interactionResponse.ts`.

**`apply.ts` needs care** for the same reason as `formSelectStep.ts`: if it opens the application modal directly, it cannot defer. Read it first.

- [ ] **Step 3: Extend the guard to cover the converted commands**

Add each file you converted to the `MUST_DEFER` array in `bot/src/interactions/__tests__/deferGuard.test.ts`, and any that open a modal to `MUST_NOT_DEFER`.

- [ ] **Step 4: Type-check and run the guard**

Run: `deno check -c bot/deno.json bot/src/commands/*.ts`
Expected: no errors

Run: `deno test --allow-read -c bot/deno.json bot/src/interactions/__tests__/deferGuard.test.ts`
Expected: PASS — every case

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands bot/src/interactions/__tests__/deferGuard.test.ts
git commit -m "Defer the slash commands that work before answering"
```

---

### Task 8: Report real errors at the call sites that were lying

**Files:**
- Modify: `bot/src/services/ticketService.ts:187`
- Modify: `bot/src/services/ticketRatingService.ts:49`
- Modify: `bot/src/events/interactionCreate.ts` (the `Unhandled error in interactionCreate` handler)

**Interfaces:**
- Consumes: `describeDiscordError`, `isUnknownInteraction` from `bot/src/utils/discordError.ts`.
- Produces: nothing.

- [ ] **Step 1: Replace the stringified errors**

In each file, add:

```ts
import { describeDiscordError, isUnknownInteraction } from "../utils/discordError.ts";
```

(`../../utils/discordError.ts` from `bot/src/events/`.)

Then replace `error: String(err)` in the three log calls with the described form. For `ticketRatingService.ts:49`, which currently assumes every failure means closed DMs:

```ts
  } catch (err) {
    // Was a blanket "DMs are closed" assumption. The 2026-08-23 logs show it
    // also swallowed genuine API failures, which is how three broken tickets
    // looked identical to three users with strict privacy settings.
    const info = describeDiscordError(err);
    const dmsClosed = info.code === 50007;
    logger.warn(
      dmsClosed
        ? "Ticket rating prompt not sent: recipient has DMs closed"
        : "Failed to send ticket rating prompt",
      { ticketId, status: info.status, code: info.code, detail: info.message },
    );
  }
```

- [ ] **Step 2: Make expired interactions name themselves**

In `bot/src/events/interactionCreate.ts`, in the catch that logs `Unhandled error in interactionCreate`:

```ts
    const info = describeDiscordError(err);
    if (isUnknownInteraction(info)) {
      // Not a Discord outage and not retryable: the handler took longer than
      // three seconds to make its first response, so the token was already
      // gone. The fix is always to defer — see utils/interactionResponse.ts.
      logger.error("Interaction expired before the handler responded (handler exceeded the 3-second window)", {
        customId, status: info.status, code: info.code,
      });
    } else {
      logger.error("Unhandled error in interactionCreate", {
        customId, status: info.status, code: info.code, detail: info.message, raw: info.raw,
      });
    }
```

Use whatever identifier for the interaction is already in scope at that call site in place of `customId`.

- [ ] **Step 3: Type-check**

Run: `deno check -c bot/deno.json bot/src/services/ticketService.ts bot/src/services/ticketRatingService.ts bot/src/events/interactionCreate.ts`
Expected: no errors

- [ ] **Step 4: Confirm the unit tests still pass**

Run: `deno test -c bot/deno.json bot/src/utils/__tests__/`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/ticketService.ts bot/src/services/ticketRatingService.ts bot/src/events/interactionCreate.ts
git commit -m "Log what Discord actually said, and name expired interactions"
```

---

### Task 9: Cache invalidation over the control server

`appealy-redis-url` contains the literal string `memory`, so `invalidateGuildCache` publishes into a per-process shim and the bot never hears it. An admin edits a form and the bot serves the old one until the TTL expires.

Memorystore would fix it for roughly $420/year (`terraform/outputs.tf`: ~$26/month plus ~$9/month for the VPC connector). The API and bot are containers in one Cloud Run instance with an authenticated channel already between them, so this rides that instead. There is direct precedent: `requestLockdownClear` in `botBridge.ts` exists for exactly this class of bug.

**Files:**
- Modify: `bot/src/core/banCache.ts` (extract the subscriber's apply step)
- Modify: `bot/src/core/controlServer.ts` (two new routes)
- Modify: `api/src/services/botBridge.ts` (two new callers)
- Modify: `api/src/services/cacheInvalidation.ts` (fall back to the bridge)
- Modify: `api/src/middleware/banGate.ts:96-98` (same)

**Interfaces:**
- Consumes: `invalidateGuild(guildId: bigint | string): Promise<void>` from `bot/src/core/guildConfigCache.ts`; `useMemoryRedis(url: string): boolean` from `shared/lib/memoryRedis.ts`.
- Produces:
  - `applyBanChange(msg: { op: "add" | "remove"; ban: PublicBan }): void` exported from `bot/src/core/banCache.ts`
  - `requestCacheInvalidate(guildId: string): Promise<unknown>` from `api/src/services/botBridge.ts`
  - `requestBanChange(op: "add" | "remove", ban: PublicBan): Promise<unknown>` from `api/src/services/botBridge.ts`
  - Bot routes `POST /internal/cache/invalidate` and `POST /internal/cache/ban`

- [ ] **Step 1: Extract the ban-apply step so both paths share it**

In `bot/src/core/banCache.ts`, the subscriber at lines 130–132 does the map mutation inline. Lift it:

```ts
/**
 * Applies one ban change to the in-process map.
 *
 * Shared by the Redis subscriber and the control-server route so the two
 * delivery mechanisms cannot drift — the bug that would produce is a ban
 * that applies over one transport and not the other.
 */
export function applyBanChange(msg: { op: "add" | "remove"; ban: PublicBan }): void {
  if (msg.op === "add") map.set(msg.ban.subjectId, msg.ban);
  else map.delete(msg.ban.subjectId);
}
```

Then have the subscriber call `applyBanChange(msg)` instead of mutating directly. Match the surrounding code's actual variable name for the map.

- [ ] **Step 2: Add the two control-server routes**

In `bot/src/core/controlServer.ts`, add these alongside the existing routes, and add the imports (`invalidateGuild` from `./guildConfigCache.ts`, `applyBanChange` from `./banCache.ts`):

```ts
      // Cache invalidation, for deployments without a real Redis.
      //
      // With REDIS_URL set to the memory substitute the API's publish goes
      // into its own process and the bot never hears it, so an admin saves a
      // form and the bot serves the old one until the TTL expires. The API
      // and bot share one Cloud Run instance and this authenticated channel,
      // so it carries the message for free — Memorystore plus the VPC
      // connector it needs is about $420 a year, which is not yet worth
      // paying to fix this.
      if (url.pathname === "/internal/cache/invalidate" && req.method === "POST") {
        const { guildId } = await req.json();
        await invalidateGuild(guildId);
        return Response.json({ status: "invalidated" });
      }

      if (url.pathname === "/internal/cache/ban" && req.method === "POST") {
        const msg = await req.json();
        applyBanChange(msg);
        return Response.json({ status: "applied" });
      }
```

- [ ] **Step 3: Add the bridge callers**

In `api/src/services/botBridge.ts`, alongside `requestLockdownClear`:

```ts
/**
 * Tells the bot to drop its cached config for a guild.
 *
 * Used only when REDIS_URL is the in-memory substitute, where the pub/sub
 * path cannot cross processes. See cacheInvalidation.ts.
 */
export function requestCacheInvalidate(guildId: string) {
  return callBot("/internal/cache/invalidate", { guildId });
}

/** Same, for a ban add or removal. */
export function requestBanChange(op: "add" | "remove", ban: unknown) {
  return callBot("/internal/cache/ban", { op, ban });
}
```

- [ ] **Step 4: Choose the transport at the call sites**

In `api/src/services/cacheInvalidation.ts`, add the imports and replace the body of `invalidateGuildCache`:

```ts
import { useMemoryRedis } from "../../../shared/lib/memoryRedis.ts";
import { env } from "../config/env.ts";
import { requestCacheInvalidate } from "./botBridge.ts";
```

```ts
export async function invalidateGuildCache(guildId: string | bigint): Promise<void> {
  // Without a real Redis the publish below reaches only this process, so the
  // bot is told directly over the internal control server instead.
  if (useMemoryRedis(env.REDIS_URL)) {
    await requestCacheInvalidate(guildId.toString()).catch(() => {});
    return;
  }
  await withRedis(
    (r) => r.publish(INVALIDATION_CHANNEL, JSON.stringify({ guildId: guildId.toString() })),
    0,
  );
}
```

Match the existing import path and export name for `env` used elsewhere in `api/src`.

Apply the same shape to `publishBanChange` in `api/src/middleware/banGate.ts`, keeping the existing `redis.del(...)` call in both branches.

The `.catch(() => {})` is deliberate and matches the documented contract above the function: a failed invalidation must never fail a write that already succeeded.

- [ ] **Step 5: Verify both processes still type-check and build**

Run: `deno check -c bot/deno.json bot/src/core/controlServer.ts bot/src/core/banCache.ts`
Expected: no errors

Run: `cd api && npm run build`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add bot/src/core/controlServer.ts bot/src/core/banCache.ts api/src/services/botBridge.ts api/src/services/cacheInvalidation.ts api/src/middleware/banGate.ts
git commit -m "Invalidate caches over the control server instead of buying Memorystore"
```

---

### Task 10: Correct the advertised price

The site advertises dedicated hosting at $10/year; `shared/schema/pricing.ts:224` charges $30. The JSON-LD entries matter more than the visible card, because search engines ingest them into rich results.

**Files:**
- Modify: `site/pricing.html:94`, `site/pricing.html:310`
- Modify: `site/index.html:90`
- Modify: `bot/src/core/dedicatedRunner.ts:9,16`

**Interfaces:**
- Consumes: `CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR` from `shared/schema/pricing.ts` (as the source of truth, by reference — the HTML is static and cannot import it).
- Produces: nothing.

- [ ] **Step 1: Confirm the figure before changing anything**

Run: `grep -n "CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR" shared/schema/pricing.ts`
Expected: `3_000` — i.e. $30.00/year. If it is not 3000, stop and ask; the site may be right and the code wrong.

- [ ] **Step 2: Fix the two JSON-LD offers**

In `site/pricing.html` around line 94 and `site/index.html` around line 90, both inside the `"name": "Dedicated hosted instance"` offer:

```json
      "price": "30.00",
```

- [ ] **Step 3: Fix the visible card and say why it is cheap**

In `site/pricing.html` around line 310, replace `$10/year` with `$30/year`, and add one sentence beneath the existing description:

```html
<p>$2.50 a month, for a bot running under your own token, name and avatar that
you don&rsquo;t operate. The cheapest VPS you could rent to run it yourself is
about $60 a year &mdash; and then you run it.</p>
```

- [ ] **Step 4: Fix the stale comment**

In `bot/src/core/dedicatedRunner.ts`, lines 9 and 16 still argue from $10 revenue. Update both to $30 and recheck the arithmetic in the surrounding paragraph so the comment's conclusion still follows from its numbers.

- [ ] **Step 5: Confirm no $10 references remain**

Run: `grep -rn '\$10/year\|"10.00"' site/ bot/src/core/dedicatedRunner.ts`
Expected: no matches

- [ ] **Step 6: Commit**

```bash
git add site/pricing.html site/index.html bot/src/core/dedicatedRunner.ts
git commit -m "Advertise the price we actually charge"
```

---

### Task 11: Stop the status publisher lying about itself

Every boot logs `Status publisher started` and then `Status publishing disabled: cannot write to the output directory` — `/srv/status` is not writable and Deno raises `NotCapable`.

**Files:**
- Modify: `deploy/service.yaml` (bot container env)
- Modify: `bot/deno.json` (the `start` task's permissions)
- Modify: whichever file logs `Status publisher started` (find with grep)

**Interfaces:**
- Consumes: `STATUS_OUT_DIR` environment variable.
- Produces: nothing.

- [ ] **Step 1: Find the publisher and see what it needs**

Run: `grep -rn "Status publisher started\|STATUS_OUT_DIR" --include=*.ts bot/src`

- [ ] **Step 2: Decide, and record the decision in the code**

Nothing currently consumes the file — `status/` is a static page and there is no volume mounted at `/srv/status`. So the honest fix is to make the publisher opt-in rather than default-on-and-failing:

Change the startup check so that when `STATUS_OUT_DIR` is unset the publisher logs nothing and does not start, and when it is set but unwritable it logs the existing warning once. Do not log `Status publisher started` before the writability check — announcing a service and then immediately warning it is disabled is what makes the logs untrustworthy.

- [ ] **Step 3: Give it a writable path in production**

In `deploy/service.yaml`, in the bot container's `env` block, add:

```yaml
            # Cloud Run gives every container a writable /tmp. /srv/status is
            # baked into the image read-only, which is why the publisher has
            # warned on every boot since the first deploy.
            - name: STATUS_OUT_DIR
              value: "/tmp/status"
```

and add `--allow-write=/tmp/status` to the `start` task in `bot/deno.json`, scoped to that path rather than granting blanket write.

- [ ] **Step 4: Verify locally**

Run: `deno check -c bot/deno.json bot/src/main.ts`
Expected: no errors

Run: `python scripts/render-service.py` with the same environment the workflow uses, and confirm the rendered spec contains `STATUS_OUT_DIR` and no unsubstituted placeholders.

- [ ] **Step 5: Commit**

```bash
git add deploy/service.yaml bot/deno.json bot/src
git commit -m "Give the status publisher a writable path, or let it stay quiet"
```

---

## Verification before calling Phase 0 done

Automated tests do not cover the interaction flows — nothing can, without Discord. After deploying, exercise these on the live server and confirm the logs are clean:

- [ ] Open a ticket from a panel button. Expect the ephemeral reply, no "This interaction failed".
- [ ] Accept an application. Expect the role granted, the DM sent, and a reply — not a failure notice over successful work.
- [ ] Close a ticket with transcripts enabled. Expect the transcript posted and the rating DM delivered.
- [ ] Open the application modal from a panel. Expect the modal — this is the path that must NOT have been deferred.
- [ ] Edit a form in the dashboard, then immediately use it in Discord. Expect the new version, not the old one.

Then confirm no expired interactions in the last hour:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="appealy" AND labels.container_name="bot" AND jsonPayload.msg:"Interaction expired"' \
  --project=yahav-project-505809 --freshness=1h --limit=10
```

Expected: no entries.
