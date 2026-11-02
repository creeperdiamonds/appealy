// shared/lib/__tests__/sharedLoader.test.ts
//
// The form editor mounts six role pickers at once. Production's logs had every
// failed role list in a burst of five to seven requests from one server, and none
// in any smaller burst.

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import { sharedLoader } from "../sharedLoader.ts";

Deno.test("callers asking at the same moment share one request", async () => {
  let requests = 0;
  const load = sharedLoader(async (key: string) => {
    requests++;
    return `roles of ${key}`;
  });

  const results = await Promise.all(Array.from({ length: 6 }, () => load("guild")));

  assertEquals(requests, 1);
  assertEquals(results, Array(6).fill("roles of guild"));
});

Deno.test("different keys get their own request", async () => {
  const asked: string[] = [];
  const load = sharedLoader(async (key: string) => {
    asked.push(key);
    return key;
  });

  assertEquals(await Promise.all([load("one"), load("two")]), ["one", "two"]);
  assertEquals(asked, ["one", "two"]);
});

Deno.test("nothing is kept once it's answered, so the next caller gets fresh data", async () => {
  let requests = 0;
  const load = sharedLoader(async () => ++requests);

  assertEquals(await load("guild"), 1);
  assertEquals(await load("guild"), 2);
});

Deno.test("a failure is retried quietly, and callers only see the answer", async () => {
  using time = new FakeTime();
  let requests = 0;
  const load = sharedLoader(async () => {
    if (++requests < 3) throw new Error("the bot was slow");
    return "roles";
  }, [2_000, 4_000]);

  const answer = load("guild");
  await time.tickAsync(0);
  assertEquals(requests, 1);
  await time.tickAsync(1_999);
  assertEquals(requests, 1);
  await time.tickAsync(1);
  assertEquals(requests, 2);
  await time.tickAsync(4_000);
  assertEquals(requests, 3);

  assertEquals(await answer, "roles");
});

Deno.test("a caller who arrives during the retries joins them", async () => {
  using time = new FakeTime();
  let requests = 0;
  const load = sharedLoader(async () => {
    if (++requests < 2) throw new Error("the bot was slow");
    return "roles";
  }, [2_000]);

  const first = load("guild");
  await time.tickAsync(1_000);
  const second = load("guild");
  await time.tickAsync(1_000);

  assertEquals(await Promise.all([first, second]), ["roles", "roles"]);
  assertEquals(requests, 2);
});

Deno.test("once the retries run out everyone is told, and the next caller starts again", async () => {
  using time = new FakeTime();
  let requests = 0;
  let down = true;
  const load = sharedLoader(async () => {
    requests++;
    if (down) throw new Error("the bot is down");
    return "roles";
  }, [2_000]);

  const first = load("guild");
  const second = load("guild");
  const failed = Promise.all([
    assertRejects(() => first, Error, "the bot is down"),
    assertRejects(() => second, Error, "the bot is down"),
  ]);
  await time.tickAsync(2_000);
  await failed;
  assertEquals(requests, 2);

  down = false;
  const again = load("guild");
  await time.tickAsync(0);
  assertEquals(await again, "roles");
  assertEquals(requests, 3);
});
