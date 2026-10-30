// scripts/sim/world.ts
//
// The simulated Discord servers. Pure and deterministic: the seeder and the
// fake gateway each build this from nothing but a server count and have to
// agree on every id, so nothing here may depend on the clock or on randomness.
//
// The feature mix is a guess that errs high: every server has a form and a
// panel, half have tickets. Real servers set up less than this (of the servers
// added on 10-20 Oct 2026, 33% had made a form), so the numbers this produces
// are if anything pessimistic.

export const BOT_ID = 1000000000000000001n;
export const APP_ID = BOT_ID;

/** Not a credential. Discordeno derives the bot id from the first segment. */
export const SIM_TOKEN = `${btoa(BOT_ID.toString())}.sim.not-a-real-token`;

export const STAFF_USER_BASE = 1300000000000000000n;
export const MEMBER_USER_BASE = 1200000000000000000n;
export const DASHBOARD_USER_BASE = 1400000000000000000n;

export interface SimChannel {
  id: bigint;
  name: string;
  type: number;
}

export interface SimRole {
  id: bigint;
  name: string;
  position: number;
  permissions: string;
}

export type SizeClass = "small" | "medium" | "large";

export interface SimGuild {
  index: number;
  id: bigint;
  name: string;
  ownerId: bigint;
  staffId: bigint;
  size: SizeClass;
  memberCount: number;
  channels: SimChannel[];
  roles: SimRole[];
  emojiCount: number;
  ch: {
    general: bigint;
    log: bigint;
    transcript: bigint;
    welcome: bigint;
    panel: bigint;
    sticky: bigint;
    category: bigint;
  };
  role: {
    member: bigint;
    staff: bigint;
    bot: bigint;
    verified: bigint;
    unverified: bigint;
    menuA: bigint;
    menuB: bigint;
  };
  has: {
    tickets: boolean;
    welcomer: boolean;
    verification: boolean;
    antiRaid: boolean;
    sticky: boolean;
    roleMenu: boolean;
    giveaway: boolean;
    poll: boolean;
  };
  formId: string;
  panelId: string;
  questionIds: string[];
  ticketConfigId: string;
  roleMenuId: string;
  giveawayId: string;
  pollId: string;
}

function entityId(kind: number, guild: number, n = 0): string {
  const hex = (v: number, width: number) => v.toString(16).padStart(width, "0");
  return `${hex(kind, 8)}-0000-4000-8000-${hex(guild, 8)}${hex(n, 4)}`;
}

export function buildWorld(count: number): SimGuild[] {
  const guilds: SimGuild[] = [];
  for (let i = 0; i < count; i++) {
    const id = 1100000000000000000n + BigInt(i + 1) * 1000000n;
    const size: SizeClass = i % 20 === 19 ? "large" : i % 5 === 4 ? "medium" : "small";
    const channelCount = size === "large" ? 80 : size === "medium" ? 40 : 15;
    const roleCount = size === "large" ? 60 : size === "medium" ? 30 : 10;

    const channels: SimChannel[] = [];
    for (let c = 0; c < channelCount; c++) {
      channels.push({ id: id + 100n + BigInt(c), name: `channel-${c}`, type: c === 6 ? 4 : 0 });
    }

    const roles: SimRole[] = [{ id, name: "@everyone", position: 0, permissions: "104324673" }];
    const named = ["Members", "Staff", "Appealy", "Verified", "Unverified", "Menu A", "Menu B"];
    for (let r = 0; r < roleCount; r++) {
      roles.push({
        id: id + 1000n + BigInt(r),
        name: named[r] ?? `role-${r}`,
        // The bot's role sits above everything it manages, as a working server's does.
        position: r === 2 ? roleCount + 1 : r + 1,
        permissions: r === 2 ? "8" : "104324673",
      });
    }

    guilds.push({
      index: i,
      id,
      name: `Sim Server ${i + 1}`,
      ownerId: STAFF_USER_BASE + BigInt(i),
      staffId: STAFF_USER_BASE + BigInt(i),
      size,
      memberCount: size === "large" ? 20000 : size === "medium" ? 800 : 20 + (i % 30),
      channels,
      roles,
      emojiCount: size === "large" ? 100 : size === "medium" ? 30 : 5,
      ch: {
        general: id + 100n,
        log: id + 101n,
        transcript: id + 102n,
        welcome: id + 103n,
        panel: id + 104n,
        sticky: id + 105n,
        category: id + 106n,
      },
      role: {
        member: id + 1000n,
        staff: id + 1001n,
        bot: id + 1002n,
        verified: id + 1003n,
        unverified: id + 1004n,
        menuA: id + 1005n,
        menuB: id + 1006n,
      },
      has: {
        tickets: i % 2 === 0,
        welcomer: i % 5 <= 1,
        verification: i % 5 === 2,
        antiRaid: i % 10 === 3,
        sticky: i % 10 === 4,
        roleMenu: i % 10 === 5,
        giveaway: i % 10 === 6,
        poll: i % 10 === 7,
      },
      formId: entityId(1, i),
      panelId: entityId(2, i),
      questionIds: [0, 1, 2, 3, 4].map((q) => entityId(3, i, q)),
      ticketConfigId: entityId(4, i),
      roleMenuId: entityId(5, i),
      giveawayId: entityId(6, i),
      pollId: entityId(7, i),
    });
  }
  return guilds;
}

/** Small fast PRNG, so two runs send the same traffic in the same order. */
export function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)],
    /** Seconds until the next arrival of something happening `rate` times a second. */
    exp: (rate: number) => -Math.log(1 - next()) / rate,
  };
}
