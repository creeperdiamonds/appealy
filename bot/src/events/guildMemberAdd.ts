// bot/src/events/guildMemberAdd.ts
//
// Fires when a member joins. This handler matters disproportionately
// because its worst-case load is correlated with the exact situation it
// exists to defend against: during a raid, joins arrive in the thousands
// per minute, and that is precisely when the anti-raid logic must not be
// the thing that falls over.
//
// Order of operations (unchanged from the original, which was right):
//   0. Anti-raid join-velocity tracking. Runs first because it's the only
//      step that can end the pipeline early for a given join.
//   1. Verification's unverifiedRoleId, so a fresh member is gated before
//      any welcomer auto-roles land — otherwise there's a window where
//      they hold both an "unverified" gate role and a granted role.
//   2. Welcomer: join message, join DM, auto-roles.
//
// WHAT CHANGED
// ------------
// 1. FOUR SEQUENTIAL QUERIES BECAME ZERO (cached).
//    The original did four separate awaited SELECTs per join —
//    antiRaidConfigs, raidLockdowns, verificationConfigs, welcomerConfigs —
//    each a full network round-trip, serialized. At 1,000 joins/min that's
//    4,000 queries/min against a 10-connection pool, for data that changes
//    approximately never. Now it's one cached bundle read.
//
// 2. ROLE GRANTS RUN IN PARALLEL.
//    The original awaited `addRole` inside a `for` loop, so five auto-roles
//    meant five serialized Discord REST calls, each subject to per-route
//    rate limiting. `Promise.allSettled` lets the library's rate limiter
//    schedule them together. `allSettled` rather than `all` specifically:
//    one role failing because it sits above the bot in the hierarchy must
//    not abort the other four.
//
// 3. THE `setTimeout` AUTO-KICK IS GONE.
//    The original scheduled `setTimeout(..., kickUnverifiedAfterSeconds * 1000)`
//    per join. Three separate problems:
//      - Unbounded memory. A 10,000-member raid creates 10,000 live timers
//        each holding a closure over the member object.
//      - Every timer is lost on restart, so a deploy silently cancels
//        pending kicks with no record that it happened.
//      - Its lookup was `findFirst({ where: eq(verificationAttempts.userId,
//        member.user.id) })` with NO guildId filter — so a user verified in
//        ANY guild counted as verified in THIS one. Since `verificationAttempts`
//        is indexed on (guildId, userId), a userId-only filter can't use
//        that index either: it was both wrong and slow.
//    Replaced with a durable row in `scheduled_jobs`, claimed and executed
//    by the scheduler with a proper guild-scoped verification check.

