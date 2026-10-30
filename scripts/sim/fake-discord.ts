// scripts/sim/fake-discord.ts
//
// A stand-in for Discord, speaking enough of the gateway and REST API for the
// real bot and API to run against it unmodified. It also drives the traffic and
// times the replies, because it is the only place that sees both ends: an
// interaction goes out over the gateway and its answer comes back over REST.
//
// Replies wait a random 40-160 ms, roughly Discord as seen from us-central1, so
// latencies include time spent waiting on REST the way real ones do.
//
// Run by run.ts. Not useful alone.

import {
  APP_ID,
  BOT_ID,
  buildWorld,
  MEMBER_USER_BASE,
  prng,
  type SimGuild,
} from "./world.ts";

const PORT = Number(Deno.env.get("SIM_PORT") ?? "59000");
const GUILD_COUNT = Number(Deno.env.get("SIM_GUILDS") ?? "50");
const API_ORIGIN = Deno.env.get("SIM_API_ORIGIN") ?? "http://127.0.0.1:53001";
const SESSION_IDS = (Deno.env.get("SIM_SESSIONS") ?? "").split(",").filter(Boolean);

const guilds = buildWorld(GUILD_COUNT);
const guildById = new Map(guilds.map((g) => [g.id, g]));
const rng = prng(0x5151);
const restRng = prng(0x2222);

let nextSnowflake = 1500000000000000000n;
const snowflake = () => (nextSnowflake += 1n);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

let samples = new Map<string, number[]>();
let counters = new Map<string, number>();
const unknownRoutes = new Map<string, number>();

function record(kind: string, ms: number) {
  let list = samples.get(kind);
  if (!list) samples.set(kind, list = []);
  list.push(ms);
}
function count(kind: string, by = 1) {
  counters.set(kind, (counters.get(kind) ?? 0) + by);
}

