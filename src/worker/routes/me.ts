// The signed-in user's own account.
//
//   GET    /api/me               -> { user, stats }
//   PATCH  /api/me               { displayName } -> { user }
//   POST   /api/me/merge-local   { played, wins, losses, bestStreak } -> { merged, stats }
//   DELETE /api/me               revokes the Apple grant, deletes the account
//
// All of them require a session; a guest gets 401 and nothing else here changes for
// them.

import { Hono } from "hono";
import type { Env } from "../env";
import { currentUser, unauthorized } from "../auth/session";
import {
  clampLocalStats,
  deleteUser,
  getAppleRefreshToken,
  getUserStats,
  mergeLocalStats,
  updateDisplayName,
} from "../db/users";
import { appleClientConfig, revokeAppleToken } from "../auth/appleClient";
import { APP_BUNDLE_ID } from "./auth";
import { sanitizePlayerName } from "../../shared/multiplayer/names";
import { gate } from "../lib/ratelimit";

export const meRoutes = new Hono<{ Bindings: Env }>();

meRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  if (!user) return unauthorized(c);
  const stats = await getUserStats(c.env.DB, user.id);
  return c.json({ user: { displayName: user.displayName }, stats });
});

meRoutes.patch("/", async (c) => {
  const limited = await gate(c, "RL_WRITE", "me");
  if (limited) return limited;

  const user = await currentUser(c);
  if (!user) return unauthorized(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const displayName = sanitizePlayerName((body as Record<string, unknown> | null)?.displayName);
  if (!displayName) {
    return c.json({ error: "INVALID_NAME", messageHe: "השם לא תקין. נסו שם אחר." }, 400);
  }

  await updateDisplayName(c.env.DB, user.id, displayName);
  return c.json({ user: { displayName } });
});

/**
 * The device's own duel record, folded in once per account.
 *
 * The numbers are the client's word, so they are clamped and kept consistent,
 * and the server accepts them exactly once: a second call — another device, or
 * signing out and in again — changes nothing.
 */
meRoutes.post("/merge-local", async (c) => {
  const limited = await gate(c, "RL_WRITE", "me-merge");
  if (limited) return limited;

  const user = await currentUser(c);
  if (!user) return unauthorized(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const local = clampLocalStats(body);
  if (!local) return c.json({ error: "Invalid request body" }, 400);

  const merged = await mergeLocalStats(c.env.DB, user.id, local);
  return c.json({ merged, stats: await getUserStats(c.env.DB, user.id) });
});

/**
 * Deletes the account: App Store guideline 5.1.1(v).
 *
 * The Apple grant is revoked first when there is one to revoke, so the app also
 * disappears from the player's Apple ID settings. A failed revoke is logged and
 * does not block the deletion — the player asked for their data to go, and it
 * goes.
 */
meRoutes.delete("/", async (c) => {
  const limited = await gate(c, "RL_WRITE", "me-delete");
  if (limited) return limited;

  const user = await currentUser(c);
  if (!user) return unauthorized(c);

  const apple = appleClientConfig(c.env, APP_BUNDLE_ID);
  const refreshToken = await getAppleRefreshToken(c.env.DB, user.id);
  if (apple && refreshToken) {
    try {
      await revokeAppleToken(apple, refreshToken);
    } catch (err) {
      console.error("me: apple revoke threw", { name: (err as Error)?.name });
    }
  }

  await deleteUser(c.env.DB, user.id);
  return c.json({ deleted: true });
});
