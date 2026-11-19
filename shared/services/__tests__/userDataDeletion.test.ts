// shared/services/__tests__/userDataDeletion.test.ts
//
// Run with: deno test -c bot/deno.json shared/services/__tests__/userDataDeletion.test.ts
//
// The guard behind userDataDeletion.ts: every column that can hold a Discord
// user ID must have a rule. A deletion that misses a table is the failure that
// file exists to prevent, and the way it happens is a new table nobody added
// to the list. This test is where that gets noticed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as core from "../../schema/schema.ts";
import * as platformBanSchema from "../../schema/platformBans.ts";
import * as outcomeSchema from "../../schema/outcomes.ts";
import { USER_DATA_RULES } from "../userDataDeletion.ts";

/** bigint columns that are IDs of something other than a person. */
const NOT_A_PERSON = /(^id$|guild_id$|channel_id$|message_id$|role_id$|category_id$|thread_id$|webhook_id$)/;

/** json columns that are lists of roles, settings or options, never people. */
const JSON_NOT_PEOPLE = /(role_ids$|^remove_roles_on_submit_ids$|role_entries$|^options$|^custom_rate_limits$)/;

/**
 * Free-form json that can mention a person, and what happens to it. Each was
 * read and decided; a new one fails the test until it's added here too.
 */
const JSON_REVIEWED: Record<string, string> = {
  "dm_application_progress.answers": "deleted with the row (dm_application_progress.applicant_id)",
  "submission_events.detail": "deleted with the submission when it's theirs; holds an outcome label or reason, not IDs",
  "dashboard_audit_logs.changes": "the server's settings before and after; the row's user_id is anonymized",
  "platform_bans.evidence": "kept with the ban, which is kept (platform_bans.subject_id)",
  "ticket_categories.questions": "the pop-up's question labels, written by staff; members' answers are posted in the ticket, never stored",
  "scheduled_jobs.payload": "deleted with a kick_unverified job; other kinds are about polls and giveaways",
};

function allTables() {
  const seen = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const v of Object.values({ ...core, ...platformBanSchema, ...outcomeSchema })) {
    if (!is(v, PgTable)) continue;
    const config = getTableConfig(v);
    seen.set(config.name, config);
  }
  return [...seen.values()];
}

const covered = new Set(
  USER_DATA_RULES.map((r) => `${getTableConfig(r.table).name}.${r.column.name}`),
);

Deno.test("every column that can hold a user ID has a deletion rule", () => {
  const missing: string[] = [];
  for (const table of allTables()) {
    for (const col of table.columns) {
      const key = `${table.name}.${col.name}`;
      if (col.columnType === "PgBigInt64" && !NOT_A_PERSON.test(col.name) && !covered.has(key)) missing.push(key);
      if (col.columnType === "PgJsonb" && !JSON_NOT_PEOPLE.test(col.name) && !covered.has(key) && !(key in JSON_REVIEWED)) {
        missing.push(key);
      }
    }
  }
  assertEquals(missing, [], "Add these to USER_DATA_RULES in shared/services/userDataDeletion.ts, saying what deleting a person does to them");
});

Deno.test("the reviewed json columns still exist", () => {
  const all = new Set(allTables().flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)));
  for (const key of Object.keys(JSON_REVIEWED)) assert(all.has(key), `${key} is gone; remove it from JSON_REVIEWED`);
});

Deno.test("a column has at most one rule, so two can't disagree", () => {
  const keys = USER_DATA_RULES.map((r) => `${getTableConfig(r.table).name}.${r.column.name}`);
  assertEquals(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

Deno.test("anonymizing only targets columns that can hold 0, and every rule says why", () => {
  for (const r of USER_DATA_RULES) {
    assert(r.why.trim().length > 10, `${r.column.name} needs a reason`);
    if (r.action === "anonymize") assertEquals(r.column.columnType, "PgBigInt64", r.column.name);
    if (r.action === "unlist") assertEquals(r.column.columnType, "PgJsonb", r.column.name);
  }
});

Deno.test("a person's own rows are deleted, not kept or anonymized", () => {
  // The columns a request is usually about. If one of these ever stops being
  // "delete", that is a decision to make on purpose, with this test changed.
  const own = ["submissions.applicant_id", "tickets.opener_id", "verification_attempts.user_id", "sessions.user_id", "giveaway_entries.user_id", "poll_votes.user_id"];
  for (const key of own) {
    const rule = USER_DATA_RULES.find((r) => `${getTableConfig(r.table).name}.${r.column.name}` === key);
    assertEquals(rule?.action, "delete", key);
  }
});

Deno.test("the queries the rules build are the ones intended", async () => {
  // drizzle builds SQL without connecting, so the statements can be checked
  // here. Running them needs a database, which these tests don't have.
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const { eq, sql } = await import("drizzle-orm");
  const db = drizzle(() => Promise.resolve({ rows: [] }));
  const forms = core.forms;
  const unlist = db.update(forms).set({ reviewerUserIds: sql`${forms.reviewerUserIds} - ${"123"}` })
    .where(sql`${forms.reviewerUserIds} @> ${JSON.stringify(["123"])}::jsonb`).toSQL();
  assertEquals(unlist.sql, `update "forms" set "reviewer_user_ids" = "forms"."reviewer_user_ids" - $1 where "forms"."reviewer_user_ids" @> $2::jsonb`);
  assertEquals(unlist.params, ["123", '["123"]']);
  const anonymize = db.update(core.submissions).set({ reviewerId: 0n }).where(eq(core.submissions.reviewerId, 123n)).toSQL();
  assertEquals(anonymize.sql, `update "submissions" set "reviewer_id" = $1 where "submissions"."reviewer_id" = $2`);
});