function summarize() {
  const latency: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> = {};
  for (const [kind, list] of samples) {
    const s = [...list].sort((a, b) => a - b);
    const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
    latency[kind] = { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
  }
  return { latency, counters: Object.fromEntries(counters), unknownRoutes: Object.fromEntries(unknownRoutes) };
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

const userPayload = (id: bigint, username = `user${id % 100000n}`) => ({
  id: id.toString(),
  username,
  discriminator: "0",
  global_name: null,
  avatar: null,
  public_flags: 0,
  flags: 0,
  bot: id === BOT_ID,
});

const memberPayload = (g: SimGuild, id: bigint, roles: bigint[], permissions = "1024") => ({
  user: userPayload(id),
  roles: roles.map(String),
  joined_at: "2026-01-01T00:00:00.000000+00:00",
  deaf: false,
  mute: false,
  flags: 0,
  pending: false,
  nick: null,
  avatar: null,
  premium_since: null,
  communication_disabled_until: null,
  permissions,
  guild_id: g.id.toString(),
});

const channelPayload = (g: SimGuild, id: bigint, name: string, type: number) => ({
  id: id.toString(),
  guild_id: g.id.toString(),
  name,
  type,
  position: Number(id - g.id) % 100,
  permission_overwrites: [
    { id: g.id.toString(), type: 0, allow: "0", deny: "1024" },
    { id: g.role.staff.toString(), type: 0, allow: "1024", deny: "0" },
  ],
  parent_id: type === 4 ? null : g.ch.category.toString(),
  nsfw: false,
  topic: type === 4 ? null : `Topic of ${name}, the sort of sentence people leave here.`,
  rate_limit_per_user: 0,
  last_message_id: null,
  flags: 0,
});

const rolePayload = (r: SimGuild["roles"][number]) => ({
  id: r.id.toString(),
  name: r.name,
  color: 0x5865f2,
  colors: { primary_color: 0x5865f2, secondary_color: null, tertiary_color: null },
  hoist: false,
  icon: null,
  unicode_emoji: null,
  position: r.position,
  permissions: r.permissions,
  managed: false,
  mentionable: false,
  flags: 0,
});

function guildBase(g: SimGuild) {
  return {
    id: g.id.toString(),
    name: g.name,
    icon: null,
    icon_hash: null,
    splash: null,
    discovery_splash: null,
    owner_id: g.ownerId.toString(),
    afk_channel_id: null,
    afk_timeout: 300,
    widget_enabled: false,
    verification_level: 1,
    default_message_notifications: 1,
    explicit_content_filter: 2,
    roles: g.roles.map(rolePayload),
    emojis: Array.from({ length: g.emojiCount }, (_, e) => ({
      id: (g.id + 5000n + BigInt(e)).toString(),
      name: `emoji_${e}`,
      roles: [],
      require_colons: true,
      managed: false,
      animated: false,
      available: true,
    })),
    features: ["COMMUNITY", "NEWS"],
    mfa_level: 0,
    application_id: null,
    system_channel_id: g.ch.general.toString(),
    system_channel_flags: 0,
    rules_channel_id: null,
    max_members: 500000,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: "en-US",
    public_updates_channel_id: null,
    max_video_channel_users: 25,
    max_stage_video_channel_users: 50,
    nsfw_level: 0,
    stickers: [],
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
  };
}

/**
 * What Discord sends per server when the bot connects. Members follow Discord's
 * large_threshold rule: a server over 50 members lists only the bot, because
 * this bot has no presence intent to make anyone else "online".
 */
function guildCreatePayload(g: SimGuild) {
  const large = g.memberCount > 50;
  const listed = large ? 0 : g.memberCount;
  const members = [memberPayload(g, BOT_ID, [g.role.bot])];
  for (let m = 0; m < listed; m++) {
    members.push(memberPayload(g, MEMBER_USER_BASE + BigInt(g.index * 1000 + m), [g.role.member]));
  }
  return {
    ...guildBase(g),
    joined_at: "2026-01-01T00:00:00.000000+00:00",
    large,
    unavailable: false,
    member_count: g.memberCount,
    voice_states: [],
    members,
    channels: g.channels.map((c) => channelPayload(g, c.id, c.name, c.type)),
    threads: [],
    presences: [],
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
    lazy: true,
  };
}

function messagePayload(
  channelId: bigint,
  guild: SimGuild | undefined,
  author: bigint,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: snowflake().toString(),
    channel_id: channelId.toString(),
    ...(guild ? { guild_id: guild.id.toString() } : {}),
    author: userPayload(author),
    ...(guild && author !== BOT_ID
      ? {
        member: {
          roles: [guild.role.member.toString()],
          joined_at: "2026-01-01T00:00:00.000000+00:00",
          deaf: false,
          mute: false,
          flags: 0,
          premium_since: null,
          nick: null,
          avatar: null,
        },
      }
      : {}),
    content,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    flags: 0,
    components: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

let gateway: WebSocket | null = null;
let seq = 0;
let readySent = false;
let burstDone = false;
let lastHeartbeatAt = 0;
const HEARTBEAT_MS = 41_250;
let bootStartedAt = 0;

function dispatch(t: string, d: unknown) {
  if (gateway?.readyState !== WebSocket.OPEN) {
    count("gateway_dropped");
    return;
  }
  gateway.send(JSON.stringify({ op: 0, t, s: ++seq, d }));
}

async function sendReadyBurst() {
  bootStartedAt = performance.now();
  dispatch("READY", {
    v: 10,
    user: { ...userPayload(BOT_ID, "Appealy"), verified: true },
    guilds: guilds.map((g) => ({ id: g.id.toString(), unavailable: true })),
    session_id: crypto.randomUUID(),
    resume_gateway_url: `ws://127.0.0.1:${PORT}/gateway`,
    shard: [0, 1],
    application: { id: APP_ID.toString(), flags: (1 << 14) | (1 << 18) },
  });
  readySent = true;
  let bytes = 0;
  for (const g of guilds) {
    const payload = guildCreatePayload(g);
    bytes += JSON.stringify(payload).length;
    dispatch("GUILD_CREATE", payload);
    // Discord streams these rather than sending them all in one tick.
    await sleep(5);
  }
  count("guild_create_bytes", bytes);
  burstDone = true;
}

function handleGateway(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 0 });
  socket.onopen = () => {
    gateway = socket;
    socket.send(JSON.stringify({ op: 10, s: null, t: null, d: { heartbeat_interval: HEARTBEAT_MS } }));
  };
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data as string);
    if (data.op === 1) {
      const now = performance.now();
      if (lastHeartbeatAt) record("heartbeat_interval_error", Math.abs(now - lastHeartbeatAt - HEARTBEAT_MS));
      lastHeartbeatAt = now;
      socket.send(JSON.stringify({ op: 11, s: null, t: null, d: null }));
    } else if (data.op === 2) {
      void sendReadyBurst();
    } else if (data.op === 3) {
      count("presence_updates");
    }
  };
  socket.onclose = () => {
    count("gateway_closed");
    if (gateway === socket) gateway = null;
  };
  socket.onerror = () => count("gateway_errors");
  return response;
}

