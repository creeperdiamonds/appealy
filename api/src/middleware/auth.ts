// api/src/middleware/auth.ts

import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { decrypt, encrypt } from "../utils/crypto.ts";
import { refreshToken } from "../services/discordOAuth.ts";
import { env } from "../env.ts";

// Augment Express's Request type with the fields our middleware attaches.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: bigint;
      discordAccessToken?: string;
    }
  }
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.appealy_session;
  if (!sessionId) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, sessionId),
  });
  if (!session) {
    return res.status(401).json({ error: "session_not_found" });
  }

  // Transparently refresh if the Discord access token is expired or about
  // to expire, so route handlers never have to think about token lifetime.
  let accessToken = decrypt(session.accessTokenEnc);
  if (session.expiresAt.getTime() - Date.now() < 60_000) {
    try {
      const refreshed = await refreshToken(
        decrypt(session.refreshTokenEnc),
        env.DISCORD_CLIENT_ID,
        env.DISCORD_CLIENT_SECRET,
      );
      accessToken = refreshed.access_token;
      await db
        .update(schema.sessions)
        .set({
          accessTokenEnc: encrypt(refreshed.access_token),
          refreshTokenEnc: encrypt(refreshed.refresh_token),
          expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        })
        .where(eq(schema.sessions.id, session.id));
    } catch {
      return res.status(401).json({ error: "token_refresh_failed" });
    }
  }

  req.sessionId = session.id;
  req.userId = session.userId;
  req.discordAccessToken = accessToken;
  next();
}