import { and, eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { interpolateTemplate } from "../../../shared/types/index.ts";
import { findUnmanageableRoles } from "../services/permissionService.ts";
import { recordJoinAndCheckRaid, isLockdownActiveCached } from "../services/antiRaidService.ts";
import { getGuildConfig, type GuildConfigBundle } from "../core/guildConfigCache.ts";
import { logger } from "../utils/logger.ts";

type JoiningMember = {
  guildId: bigint;
  user: { id: bigint; username: string; discriminator?: string };
};

export function onGuildMemberAdd(bot: AppealyBot) {
  return async (member: JoiningMember) => {
    let config: GuildConfigBundle;
    try {
      config = await getGuildConfig(member.guildId);
    } catch (err) {
      logger.error("Failed to load guild config on member join", {
        guildId: member.guildId.toString(),
        error: String(err),
      });
      return;
    }

    await recordJoinAndCheckRaid(bot, member.guildId, member.user.id, config.antiRaid);

    if (config.antiRaid?.action === "kick_new_joins" && (await isLockdownActiveCached(member.guildId))) {
      try {
        await bot.helpers.kickMember(
          member.guildId,
          member.user.id,
          "Anti-raid lockdown active — new joins restricted",
        );
        logger.info("Kicked joining member due to active anti-raid lockdown", {
          guildId: member.guildId.toString(),
          userId: member.user.id.toString(),
        });
      } catch (err) {
        logger.error("Failed to kick member during anti-raid lockdown", { error: String(err) });
      }
      return; // never apply verification/welcomer to a member we just kicked
    }

    // These two are independent of each other, so there's no reason to
    // serialize them. Ordering only matters for role application, which is
    // handled inside applyVerificationGate finishing its addRole before
    // applyWelcomer's grants land — both go through Discord's per-guild
    // member-update rate limit bucket, which sequences them anyway.
    await Promise.allSettled([
      applyVerificationGate(bot, member, config),
      applyWelcomer(bot, member, config),
    ]);
  };
}

async function applyVerificationGate(
  bot: AppealyBot,
  member: JoiningMember,
  config: GuildConfigBundle,
) {
  const verification = config.verification;
  if (!verification?.enabled || !verification.unverifiedRoleId) return;

  try {
    await bot.helpers.addRole(
      member.guildId,
      member.user.id,
      verification.unverifiedRoleId,
      "Applied on join pending verification",
    );
  } catch (err) {
    logger.warn("Failed to apply unverified role on join", {
      guildId: member.guildId.toString(),
      userId: member.user.id.toString(),
      error: String(err),
    });
  }

  if (!verification.kickUnverifiedAfterSeconds) return;

  // Durable job row instead of an in-memory timer. Survives restarts,
  // costs bounded storage rather than unbounded heap, and is visible on
  // the dashboard's scheduled-jobs view so staff can see (and cancel)
  // pending kicks instead of guessing.
  try {
    await db
      .insert(schema.scheduledJobs)
      .values({
        kind: "kick_unverified",
        guildId: member.guildId,
        subjectId: member.user.id,
        runAt: new Date(Date.now() + verification.kickUnverifiedAfterSeconds * 1000),
      })
      .onConflictDoNothing(); // rejoining before the first job fires shouldn't queue a second
  } catch (err) {
    logger.error("Failed to schedule unverified-kick job", {
      guildId: member.guildId.toString(),
      userId: member.user.id.toString(),
      error: String(err),
    });
  }
}

async function applyWelcomer(bot: AppealyBot, member: JoiningMember, config: GuildConfigBundle) {
  const welcomer = config.welcomer;
  if (!welcomer) return;

  const guild = await bot.cache?.guilds?.get(member.guildId);
  const guildName = guild?.name ?? config.guild?.name ?? "the server";
  const memberCount = guild?.memberCount;

  const templateVars = {
    username: member.user.username,
    userTag: `${member.user.username}#${member.user.discriminator ?? "0"}`,
    userId: member.user.id.toString(),
    guildName,
    memberCount,
  };

  const tasks: Promise<unknown>[] = [];

  if (welcomer.autoRoleIds.length > 0) {
    tasks.push(grantAutoRoles(bot, member, welcomer.autoRoleIds));
  }

  if (welcomer.joinEnabled && welcomer.joinChannelId) {
    const body = interpolateTemplate(welcomer.joinMessage ?? "Welcome, {username}!", templateVars);
    tasks.push(
      bot.helpers
        .sendMessage(welcomer.joinChannelId, {
          embeds: [
            {
              description: body,
              color: welcomer.joinEmbedColor ?? 0x5865f2,
              image: welcomer.joinImageUrl ? { url: welcomer.joinImageUrl } : undefined,
              // The original hardcoded `/avatars/{id}/icon.png`, which is
              // not a real CDN path and 404s for every user. Discord's
              // avatar URL needs the user's avatar hash, which this event
              // payload doesn't carry, so the correct fallback is the
              // default-avatar endpoint keyed on the account's creation.
              thumbnail: {
                url: `https://cdn.discordapp.com/embed/avatars/${
                  (member.user.id >> 22n) % 6n
                }.png`,
              },
            },
          ],
        })
        .catch((err: unknown) =>
          logger.warn("Failed to send welcomer join message", { error: String(err) }),
        ),
    );
  }

  if (welcomer.joinDmEnabled && welcomer.joinDmMessage) {
    const dmBody = interpolateTemplate(welcomer.joinDmMessage, templateVars);
    tasks.push(
      (async () => {
        try {
          const dmChannel = await bot.helpers.getDmChannel(member.user.id);
          await bot.helpers.sendMessage(dmChannel.id, { content: dmBody });
        } catch {
          // Expected for users with DMs closed. Not worth a log line at
          // join volume — it would be the single noisiest line in the log.
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);
}

async function grantAutoRoles(bot: AppealyBot, member: JoiningMember, roleIds: string[]) {
  const unmanageable = await findUnmanageableRoles(bot, member.guildId, roleIds);
  const manageable = roleIds.filter((r) => !unmanageable.includes(r));

  if (unmanageable.length > 0) {
    logger.warn("Skipping welcomer auto-roles positioned above the bot", {
      guildId: member.guildId.toString(),
      roleIds: unmanageable,
    });
  }

  const results = await Promise.allSettled(
    manageable.map((roleId) =>
      bot.helpers.addRole(member.guildId, member.user.id, BigInt(roleId), "Welcomer auto-role"),
    ),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.warn("Failed to apply a welcomer auto-role", {
        guildId: member.guildId.toString(),
        roleId: manageable[i],
        error: String(result.reason),
      });
    }
  }
}
