// bot/src/services/__tests__/gateCheck.test.ts
//
// Source-level guards, in the style of deferGuard.test.ts: the gate queries
// need a database to run, but the two ways this broke before are textual.
//
// 1. The gate inputs were built in two places and drifted: the DM copy passed
//    submissionsInWindow: 0, so the per-period limit never applied to DM forms
//    or web appeals. Now only services/gateCheck.ts may call evaluateGate.
// 2. A /reset-cooldown pass is one-time, so every place that saves a
//    submission must use it up.
//
// Run from the repository root.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gateReasonToMessage } from "../../../../shared/schema/gating.ts";

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name !== "__tests__") yield* tsFiles(path);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

Deno.test("only services/gateCheck.ts builds gate inputs", async () => {
  const callers: string[] = [];
  for await (const path of tsFiles("bot/src")) {
    if ((await Deno.readTextFile(path)).includes("evaluateGate(")) callers.push(path);
  }
  assert(
    callers.length === 1 && callers[0] === "bot/src/services/gateCheck.ts",
    `evaluateGate must only be called from bot/src/services/gateCheck.ts, found: ${callers.join(", ")}`,
  );
});

Deno.test("the shared gate check counts the per-period window", async () => {
  const src = await Deno.readTextFile("bot/src/services/gateCheck.ts");
  assert(src.includes("submissionsInWindow: windowCount"), "gateCheck.ts must pass the real window count");
  assert(!/submissionsInWindow:\s*0\b/.test(src), "a hardcoded window count of 0 switches the limit off");
});

Deno.test("every place that saves a submission uses up a /reset-cooldown pass", async () => {
  const savers: string[] = [];
  for await (const path of tsFiles("bot/src")) {
    const src = await Deno.readTextFile(path);
    if (src.includes("insert(schema.submissions)")) {
      savers.push(path);
      assert(src.includes("consumeGateOverride("), `${path} saves a submission but never calls consumeGateOverride`);
    }
  }
  assert(savers.length >= 2, `expected the in-server and DM save paths, found: ${savers.join(", ")}`);
});

Deno.test("max_total_reached speaks to the applicant, not as if the form closed", () => {
  const message = gateReasonToMessage({ allowed: false, reason: "max_total_reached" });
  assert(!message.includes("closed"), message);
  assert(message.startsWith("You"), message);
});
