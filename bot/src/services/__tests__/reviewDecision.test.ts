// bot/src/services/__tests__/reviewDecision.test.ts
//
// Source-level guards, like deferGuard.test.ts: deciding an application needs
// Discord and a database, but the two properties that matter are checkable in
// the text. Run from the repository root.
//
// 1. One copy. Accepting and denying happen in services/reviewDecision.ts,
//    called by the Discord buttons and by the dashboard. A second copy is how
//    the two would drift: roles given from one place and not the other.
// 2. Claimed once. The status only moves away from pending in an update that
//    requires it to still be pending, so a reviewer in Discord and one on the
//    dashboard can't both hand out roles and DMs for the same application.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (path: string) => Deno.readTextFileSync(path);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory && entry.name !== "__tests__") out.push(...tsFiles(path));
    else if (entry.isFile && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

Deno.test("only reviewDecision.ts accepts an application", () => {
  const writers = tsFiles("bot/src").filter((f) => /status:\s*"accepted"/.test(read(f)));
  assertEquals(writers, ["bot/src/services/reviewDecision.ts"]);
});

Deno.test("only reviewDecision.ts denies an application, apart from auto-deny when someone leaves", () => {
  const writers = tsFiles("bot/src").filter((f) => /status:\s*"denied"/.test(read(f))).sort();
  assertEquals(writers, ["bot/src/events/guildMemberRemove.ts", "bot/src/services/reviewDecision.ts"]);
});

Deno.test("a decision only applies to an application that is still pending", () => {
  const src = read("bot/src/services/reviewDecision.ts");
  const claim = src.slice(src.indexOf("async function claim("), src.indexOf("async function resolveOutcome("));
  assert(claim.includes('eq(schema.submissions.status, "pending")'), "claim() must require status = pending");
  assert(claim.includes("returning"), "claim() must report whether it updated anything");
  // Both decisions claim before any role, DM or post.
  for (const fn of ["acceptSubmission", "denySubmission"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}(`));
    const claimAt = body.indexOf("await claim(");
    assert(claimAt > 0, `${fn} must claim`);
    for (const effect of ["applyRoles(", "announce(", "unbanMember("]) {
      const at = body.indexOf(effect);
      if (at > 0 && at < body.indexOf("\nexport ", 1)) assert(at > claimAt, `${fn}: ${effect} must come after the claim`);
    }
  }
});

Deno.test("the Discord buttons go through the shared decision", () => {
  assert(read("bot/src/interactions/buttons/reviewAccept.ts").includes("acceptSubmission("));
  assert(read("bot/src/interactions/modals/denyReason.ts").includes("denySubmission("));
});
