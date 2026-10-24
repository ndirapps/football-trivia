// Sign in and sign out.
//
//   POST /api/auth/apple    { identityToken, nonce, displayName? } -> { token, user, stats }
//   POST /api/auth/signout  ends the session the request carries
//
// The Apple `authorizationCode` the app also receives is accepted and ignored
// for now: exchanging it for a refresh token needs the Sign in with Apple key,
// and the only use of that refresh token is revoking the grant when an account
// is deleted. That arrives with account deletion.

import { Hono } from "hono";
import type { Env } from "../env";
import { verifyAppleIdentityToken } from "../auth/appleToken";
import { bearerToken, hashSessionToken, newSessionToken } from "../auth/session";
import { deleteSession, findOrCreateAppleUser, getUserStats, insertSession } from "../db/users";
import { sanitizePlayerName } from "../../shared/multiplayer/names";
import { gate } from "../lib/ratelimit";

export const authRoutes = new Hono<{ Bindings: Env }>();

/** The audience Apple puts in tokens issued to the iOS app. */
export const APP_BUNDLE_ID = "com.royasraf.footballiq";
/** What a brand-new account is called when the player has not chosen a name yet. */
const DEFAULT_DISPLAY_NAME = "שחקן";
/** Apple identity tokens are around 1KB; this is slack against a hostile body. */
const MAX_IDENTITY_TOKEN_LENGTH = 4096;
const MAX_NONCE_LENGTH = 128;

authRoutes.post("/apple", async (c) => {
  const limited = await gate(c, "RL_AUTH", "apple");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) return c.json({ error: "Invalid request body" }, 400);
  const b = body as Record<string, unknown>;

  const identityToken = typeof b.identityToken === "string" ? b.identityToken : "";
  const nonce = typeof b.nonce === "string" ? b.nonce : "";
  if (!identityToken || identityToken.length > MAX_IDENTITY_TOKEN_LENGTH || !nonce || nonce.length > MAX_NONCE_LENGTH) {
    return c.json({ error: "identityToken and nonce required" }, 400);
  }

  const verified = await verifyAppleIdentityToken(identityToken, { audience: APP_BUNDLE_ID, rawNonce: nonce });
  if (!verified.ok) {
    console.error("auth: apple token rejected", { reason: verified.reason });
    return c.json({ error: "INVALID_TOKEN", messageHe: "ההתחברות עם Apple לא הצליחה. נסו שוב." }, 401);
  }

  const displayName = sanitizePlayerName(b.displayName) ?? DEFAULT_DISPLAY_NAME;
  const user = await findOrCreateAppleUser(c.env.DB, verified.sub, displayName);

  const token = newSessionToken();
  await insertSession(c.env.DB, user.id, await hashSessionToken(token));
  const stats = await getUserStats(c.env.DB, user.id);

  return c.json({ token, user: { displayName: user.displayName, isNew: user.created }, stats });
});

authRoutes.post("/signout", async (c) => {
  const token = bearerToken(c.req.raw);
  if (token) await deleteSession(c.env.DB, await hashSessionToken(token));
  return c.json({ ok: true });
});