// ---------------------------------------------------------------------------
// Interaction bookkeeping
// ---------------------------------------------------------------------------

interface Pending {
  kind: string;
  sentAt: number;
  acked: boolean;
  onAck: () => void;
  onFinish: () => void;
  ackPromise: Promise<void>;
  finishPromise: Promise<void>;
  type: number;
}
const pending = new Map<string, Pending>();

function sendInteraction(
  kind: string,
  g: SimGuild,
  userId: bigint,
  type: number,
  data: unknown,
  opts: { permissions?: string; roles?: bigint[]; message?: unknown; channelId?: bigint } = {},
): Pending {
  const id = snowflake();
  const token = `sim-${id}`;
  let onAck!: () => void;
  let onFinish!: () => void;
  const ackPromise = new Promise<void>((resolve) => (onAck = resolve));
  const finishPromise = new Promise<void>((resolve) => (onFinish = resolve));
  const entry: Pending = { kind, sentAt: performance.now(), acked: false, onAck, onFinish, ackPromise, finishPromise, type };
  pending.set(token, entry);
  count(`sent:${kind}`);

  const channelId = opts.channelId ?? g.ch.panel;
  dispatch("INTERACTION_CREATE", {
    id: id.toString(),
    application_id: APP_ID.toString(),
    type,
    token,
    version: 1,
    guild_id: g.id.toString(),
    guild: { id: g.id.toString(), features: [], locale: "en-US" },
    channel_id: channelId.toString(),
    channel: channelPayload(g, channelId, "panel", 0),
    member: memberPayload(g, userId, opts.roles ?? [g.role.member], opts.permissions ?? "1024"),
    data,
    locale: "en-US",
    guild_locale: "en-US",
    app_permissions: "8",
    entitlements: [],
    authorizing_integration_owners: { "0": g.id.toString() },
    context: 0,
    ...(opts.message ? { message: opts.message } : {}),
  });
  // A token nobody answers is measured as a miss rather than waited on forever.
  setTimeout(() => {
    if (!entry.acked) {
      count(`unanswered:${kind}`);
      entry.onAck();
    }
    entry.onFinish();
    pending.delete(token);
  }, 15_000);
  return entry;
}

const DEADLINE_MS = 3_000;

function answerInteraction(token: string): Response | null {
  const entry = pending.get(token);
  if (!entry) return null;
  const elapsed = performance.now() - entry.sentAt;
  if (!entry.acked) {
    record(`ack:${entry.kind}`, elapsed);
    record("ack:all", elapsed);
    entry.acked = true;
    if (elapsed > DEADLINE_MS) {
      // Discord has already told the user it failed.
      count("missed_3s_deadline");
      entry.onAck();
      return Response.json({ code: 10062, message: "Unknown interaction" }, { status: 404 });
    }
    entry.onAck();
  }
  return null;
}

// Learned from what the bot posts, the same way a real user only ever clicks
// buttons the bot actually sent.
interface ReviewPost {
  submissionId: string;
  message: unknown;
  channelId: bigint;
}
const reviewPosts = new Map<bigint, ReviewPost[]>();
const reviewWaiters = new Map<bigint, Array<() => void>>();
const ticketChannels = new Map<string, { channelId: bigint; closeId: string; message: unknown }>();
const ticketWaiters = new Map<string, () => void>();
const channelOwner = new Map<bigint, SimGuild>();

for (const g of guilds) {
  for (const c of g.channels) channelOwner.set(c.id, g);
}

