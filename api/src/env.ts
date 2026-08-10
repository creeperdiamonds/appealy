// api/src/env.ts

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  PORT: Number(optional("PORT", "3001")),
  DATABASE_URL: required("DATABASE_URL"),
  // The API now needs Redis for the OAuth state store, the guild
  // permission cache, and per-guild API rate limiting. Optional with a
  // localhost default to match the bot's env module, so a dev machine
  // running `docker compose up redis` needs no extra configuration.
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),
  DISCORD_CLIENT_ID: required("DISCORD_CLIENT_ID"),
  DISCORD_CLIENT_SECRET: required("DISCORD_CLIENT_SECRET"),
  DISCORD_REDIRECT_URI: required("DISCORD_REDIRECT_URI"),
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  SESSION_SECRET: required("SESSION_SECRET"),
  TOKEN_ENCRYPTION_KEY: required("TOKEN_ENCRYPTION_KEY"), // 32-byte hex key for AES-256-GCM
  STRIPE_SECRET_KEY: required("STRIPE_SECRET_KEY"),
  STRIPE_WEBHOOK_SECRET: required("STRIPE_WEBHOOK_SECRET"),
  FRONTEND_ORIGIN: optional("FRONTEND_ORIGIN", "http://localhost:5173"),
  NODE_ENV: optional("NODE_ENV", "development"),
} as const;
