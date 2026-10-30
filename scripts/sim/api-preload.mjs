// scripts/sim/api-preload.mjs
//
// Loaded before the real API with node --import. Node has no network permission
// flag to lean on the way bot-entry.ts does, so this swaps Discord's address for
// the fake one and refuses everything else that isn't on this machine.

import { monitorEventLoopDelay } from "node:perf_hooks";

const origin = process.env.SIM_DISCORD_ORIGIN;
if (!origin) throw new Error("api-preload.mjs is started by run.ts");

const realFetch = globalThis.fetch;
const DISCORD = "https://discord.com";

globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (raw.startsWith(DISCORD)) {
    const url = origin + raw.slice(DISCORD.length);
    return input instanceof Request ? realFetch(new Request(url, input), init) : realFetch(url, init);
  }
  const host = new URL(raw).hostname;
  if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  console.log(JSON.stringify({ sim: "blocked", host }));
  return Promise.reject(new Error(`simulator: refused to reach ${host}`));
};

const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
setInterval(() => {
  const m = process.memoryUsage();
  console.log(JSON.stringify({
    sim: "api",
    at: Date.now(),
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    lagMs: Math.round(delay.max / 1e6),
  }));
  delay.reset();
}, 10_000).unref();
