// The signed-in user's own account.
//
//   GET   /api/me   -> { user, stats }
//   PATCH /api/me   { displayName } -> { user }
//
// Both require a session; a guest gets 401 and nothing else here changes for
// them.

import { Hono } from "hono";
import type { Env } from "../env";
import { currentUser, unauthorized } from "../auth/session";
import { getUserStats, updateDisplayName } from "../db/users";
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