function learnFromMessage(channelId: bigint, body: Record<string, unknown>, stored: unknown) {
  const g = channelOwner.get(channelId);
  if (!g) return;
  const rows = (body.components ?? []) as Array<{ components?: Array<{ custom_id?: string }> }>;
  for (const row of rows) {
    for (const c of row.components ?? []) {
      const id = c.custom_id ?? "";
      if (id.startsWith("review:accept:")) {
        const post = { submissionId: id.split(":")[2], message: stored, channelId };
        const list = reviewPosts.get(g.id) ?? [];
        list.push(post);
        reviewPosts.set(g.id, list);
        reviewWaiters.get(g.id)?.shift()?.();
      }
      if (id.startsWith("ticket:close:")) {
        const opener = /<@(\d+)>/.exec(String(body.content ?? ""))?.[1] ?? "";
        ticketChannels.set(`${g.id}:${opener}`, { channelId, closeId: id, message: stored });
        ticketWaiters.get(`${g.id}:${opener}`)?.();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status });

function userGuildsPayload() {
  return guilds.map((g) => ({
    id: g.id.toString(),
    name: g.name,
    icon: null,
    owner: true,
    permissions: "2251799813685247",
    features: [],
    banner: null,
  }));
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      let bytes = 0;
      for (const v of form.values()) if (v instanceof File) bytes += v.size;
      count("upload_bytes", bytes);
      const raw = form.get("payload_json");
      return typeof raw === "string" ? JSON.parse(raw) : {};
    }
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Without these headers Discordeno assumes one request per second per route, so
// everything looks ten times slower than it is. Real limits, roughly: 5 messages
// per 5 seconds per channel, and much looser than that for everything else.
const rateWindows = new Map<string, { used: number; resetAt: number }>();

function rateLimitHeaders(method: string, path: string): Record<string, string> {
  const isSend = method === "POST" && /^\/channels\/\d+\/messages$/.test(path);
  const major = path.match(/^\/(?:channels|guilds|webhooks|interactions)\/[^/]+/)?.[0] ?? "/";
  const key = `${method} ${major} ${isSend ? "send" : ""}`;
  const limit = isSend ? 5 : 50;
  const windowMs = isSend ? 5_000 : 1_000;
  const now = Date.now();
  let w = rateWindows.get(key);
  if (!w || w.resetAt <= now) rateWindows.set(key, w = { used: 0, resetAt: now + windowMs });
  w.used++;
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(Math.max(0, limit - w.used)),
    "x-ratelimit-reset-after": ((w.resetAt - now) / 1000).toFixed(3),
    "x-ratelimit-bucket": key,
  };
}

async function handleRest(req: Request, path: string): Promise<Response> {
  const response = await routeRest(req, path);
  for (const [k, v] of Object.entries(rateLimitHeaders(req.method, path.split("?")[0]))) {
    response.headers.set(k, v);
  }
  return response;
}

async function routeRest(req: Request, path: string): Promise<Response> {
  const method = req.method;
  const body = await readBody(req);
  // The gateway bootstrap and health probes shouldn't be slowed by the delay.
  if (!path.startsWith("/gateway") && path !== "/applications/@me") {
    await sleep(40 + restRng.next() * 120);
  }
  count(`rest:${method}`);

  let m: RegExpMatchArray | null;

  if (path === "/gateway/bot") {
    return json({
      url: `ws://127.0.0.1:${PORT}/gateway`,
      shards: 1,
      session_start_limit: { total: 1000, remaining: 999, reset_after: 86_400_000, max_concurrency: 1 },
    });
  }
  if (path === "/gateway") return json({ url: `ws://127.0.0.1:${PORT}/gateway` });
  if (path === "/applications/@me") {
    return json({ id: APP_ID.toString(), name: "Appealy", flags: (1 << 14) | (1 << 18), bot: userPayload(BOT_ID) });
  }
  if ((m = path.match(/^\/applications\/\d+\/entitlements/))) return json([]);
  if (path === "/users/@me") return json(userPayload(BOT_ID, "Appealy"));
  if (path === "/users/@me/guilds") return json(userGuildsPayload());
  if (path === "/users/@me/channels" && method === "POST") {
    const recipient = BigInt(String(body.recipient_id ?? "0"));
    // One person in five has DMs closed, which is what Discord answers on the send.
    return json({ id: snowflake().toString(), type: 1, recipients: [userPayload(recipient)], last_message_id: null });
  }
  if ((m = path.match(/^\/users\/(\d+)$/))) return json(userPayload(BigInt(m[1])));

  if ((m = path.match(/^\/interactions\/\d+\/([^/]+)\/callback/)) && method === "POST") {
    const refused = answerInteraction(m[1]);
    if (refused) return refused;
    if (body.type !== 5 && body.type !== 6) {
      // Not deferred, so this is also the complete answer.
      const entry = pending.get(m[1]);
      if (entry) {
        record(`done:${entry.kind}`, performance.now() - entry.sentAt);
        entry.onFinish();
      }
    }
    return new Response(null, { status: 204 });
  }
  if ((m = path.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/))) {
    if (method === "PATCH") {
      const entry = pending.get(m[1]);
      if (entry) {
        record(`done:${entry.kind}`, performance.now() - entry.sentAt);
        record("done:all", performance.now() - entry.sentAt);
        entry.onFinish();
      }
      return json(messagePayload(1n, undefined, BOT_ID, String(body.content ?? "")));
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json(messagePayload(1n, undefined, BOT_ID, ""));
  }
  if ((m = path.match(/^\/webhooks\/\d+\/([^/]+)\/?$/)) && method === "POST") {
    return json(messagePayload(1n, undefined, BOT_ID, String(body.content ?? "")));
  }

  if ((m = path.match(/^\/channels\/(\d+)\/messages$/))) {
    const channelId = BigInt(m[1]);
    const g = channelOwner.get(channelId);
    if (method === "POST") {
      const stored = messagePayload(channelId, g, BOT_ID, String(body.content ?? ""), {
        embeds: body.embeds ?? [],
        components: body.components ?? [],
      });
      learnFromMessage(channelId, body, stored);
      if (g && channelId === g.ch.welcome) count("welcome_posted");
      if (g && channelId === g.ch.transcript) count("transcript_posted");
      if (g && channelId === g.ch.sticky) count("sticky_reposted");
      if (!g) {
        // A DM channel: nothing routes these to a server.
        count("dm_sent");
        if (restRng.next() < 0.2) return json({ code: 50007, message: "Cannot send messages to this user" }, 403);
      }
      return json(stored);
    }
    // A transcript fetch. Tickets average thirty messages; some run long.
    const url = new URL(req.url);
    if (url.searchParams.get("before")) return json([]);
    const size = restRng.next() < 0.1 ? 100 : 30;
    const list = [];
    for (let i = 0; i < size; i++) {
      list.push(messagePayload(channelId, g, MEMBER_USER_BASE + BigInt(i % 3), `Ticket conversation line ${i}, about the length people type.`));
    }
    return json(list);
  }
  if ((m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/)) && method === "POST") {
    const g = channelOwner.get(BigInt(m[1]));
    const id = snowflake();
    if (g) channelOwner.set(id, g);
    return json({
      ...(g ? channelPayload(g, id, String(body.name ?? "thread"), 11) : { id: id.toString(), type: 11 }),
      owner_id: BOT_ID.toString(),
      member_count: 1,
      message_count: 0,
      thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false },
    });
  }
  if ((m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
    if (method === "DELETE") return new Response(null, { status: 204 });
    const g = channelOwner.get(BigInt(m[1]));
    return json(messagePayload(BigInt(m[1]), g, BOT_ID, String(body.content ?? ""), { id: m[2], embeds: body.embeds ?? [], components: body.components ?? [] }));
  }
  if ((m = path.match(/^\/channels\/(\d+)\/polls\/\d+\/expire$/))) return json(messagePayload(BigInt(m[1]), channelOwner.get(BigInt(m[1])), BOT_ID, ""));
  if ((m = path.match(/^\/channels\/(\d+)\/thread-members\//))) return new Response(null, { status: 204 });
  if ((m = path.match(/^\/channels\/(\d+)\/permissions\//))) return new Response(null, { status: 204 });
  if ((m = path.match(/^\/channels\/(\d+)$/))) {
    const id = BigInt(m[1]);
    const g = channelOwner.get(id);
    if (method === "DELETE") {
      count("channel_deleted");
      return json(g ? channelPayload(g, id, "gone", 0) : { id: m[1], type: 0 });
    }
    return json(g ? channelPayload(g, id, String(body.name ?? `channel-${id % 100n}`), 0) : { id: m[1], type: 1 });
  }

  if ((m = path.match(/^\/guilds\/(\d+)(.*)$/))) {
    const g = guildById.get(BigInt(m[1]));
    if (!g) return json({ code: 10004, message: "Unknown Guild" }, 404);
    const rest = m[2].split("?")[0];
    let r: RegExpMatchArray | null;

    if (rest === "") return json({ ...guildBase(g), approximate_member_count: g.memberCount, approximate_presence_count: 3 });
    if (rest === "/channels" && method === "GET") return json(g.channels.map((c) => channelPayload(g, c.id, c.name, c.type)));
    if (rest === "/channels" && method === "POST") {
      const id = snowflake();
      channelOwner.set(id, g);
      count("channel_created");
      return json(channelPayload(g, id, String(body.name ?? "ticket"), Number(body.type ?? 0)), 201);
    }
    if (rest === "/roles") return json(g.roles.map(rolePayload));
    if ((r = rest.match(/^\/members\/(\d+)\/roles\/\d+$/))) {
      count(method === "PUT" ? "role_added" : "role_removed");
      return new Response(null, { status: 204 });
    }
    if ((r = rest.match(/^\/members\/(\d+)$/))) {
      if (method === "DELETE") return new Response(null, { status: 204 });
      const id = BigInt(r[1]);
      const roles = id === BOT_ID ? [g.role.bot] : id === g.staffId ? [g.role.staff] : [g.role.member];
      return json(memberPayload(g, id, roles, id === BOT_ID ? "8" : "1024"));
    }
    if (rest.startsWith("/members")) return json([]);
    if ((r = rest.match(/^\/bans\/(\d+)$/))) {
      if (method === "GET") return json({ code: 10026, message: "Unknown Ban" }, 404);
      return new Response(null, { status: 204 });
    }
    if (rest === "/auto-moderation/rules") return json([]);
    if (rest === "/commands" || rest.startsWith("/webhooks")) return json([]);
  }

  // Answered rather than failed, and reported, so a route the simulator doesn't
  // know yet shows up in the results instead of as a mystery error in the bot.
  const shape = `${method} ${path.replace(/\d{5,}/g, ":id").replace(/sim-:id/g, ":token")}`;
  unknownRoutes.set(shape, (unknownRoutes.get(shape) ?? 0) + 1);
  return json({});
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

let nextMember = 0n;
const freshMember = () => MEMBER_USER_BASE + 1_000_000n + (nextMember += 1n);

const textChannelOf = (g: SimGuild) => g.channels[8 + rng.int(g.channels.length - 8)].id;

function chatMessage() {
  const g = rng.pick(guilds);
  const roll = rng.next();
  const author = freshMember();
  // Sticky channels see the same traffic as anywhere else in that server.
  const channelId = g.has.sticky && rng.next() < 0.3 ? g.ch.sticky : textChannelOf(g);
  count("events:message");
  if (roll < 0.85) {
    // 1 in 20 starts with a symbol, so it takes the "might be a command" path.
    const content = rng.next() < 0.05
      ? "!not a real command, just someone who types like this"
      : "An ordinary chat message, about as long as most of them turn out to be.";
    dispatch("MESSAGE_CREATE", messagePayload(channelId, g, author, content));
  } else if (roll < 0.95) {
    dispatch("MESSAGE_UPDATE", messagePayload(channelId, g, author, "Edited, as people do."));
  } else {
    dispatch("MESSAGE_DELETE", { id: snowflake().toString(), channel_id: channelId.toString(), guild_id: g.id.toString() });
  }
}

function memberJoin(g = rng.pick(guilds)) {
  count("events:join");
  dispatch("GUILD_MEMBER_ADD", { ...memberPayload(g, freshMember(), []), permissions: undefined });
}
function memberLeave() {
  const g = rng.pick(guilds);
  count("events:leave");
  dispatch("GUILD_MEMBER_REMOVE", { guild_id: g.id.toString(), user: userPayload(freshMember()) });
}
function memberUpdate() {
  const g = rng.pick(guilds);
  count("events:member_update");
  dispatch("GUILD_MEMBER_UPDATE", { ...memberPayload(g, freshMember(), [g.role.member]), permissions: undefined });
}

const componentData = (customId: string, values?: string[]) => ({
  custom_id: customId,
  component_type: values ? 3 : 2,
  ...(values ? { values } : {}),
});

/** Application: open the panel, confirm, submit the form, then staff decide. */
async function flowApply() {
  const g = rng.pick(guilds);
  const applicant = freshMember();
  const open = sendInteraction("panel_open", g, applicant, 3, componentData(`panel:open:${g.formId}`));
  await open.ackPromise;
  const confirm = sendInteraction("modal_confirm", g, applicant, 3, componentData(`modal:confirm:${g.formId}`));
  await confirm.ackPromise;
  const submit = sendInteraction("form_submit", g, applicant, 5, {
    custom_id: `modal:submit:${g.formId}`,
    components: g.questionIds.map((q) => ({
      type: 1,
      components: [{ type: 4, custom_id: q, value: "An answer of a sentence or two, like most applicants write." }],
    })),
  });
  await submit.finishPromise;

  // Staff get to it a moment later.
  const post = await nextReviewPost(g);
  if (!post) return;
  const staffRoles = [g.role.staff];
  if (rng.next() < 0.7) {
    const accept = sendInteraction("review_accept", g, g.staffId, 3, componentData(`review:accept:${post.submissionId}`), {
      permissions: "8",
      roles: staffRoles,
      message: post.message,
      channelId: post.channelId,
    });
    await accept.finishPromise;
  } else {
    const deny = sendInteraction("review_deny", g, g.staffId, 3, componentData(`review:deny:${post.submissionId}`), {
      permissions: "8",
      roles: staffRoles,
      message: post.message,
      channelId: post.channelId,
    });
    await deny.ackPromise;
    const reason = sendInteraction("review_deny_confirm", g, g.staffId, 5, {
      custom_id: `review:deny_confirm:${post.submissionId}`,
      components: [{ type: 1, components: [{ type: 4, custom_id: "reason", value: "Not this time." }] }],
    }, { permissions: "8", roles: staffRoles, message: post.message, channelId: post.channelId });
    await reason.finishPromise;
  }
}

async function nextReviewPost(g: SimGuild): Promise<ReviewPost | undefined> {
  const queued = reviewPosts.get(g.id);
  if (queued?.length) return queued.shift();
  await Promise.race([
    new Promise<void>((resolve) => {
      const list = reviewWaiters.get(g.id) ?? [];
      list.push(resolve);
      reviewWaiters.set(g.id, list);
    }),
    sleep(8_000),
  ]);
  return reviewPosts.get(g.id)?.shift();
}

/** Ticket: open, a short conversation, close with a transcript. */
async function flowTicket() {
  const withTickets = guilds.filter((g) => g.has.tickets);
  const g = rng.pick(withTickets);
  const opener = freshMember();
  const key = `${g.id}:${opener}`;
  const created = new Promise<void>((resolve) => ticketWaiters.set(key, resolve));
  const open = sendInteraction("ticket_open", g, opener, 3, componentData(`ticket:open:${g.ticketConfigId}`));
  await open.finishPromise;
  await Promise.race([created, sleep(8_000)]);
  ticketWaiters.delete(key);
  const ticket = ticketChannels.get(key);
  if (!ticket) {
    count("ticket_not_created");
    return;
  }
  ticketChannels.delete(key);
  for (let i = 0; i < 3; i++) {
    dispatch("MESSAGE_CREATE", messagePayload(ticket.channelId, g, opener, "Here is what went wrong, in a sentence or two."));
    await sleep(200);
  }
  const close = sendInteraction("ticket_close", g, opener, 3, componentData(ticket.closeId), {
    channelId: ticket.channelId,
    message: ticket.message,
  });
  await close.finishPromise;
}

async function flowOther() {
  const roll = rng.next();
  const user = freshMember();
  const some = (test: (g: SimGuild) => boolean) => rng.pick(guilds.filter(test));
  if (roll < 0.25) {
    const g = some((x) => x.has.verification);
    await sendInteraction("verify", g, user, 3, componentData(`verify:start:${g.id}`)).finishPromise;
  } else if (roll < 0.5) {
    const g = some((x) => x.has.giveaway);
    await sendInteraction("giveaway_enter", g, user, 3, componentData(`giveaway:enter:${g.giveawayId}`)).finishPromise;
  } else if (roll < 0.65) {
    const g = some((x) => x.has.roleMenu);
    await sendInteraction("role_menu", g, user, 3, componentData(`rolemenu:select:${g.roleMenuId}`, [g.role.menuA.toString()])).finishPromise;
  } else if (roll < 0.8) {
    const g = some((x) => x.has.poll);
    await sendInteraction("poll_vote", g, user, 3, componentData(`poll:vote:${g.pollId}`, ["a"])).finishPromise;
  } else {
    const g = rng.pick(guilds);
    await sendInteraction("slash_ping", g, user, 2, { id: "1", name: "ping", type: 1, options: [] }).finishPromise;
  }
}

function interactionFlow() {
  const roll = rng.next();
  const flow = roll < 0.45 ? flowApply : roll < 0.7 ? flowTicket : flowOther;
  flow().catch((err) => count(`flow_error:${String(err).slice(0, 60)}`));
}

const DASHBOARD_PAGES: Array<[string, (g: SimGuild) => string]> = [
  ["overview", (g) => `/api/guilds/${g.id}/overview`],
  ["overview", (g) => `/api/guilds/${g.id}/overview`],
  ["forms", (g) => `/api/guilds/${g.id}/forms`],
  ["form", (g) => `/api/guilds/${g.id}/forms/${g.formId}`],
  ["panels", (g) => `/api/guilds/${g.id}/panels`],
  ["submissions", (g) => `/api/guilds/${g.id}/submissions`],
  ["submissions", (g) => `/api/guilds/${g.id}/submissions`],
  ["tickets", (g) => `/api/guilds/${g.id}/ticket-configs`],
  ["welcomer", (g) => `/api/guilds/${g.id}/welcomer`],
  ["channels", (g) => `/api/guilds/${g.id}/resources/channels`],
  ["roles", (g) => `/api/guilds/${g.id}/resources/roles`],
  ["me", () => `/auth/me`],
  ["my_servers", () => `/auth/me/guilds`],
];

async function dashboardRequest() {
  if (SESSION_IDS.length === 0) return;
  const g = rng.pick(guilds);
  const session = rng.pick(SESSION_IDS);
  const headers: Record<string, string> = { cookie: `appealy_session=${session}` };
  const write = rng.next() < 0.03 && g.has.welcomer;
  const [name, url] = write
    ? ["save_welcomer", `/api/guilds/${g.id}/welcomer`]
    : (() => {
      const [n, f] = rng.pick(DASHBOARD_PAGES);
      return [n, f(g)];
    })();
  const started = performance.now();
  try {
    const res = await fetch(`${API_ORIGIN}${url}`, write
      ? {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          joinEnabled: true,
          joinChannelId: g.ch.welcome.toString(),
          joinMessage: "Welcome to {guild}, {username}! You are member #{membercount}.",
          autoRoleIds: [g.role.member.toString()],
          leaveEnabled: true,
          leaveChannelId: g.ch.welcome.toString(),
        }),
      }
      : { headers });
    await res.arrayBuffer();
    const ms = performance.now() - started;
    record(`http:${name}`, ms);
    record("http:all", ms);
    count(`http_status:${res.status}`);
    if (res.status >= 400) count(`http_fail:${name}:${res.status}`);
  } catch (err) {
    count(`http_error:${String(err).slice(0, 60)}`);
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

interface Rates {
  messages: number;
  joins: number;
  leaves: number;
  memberUpdates: number;
  interactions: number;
  dashboard: number;
  /** Joins per second aimed at one server with anti-raid on. */
  raidJoins?: number;
}

function loop(rate: number, until: number, fn: () => void, random = rng): Promise<void> {
  if (rate <= 0) return Promise.resolve();
  return (async () => {
    let at = performance.now() + random.exp(rate) * 1000;
    while (at < until) {
      const wait = at - performance.now();
      if (wait > 0) await sleep(wait);
      fn();
      at += random.exp(rate) * 1000;
    }
  })();
}

async function runPhase(seconds: number, rates: Rates) {
  samples = new Map();
  counters = new Map();
  const until = performance.now() + seconds * 1000;
  const raidTarget = guilds.find((g) => g.has.antiRaid);
  await Promise.all([
    loop(rates.messages, until, chatMessage),
    loop(rates.joins, until, () => memberJoin()),
    loop(rates.leaves, until, memberLeave),
    loop(rates.memberUpdates, until, memberUpdate),
    loop(rates.interactions, until, interactionFlow),
    loop(rates.dashboard, until, () => void dashboardRequest()),
    raidTarget && rates.raidJoins ? loop(rates.raidJoins, until, () => memberJoin(raidTarget)) : Promise.resolve(),
  ]);
  // Flows started near the end get a moment to finish, so they aren't lost.
  await sleep(3_000);
  return summarize();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/gateway") return handleGateway(req);
  if (url.pathname === "/__sim/state") {
    return json({ connected: gateway?.readyState === WebSocket.OPEN, readySent, burstDone, bootStartedAt, seq });
  }
  if (url.pathname === "/__sim/phase" && req.method === "POST") {
    const { seconds, rates } = await req.json();
    return json(await runPhase(seconds, rates));
  }
  if (url.pathname === "/__status") {
    await req.arrayBuffer();
    count("status_heartbeats");
    return new Response(null, { status: 204 });
  }
  if (url.pathname.startsWith("/api/v")) {
    return handleRest(req, url.pathname.replace(/^\/api\/v\d+/, "") + url.search.replace(/^\?.*$/, ""));
  }
  return new Response("not found", { status: 404 });
});
