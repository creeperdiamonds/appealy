// bot/src/utils/logger.ts
// Minimal structured logger shared across the bot process. Swap the
// implementation for pino/winston-equivalent if you need log shipping;
// the call-site API (info/warn/error/debug) stays stable either way.

import { describeDiscordError } from "./discordError.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): number {
  const lvl = (Deno.env.get("LOG_LEVEL") ?? "info") as Level;
  return LEVELS[lvl] ?? LEVELS.info;
}

/**
 * Error objects in the fields are written out readably. JSON.stringify turns
 * an Error into {}, and String(err) on a Discord failure gives only
 * Discordeno's "Failed to send request to discord.", the same sentence for a
 * closed DM, a missing permission and a refused popup. So a Discord error
 * becomes its own message, plus status, code and any refused fields (unless
 * the caller already set those); any other error stays String(err).
 */
function expandErrors(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(meta)) {
    if (!(value instanceof Error)) continue;
    const info = describeDiscordError(value);
    if (info.status === null && info.code === null) {
      out[key] = String(value);
      continue;
    }
    out[key] = info.message;
    if (!("status" in meta) && info.status !== null) out.status = info.status;
    if (!("code" in meta) && info.code !== null) out.code = info.code;
    if (!("fields" in meta) && info.fields) out.fields = info.fields;
  }
  return out;
}

/** One log line as JSON. Exported for tests. */
export function formatLogLine(level: Level, msg: string, meta?: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? expandErrors(meta) : {}),
  });
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const line = formatLogLine(level, msg, meta);
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
