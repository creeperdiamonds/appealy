import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MissingIntentsError, requirePrivilegedIntents } from "../privilegedIntents.ts";

/** Answers GET /applications/@me with the given flags (or status) for the duration of fn. */
async function withApplication(response: { flags?: number; status?: number }, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "123", flags: response.flags ?? 0 }), { status: response.status ?? 200 }),
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("both switches off names both intents and links the Bot page", async () => {
  await withApplication({ flags: 0 }, async () => {
    const err = await assertRejects(() => requirePrivilegedIntents("t"), MissingIntentsError);
    assertEquals(err.missing, ["Server Members Intent", "Message Content Intent"]);
    assertEquals(err.message.includes("https://discord.com/developers/applications/123/bot"), true);
  });
});

Deno.test("an unverified bot under 100 servers passes on the _LIMITED flags", async () => {
  await withApplication({ flags: (1 << 15) | (1 << 19) }, () => requirePrivilegedIntents("t"));
});

Deno.test("a verified bot passes on the approved flags", async () => {
  await withApplication({ flags: (1 << 14) | (1 << 18) }, () => requirePrivilegedIntents("t"));
});

Deno.test("only Message Content off names only that one", async () => {
  await withApplication({ flags: 1 << 15 }, async () => {
    const err = await assertRejects(() => requirePrivilegedIntents("t"), MissingIntentsError);
    assertEquals(err.missing, ["Message Content Intent"]);
  });
});

Deno.test("a failed check does not block startup", async () => {
  await withApplication({ status: 401 }, () => requirePrivilegedIntents("t"));
});
