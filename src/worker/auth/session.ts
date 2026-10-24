// Sessions: an opaque bearer token per signed-in device.
//
// The token is 32 random bytes, handed to the client once. The server keeps
// only its SHA-256, so the sessions table is useless to anyone who reads it.
// There is no expiry in v1 — signing out or deleting the account ends a session —
// and `last_seen_at` is written at most once a day, so an active player costs
// one D1 write a day rather than one per request.

import type { Context } from "hono";
import type { Env } from "../env";
import { sha256Hex } from "./appleToken.ts";
import { touchSession, userBySessionHash, type AccountUser } from "../db/users.ts";

const TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 128;

export function newSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** The bearer token on a request, or null. Bounded, so a huge header costs nothing. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** True when `lastSeenAt` (a D1 `datetime('now')` string, UTC) is not today. */
export function needsTouch(lastSeenAt: string, now: Date = new Date()): boolean {
  return lastSeenAt.slice(0, 10) !== now.toISOString().slice(0, 10);
}

/**
 * The signed-in user behind a request, or null for a guest.
 *
 * A missing, malformed or revoked token all read as "guest": the routes that
 * require an account answer 401, and every other route simply behaves as it
 * always has.
 */
export async function currentUser<E extends { Bindings: Env }>(
  c: Context<E>
): Promise<(AccountUser & { tokenHash: string }) | null> {
  const token = bearerToken(c.req.raw);
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  const user = await userBySessionHash(c.env.DB, tokenHash);
  if (!user) return null;
  if (needsTouch(user.lastSeenAt)) await touchSession(c.env.DB, tokenHash);
  return { id: user.id, displayName: user.displayName, tokenHash };
}

export function unauthorized<E extends { Bindings: Env }>(c: Context<E>) {
  return c.json({ error: "UNAUTHORIZED", messageHe: "צריך להתחבר מחדש." }, 401);
}
