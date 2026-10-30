// scripts/sim/seed.ts
//
// Creates the schema from db/migrations and fills it with what the simulated
// servers have set up. Only ever given the throwaway database run.ts starts,
// and it refuses anything that isn't on this machine.

import postgres from "postgres";
import { encryptWithKey } from "../../shared/lib/tokenCrypto.ts";
import { buildWorld, DASHBOARD_USER_BASE, MEMBER_USER_BASE } from "./world.ts";

export const SESSION_COUNT = 5;
const HISTORY_PER_GUILD = 5;

export const sessionId = (i: number) => `00000000-0000-4000-9000-${i.toString(16).padStart(12, "0")}`;

export async function migrate(databaseUrl: string, repo: string) {
  assertLocal(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const journal = JSON.parse(await Deno.readTextFile(`${repo}/db/migrations/meta/_journal.json`));
  for (const entry of journal.entries) {
    const text = await Deno.readTextFile(`${repo}/db/migrations/${entry.tag}.sql`);
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await sql.unsafe(statement);
    }
  }
  await sql.end();
}

function assertLocal(databaseUrl: string) {
  const host = new URL(databaseUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to seed a database on ${host}: the simulator only touches its own.`);
  }
}

export async function seed(databaseUrl: string, guildCount: number, tokenKey: string) {
  assertLocal(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const world = buildWorld(guildCount);
  const caps = {
    submissionsPerDay: 100000,
    ticketsPerDay: 100000,
    giveawayEntriesPerDay: 100000,
    apiRequestsPerMinute: 100000,
    formsPerGuild: 100,
    panelsPerGuild: 100,
    historyRetentionDays: 365,
    rolesPerRuleType: 25,
    questionsPerForm: 25,
  };

  for (const g of world) {
    // Custom caps so the simulator measures the work, not the daily limit.
    await sql`insert into guilds (id, name, owner_id, rate_limit_tier, custom_rate_limits)
      values (${g.id.toString()}, ${g.name}, ${g.ownerId.toString()}, 'custom', ${sql.json(caps)})`;

    await sql`insert into forms (id, guild_id, name, description, log_channel_id, grant_role_ids, thread_collab_enabled, allow_multiple_pending)
      values (${g.formId}, ${g.id.toString()}, 'Staff Application', 'Tell us about yourself.', ${g.ch.log.toString()},
              ${sql.json([g.role.staff.toString()])}, true, true)`;
    for (const [i, q] of g.questionIds.entries()) {
      await sql`insert into questions (id, form_id, label, type, required, sort_order)
        values (${q}, ${g.formId}, ${`Question ${i + 1}`}, ${i === 0 ? "short_text" : "paragraph"}, true, ${i})`;
    }
    await sql`insert into panels (id, guild_id, channel_id, message_id, title, published)
      values (${g.panelId}, ${g.id.toString()}, ${g.ch.panel.toString()}, ${(g.ch.panel + 1000000n).toString()}, 'Apply here', true)`;
    await sql`insert into panel_buttons (id, panel_id, form_id, label) values (${crypto.randomUUID()}, ${g.panelId}, ${g.formId}, 'Apply')`;

    if (g.has.tickets) {
      await sql`insert into ticket_configs (id, guild_id, name, channel_id, category_id, channel_type, support_role_ids, transcript_channel_id, transcript_on_close)
        values (${g.ticketConfigId}, ${g.id.toString()}, 'Support', ${g.ch.panel.toString()}, ${g.ch.category.toString()}, 'private_channel',
                ${sql.json([g.role.staff.toString()])}, ${g.ch.transcript.toString()}, true)`;
    }
    if (g.has.welcomer) {
      await sql`insert into welcomer_configs (guild_id, join_enabled, join_channel_id, auto_role_ids, leave_enabled, leave_channel_id)
        values (${g.id.toString()}, true, ${g.ch.welcome.toString()}, ${sql.json([g.role.member.toString()])}, true, ${g.ch.welcome.toString()})`;
    }
    if (g.has.verification) {
      await sql`insert into verification_configs (guild_id, enabled, channel_id, message_id, method, verified_role_id, unverified_role_id)
        values (${g.id.toString()}, true, ${g.ch.panel.toString()}, ${(g.ch.panel + 1000001n).toString()}, 'button', ${g.role.verified.toString()}, ${g.role.unverified.toString()})`;
    }
    if (g.has.antiRaid) {
      await sql`insert into anti_raid_configs (guild_id, enabled, join_threshold, window_seconds, action, alert_channel_id)
        values (${g.id.toString()}, true, 50, 60, 'alert_only', ${g.ch.general.toString()})`;
    }
    if (g.has.sticky) {
      await sql`insert into sticky_messages (id, guild_id, channel_id, content, repost_after_messages, active)
        values (${crypto.randomUUID()}, ${g.id.toString()}, ${g.ch.sticky.toString()}, 'Please read the rules before posting.', 5, true)`;
    }
    if (g.has.roleMenu) {
      await sql`insert into role_menus (id, guild_id, channel_id, message_id, title, published)
        values (${g.roleMenuId}, ${g.id.toString()}, ${g.ch.panel.toString()}, ${(g.ch.panel + 1000002n).toString()}, 'Choose your roles', true)`;
      await sql`insert into role_menu_options (id, menu_id, role_id, label) values
        (${crypto.randomUUID()}, ${g.roleMenuId}, ${g.role.menuA.toString()}, 'A'), (${crypto.randomUUID()}, ${g.roleMenuId}, ${g.role.menuB.toString()}, 'B')`;
    }
    if (g.has.giveaway) {
      await sql`insert into giveaways (id, guild_id, channel_id, message_id, prize, status, ends_at, host_id)
        values (${g.giveawayId}, ${g.id.toString()}, ${g.ch.panel.toString()}, ${(g.ch.panel + 1000003n).toString()}, 'A prize', 'running',
                now() + interval '30 days', ${g.staffId.toString()})`;
    }
    if (g.has.poll) {
      await sql`insert into polls (id, guild_id, channel_id, message_id, question, options, engine, status, closes_at, created_by)
        values (${g.pollId}, ${g.id.toString()}, ${g.ch.panel.toString()}, ${(g.ch.panel + 1000004n).toString()}, 'Which one?',
                ${sql.json([{ id: "a", label: "A" }, { id: "b", label: "B" }])}, 'legacy', 'published', now() + interval '30 days', ${g.staffId.toString()})`;
    }

    // A little history, so the dashboard's lists have something to read.
    for (let h = 0; h < HISTORY_PER_GUILD; h++) {
      const id = crypto.randomUUID();
      await sql`insert into submissions (id, form_id, guild_id, applicant_id, status, created_at, reviewed_at, reviewer_id)
        values (${id}, ${g.formId}, ${g.id.toString()}, ${(MEMBER_USER_BASE + BigInt(g.index * 100 + h)).toString()},
                ${h === 0 ? "pending" : "accepted"}, now() - interval '3 days', ${h === 0 ? null : new Date()}, ${h === 0 ? null : g.staffId.toString()})`;
      for (const q of g.questionIds) {
        await sql`insert into answers (id, submission_id, question_id, value)
          values (${crypto.randomUUID()}, ${id}, ${q}, 'An answer of a sentence or two, like most applicants write.')`;
      }
    }
  }

  // Dashboard logins. The fake Discord lists every simulated server as theirs.
  for (let i = 0; i < SESSION_COUNT; i++) {
    const token = encryptWithKey(`sim-access-${i}`, tokenKey);
    await sql`insert into sessions (id, user_id, access_token_enc, refresh_token_enc, expires_at)
      values (${sessionId(i)}, ${(DASHBOARD_USER_BASE + BigInt(i)).toString()}, ${token}, ${token}, now() + interval '30 days')`;
  }

  await sql.end();
}
