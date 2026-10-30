// scripts/sim/bot-entry.ts
//
// Starts the real bot (SIM_BOT_MAIN) with Discord's address swapped for the fake
// one. The bot's own code is not changed in any way, and run.ts starts this with
// --allow-net limited to this machine, so even a mistake here cannot reach the
// real Discord: Deno refuses the connection.

const origin = Deno.env.get("SIM_DISCORD_ORIGIN");
const main = Deno.env.get("SIM_BOT_MAIN");
if (!origin || !main) throw new Error("bot-entry.ts is started by run.ts");

// main.ts listens for SIGTERM, which Deno only supports off Windows.
if (Deno.build.os === "windows") {
  const realAdd = Deno.addSignalListener;
  Object.defineProperty(Deno, "addSignalListener", {
    value: (signal: Deno.Signal, handler: () => void) => {
      if (signal !== "SIGTERM") realAdd(signal, handler);
    },
  });
}

const realFetch = globalThis.fetch;
const DISCORD = "https://discord.com";

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (!raw.startsWith(DISCORD)) return realFetch(input, init);
  const url = origin + raw.slice(DISCORD.length);
  return input instanceof Request ? realFetch(new Request(url, input), init) : realFetch(url, init);
}) as typeof fetch;

// One line every 10 seconds: how far timers run late is how far everything else
// runs late too, including gateway heartbeats.
const TICK_MS = 1000;
let last = performance.now();
let worstLag = 0;
setInterval(() => {
  const now = performance.now();
  worstLag = Math.max(worstLag, now - last - TICK_MS);
  last = now;
}, TICK_MS);
setInterval(() => {
  const m = Deno.memoryUsage();
  console.log(JSON.stringify({
    sim: "bot",
    at: Date.now(),
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    lagMs: Math.round(worstLag),
  }));
  worstLag = 0;
}, 10_000);

await import(main);
