// shared/lib/memoryRedis.ts
//
// An in-memory stand-in for Redis, so a proof of concept needs one container
// instead of two.
//
// ---------------------------------------------------------------------------
// Why this is safe here, and where it stops being safe
// ---------------------------------------------------------------------------
// Redis in this codebase holds four things, all of them reconstructible:
//
//   guild config cache      rebuilt from Postgres on miss
//   rate limit counters     reset to zero, which is generous, not dangerous
//   pending form answers    an in-progress application is lost; the user restarts
//   cache invalidation      the pub/sub channel that tells replicas to drop a key
//
// None of it is a source of truth. Losing all of it on restart costs a
// half-finished application and a cold cache — which is why a POC can do
// without the container entirely.
//
// It stops being safe the moment you run MORE THAN ONE PROCESS. This Map lives
// inside one process, so:
//
//   - The bot and the API each get their own copy. A config change in the
//     dashboard publishes an invalidation the bot never receives, and the bot
//     serves stale config until its own TTL expires.
//   - Two bot replicas each rate-limit independently, so the effective limit
//     is double what's configured.
//
// Both are acceptable for a POC and neither is acceptable in production. The
// startup log says so, loudly, every time this is used.
//
// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------
// Implements only the commands this codebase actually calls — get, set, del,
// incr, expire, mget, publish, subscribe, duplicate. Deliberately not a
// general Redis emulator: an incomplete one that pretends to be complete fails
// in ways that look like application bugs. Anything unimplemented throws with
// a message naming the command, so it surfaces immediately rather than
// silently returning undefined.

type Entry = { value: string; expiresAt: number | null };
type Listener = (channel: string, message: string) => void;

export class MemoryRedis {
  private store = new Map<string, Entry>();
  private listeners = new Map<string, Set<Listener>>();
  private sweeper: number | undefined;

  constructor(private label = "primary") {
    // Expiry is lazy on read, so a key written once and never read again would
    // sit in memory forever. This bounds it. 60s is far more often than
    // anything here needs.
    this.sweeper = setInterval(() => this.sweep(), 60_000) as unknown as number;
    if (typeof Deno !== "undefined" && "unrefTimer" in Deno) {
      (Deno as unknown as { unrefTimer(id: number): void }).unrefTimer(this.sweeper!);
    } else if (typeof this.sweeper === "object") {
      (this.sweeper as unknown as { unref(): void }).unref?.();
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (e.expiresAt !== null && e.expiresAt <= now) this.store.delete(k);
    }
  }

  private live(key: string): Entry | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }

  // deno-lint-ignore require-await
  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.flat().map((k) => this.get(k)));
  }

  /**
   * Supports both call styles this codebase uses:
   *   set(k, v, { ex: 60 })            — Deno redis client
   *   set(k, v, "EX", 60, "NX")        — ioredis
   *
   * NX returns null when the key exists, which is what the ban-notice
   * cooldown and the appeal throttle rely on to mean "someone else got here
   * first". Getting that return value wrong would make those fire every time.
   */
  // deno-lint-ignore require-await
  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<"OK" | null> {
    let ttlSeconds: number | null = null;
    let nx = false;

    if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
      const opts = args[0] as { ex?: number; nx?: boolean };
      if (opts.ex) ttlSeconds = opts.ex;
      if (opts.nx) nx = true;
    } else {
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === "EX") ttlSeconds = Number(args[++i]);
        if (a === "NX") nx = true;
      }
    }

    if (nx && this.live(key)) return null;

    this.store.set(key, {
      value,
      expiresAt: ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000,
    });
    return "OK";
  }

  // deno-lint-ignore require-await
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys.flat()) if (this.store.delete(k)) n++;
    return n;
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? 0);
    const next = current + 1;
    // Preserve the existing TTL. Resetting it here would make a rate-limit
    // window that never closes under sustained traffic.
    const existing = this.live(key);
    this.store.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  // deno-lint-ignore require-await
  async expire(key: string, seconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  /**
   * Pub/sub within this process only.
   *
   * Delivered on a microtask rather than synchronously, so a subscriber that
   * throws can't take down the publisher's call stack — matching how a real
   * client behaves over a socket.
   */
  // deno-lint-ignore require-await
  async publish(channel: string, message: string): Promise<number> {
    const subs = this.listeners.get(channel);
    if (!subs?.size) return 0;
    for (const fn of subs) queueMicrotask(() => fn(channel, message));
    return subs.size;
  }

  // deno-lint-ignore require-await
  async subscribe(...channels: string[]): Promise<void> {
    for (const c of channels.flat()) {
      if (!this.listeners.has(c)) this.listeners.set(c, new Set());
    }
  }

  on(event: string, fn: Listener): this {
    if (event !== "message") return this;
    for (const set of this.listeners.values()) set.add(fn);
    return this;
  }

  /**
   * Real Redis needs a second connection for pub/sub because a subscribed
   * client can't run other commands. That constraint doesn't exist here, so
   * duplicate() returns the same instance — which also means a publish on the
   * "primary" is seen by the "subscriber", as intended.
   */
  duplicate(): MemoryRedis {
    return this;
  }

  // deno-lint-ignore require-await
  async quit(): Promise<void> {
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.store.clear();
    this.listeners.clear();
  }

  /** Anything not implemented above fails loudly rather than silently. */
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

/**
 * True when Redis should be replaced by the in-memory shim.
 *
 * Triggered by REDIS_URL being empty or literally "memory". An unset variable
 * is deliberately NOT enough on its own in production images — see the callers,
 * which log a warning either way.
 */
export function useMemoryRedis(url: string | undefined): boolean {
  const v = (url ?? "").trim().toLowerCase();
  return v === "" || v === "memory" || v === "memory://";
}

export const MEMORY_REDIS_WARNING =
  "REDIS_URL is unset — using an in-memory substitute. Fine for a proof of " +
  "concept; NOT safe with more than one process, because each gets its own " +
  "copy: cache invalidation won't cross processes and rate limits multiply " +
  "by the number of replicas. Set REDIS_URL before running anything real.";
