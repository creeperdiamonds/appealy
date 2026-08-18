// api/src/utils/logger.ts
//
// The Node counterpart to bot/src/utils/logger.ts. Same call-site API
// (debug/info/warn/error with an optional meta object) and the same one-JSON-
// object-per-line output, so the two processes produce logs that can be read
// and queried the same way — which matters because they are usually read
// together when tracing a request from the dashboard through to Discord.
//
// The only difference is where the level comes from: process.env here,
// Deno.env there. Keep the two in step if you change the shape of a line.
//
// Swap the implementation for pino if you need log shipping; nothing outside
// this file should have to change.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Read per call rather than cached at import: env.ts logs during its own
// validation, so a cached level here would be read before the environment is
// known to be complete.
function currentLevel(): number {
  const lvl = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVELS[lvl] ?? LEVELS.info;
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
