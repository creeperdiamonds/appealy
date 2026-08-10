// bot/src/core/env.ts
// Centralized, validated environment configuration for the bot process.

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

export const env = {
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  DISCORD_APPLICATION_ID: required("DISCORD_APPLICATION_ID"),
  DISCORD_PUBLIC_KEY: required("DISCORD_PUBLIC_KEY"),
  DATABASE_URL: required("DATABASE_URL"),
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  NODE_ENV: optional("APPEALY_ENV", "development"),
} as const;
