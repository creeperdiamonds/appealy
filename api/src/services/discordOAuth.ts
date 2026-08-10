// api/src/services/discordOAuth.ts
// Thin wrapper around Discord's OAuth2 token + identity endpoints.
// Scopes requested: identify, guilds — enough to know who the user is and
// which guilds they administrate, without ever touching their messages.

const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string; // bitfield as string
}

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<DiscordTokenResponse> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function refreshToken(
  refreshTokenValue: string,
  clientId: string,
  clientSecret: string,
): Promise<DiscordTokenResponse> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
    }),
  });
  if (!res.ok) {
    throw new Error(`Discord token refresh failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Discord user: ${res.status}`);
  return res.json();
}

export async function fetchUserGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user guilds: ${res.status}`);
  return res.json();
}

/** Guilds where the user is owner or has Administrator/Manage Guild — the
 * set eligible to appear in the dashboard's guild switcher. Fine-grained
 * per-form manager access (beyond this list) is resolved separately via
 * staff_permissions once a specific guild is opened. */
export function filterManageableGuilds(guilds: DiscordGuildSummary[]): DiscordGuildSummary[] {
  return guilds.filter((g) => {
    if (g.owner) return true;
    const perms = BigInt(g.permissions);
    return (perms & ADMINISTRATOR) === ADMINISTRATOR || (perms & MANAGE_GUILD) === MANAGE_GUILD;
  });
}
