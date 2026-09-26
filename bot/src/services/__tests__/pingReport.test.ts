// bot/src/services/__tests__/pingReport.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/pingReport.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pingReport, snowflakeTime } from "../pingReport.ts";

Deno.test("an id's creation time is read the way Discord documents it", () => {
  // The example in Discord's reference: 175928847299117063 was created at
  // 2016-04-30 11:18:25.796 UTC.
  assertEquals(snowflakeTime(175928847299117063n), Date.UTC(2016, 3, 30, 11, 18, 25, 796));
});

Deno.test("each part of the time is shown, with the total of the three", () => {
  const text = pingReport({ toBot: 74, own: 1, toDiscord: 245, network: 25, database: 3, heartbeat: 41 }, false);
  assert(text.includes("Discord → Appealy: **74 ms**, your command reaching the bot"));
  assert(text.includes("↳ network: **25 ms** · Discord's side: **about 220 ms**"));
  assert(text.includes("Appealy on its own: **1 ms**, working out the reply"));
  assert(text.includes("Appealy → Discord: **245 ms**, Discord accepting the reply"));
  assert(text.includes("Total: **320 ms**"));
  assert(text.includes("Database: **3 ms** · Connection to Discord: **41 ms**"));
});

Deno.test("clocks that disagree never show negative time", () => {
  const text = pingReport({ toBot: -6, own: 0.4, toDiscord: 245.6, network: 300, database: 3, heartbeat: 41 }, false);
  assert(text.includes("Discord's side: **about 0 ms**"), "a network reading above the reply's isn't negative");
  assert(text.includes("Discord → Appealy: **0 ms**"));
  assert(text.includes("Appealy on its own: **0 ms**"));
  assert(text.includes("Total: **246 ms**"));
});

Deno.test("a database or heartbeat that couldn't be measured says so", () => {
  const text = pingReport({ toBot: 70, own: 1, toDiscord: 240, network: null, database: null, heartbeat: null }, false);
  assert(text.includes("Database: unavailable · Connection to Discord: not measured yet"));
  assert(!text.includes("↳"), "no split without a network reading");
});

Deno.test("Japanese", () => {
  const text = pingReport({ toBot: 74, own: 1, toDiscord: 245, network: 25, database: 3, heartbeat: null }, true);
  assert(text.includes("↳ 通信: **25 ms** · Discord 側: **約 220 ms**"));
  assert(text.includes("かかった時間の内訳"));
  assert(text.includes("Appealy の処理: **1 ms**（返信を用意するまで。Discord は関係なし）"));
  assert(text.includes("合計: **320 ms**"));
  assert(text.includes("Discord との接続: まだ計測されていません"));
});
