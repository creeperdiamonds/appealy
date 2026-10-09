// bot/src/services/setupRules.ts
//
// The dashboard's setup check: everything about a server's setup that will
// fail quietly when it's used. A review post that can't be posted, a role
// that can't be given, a thread that can't be opened. Each of those only
// shows up today as a warning in our logs, long after a member was let down.
//
// Pure, so it can be tested without Discord or a database
// (__tests__/setupCheck.test.ts). services/setupCheck.ts feeds it.


export const P = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

const NAMES: [bigint, string][] = [
  [P.VIEW_CHANNEL, "View Channel"],
  [P.SEND_MESSAGES, "Send Messages"],
  [P.EMBED_LINKS, "Embed Links"],
  [P.READ_MESSAGE_HISTORY, "Read Message History"],
  [P.CREATE_PUBLIC_THREADS, "Create Public Threads"],
  [P.SEND_MESSAGES_IN_THREADS, "Send Messages in Threads"],
  [P.MANAGE_THREADS, "Manage Threads"],
];

export interface Overwrite {
  /** 0 a role (the guild's own id is @everyone), 1 a member. */
  type: number;
  id: string;
  allow: bigint;
  deny: bigint;
}
export interface SetupGuild {
  id: string;
  ownerId: string;
  botId: string;
  botRoleIds: string[];
  roles: { id: string; name: string; position: number; permissions: bigint; managed?: boolean }[];
  channels: { id: string; name: string; overwrites: Overwrite[] }[];
}
export interface SetupForm {
  id: string;
  name: string;
  logChannelId: string;
  acceptedChannelId: string | null;
  deniedChannelId: string | null;
  threads: boolean;
  archiveOnDecision: boolean;
  /** Every role the form adds or removes, on any outcome. */
  roleIds: string[];
  /** Per-outcome log channels. */
  outcomeChannelIds: string[];
}
export interface SetupIssue {
  formId: string;
  formName: string;
  /** "act": it fails every time. "watch": it fails sometimes. */
  level: "act" | "watch";
  message: string;
}

/** The bot's server-wide permissions. */
function basePermissions(g: SetupGuild): bigint {
  if (g.botId === g.ownerId) return ~0n;
  let bits = g.roles.find((r) => r.id === g.id)?.permissions ?? 0n;
  for (const r of g.roles) if (g.botRoleIds.includes(r.id)) bits |= r.permissions;
  return bits & P.ADMINISTRATOR ? ~0n : bits;
}

/** The bot's permissions in one channel, overwrites applied the way Discord does. */
export function channelPermissions(g: SetupGuild, overwrites: Overwrite[]): bigint {
  let bits = basePermissions(g);
  if (bits === ~0n) return bits;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === g.id);
  if (everyone) bits = (bits & ~everyone.deny) | everyone.allow;
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== g.id && g.botRoleIds.includes(o.id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  bits = (bits & ~deny) | allow;
  const mine = overwrites.find((o) => o.type === 1 && o.id === g.botId);
  if (mine) bits = (bits & ~mine.deny) | mine.allow;
  return bits;
}

const missingNames = (have: bigint, need: bigint) =>
  NAMES.filter(([bit]) => need & bit && !(have & bit)).map(([, name]) => name);

export function checkSetup(g: SetupGuild, forms: SetupForm[]): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const base = basePermissions(g);
  const top = Math.max(0, ...g.roles.filter((r) => g.botRoleIds.includes(r.id)).map((r) => r.position));

  for (const f of forms) {
    const add = (level: SetupIssue["level"], message: string) => issues.push({ formId: f.id, formName: f.name, level, message });

    const channel = (id: string, purpose: string, need: bigint, level: SetupIssue["level"]) => {
      const c = g.channels.find((x) => x.id === id);
      if (!c) return add(level, `The ${purpose} channel was deleted. Pick a new one.`);
      const missing = missingNames(channelPermissions(g, c.overwrites), need);
      if (missing.length) add(level, `Appealy is missing ${missing.join(", ")} in #${c.name}, the ${purpose} channel.`);
    };

    // The review post is posted, read back and edited, and threads hang off it.
    let reviewNeeds = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.READ_MESSAGE_HISTORY;
    if (f.threads) reviewNeeds |= P.CREATE_PUBLIC_THREADS | P.SEND_MESSAGES_IN_THREADS;
    if (f.threads && f.archiveOnDecision) reviewNeeds |= P.MANAGE_THREADS;
    channel(f.logChannelId, "review", reviewNeeds, "act");

    const copyNeeds = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS;
    if (f.acceptedChannelId && f.acceptedChannelId !== f.logChannelId) channel(f.acceptedChannelId, "accepted", copyNeeds, "watch");
    if (f.deniedChannelId && f.deniedChannelId !== f.logChannelId) channel(f.deniedChannelId, "denied", copyNeeds, "watch");
    for (const id of new Set(f.outcomeChannelIds)) if (id !== f.logChannelId) channel(id, "outcome", copyNeeds, "watch");

    if (f.roleIds.length === 0) continue;
    if (!(base & P.MANAGE_ROLES)) {
      add("act", "Appealy doesn't have Manage Roles, so it can't give or take this form's roles.");
      continue;
    }
    for (const id of new Set(f.roleIds)) {
      const role = g.roles.find((r) => r.id === id);
      if (!role) add("act", "One of this form's roles was deleted. Remove it from the form.");
      else if (role.managed) add("act", `@${role.name} belongs to another bot or integration, so Appealy can't give or take it.`);
      // Administrator doesn't get around this: Discord only lets a bot manage
      // roles below its own highest one.
      else if (role.position >= top) {
        add("act", `@${role.name} is above Appealy's highest role. Drag Appealy's role above it in Server Settings → Roles.`);
      }
    }
  }
  return issues;
}

