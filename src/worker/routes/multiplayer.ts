import { Hono } from "hono";
import { isValidRoomCode } from "../../shared/multiplayer/roomCode";
import { MODES } from "../../shared/multiplayer/constants";
import type { MultiplayerMode } from "../../shared/multiplayer/types";
import { allocateRoom, roomStub } from "../multiplayer/allocate";
import { gate } from "../lib/ratelimit";
import { ACCOUNT_USER_HEADER, userIdForToken } from "../auth/session";
import type { Env } from "../env";

export const multiplayerRoutes = new Hono<{ Bindings: Env }>();

/**
 * The single matchmaking queue.
 *
 * One object, one name. Sharding it would split the pool and make matching
 * slower, not faster — and at this scale a queue that serialises a few dozen
 * arrivals per second is nowhere near a bottleneck. If it ever becomes one, the
 * shard key goes here and nothing else changes.
 */
const MATCHMAKER_NAME = "global-v1";

const HOST_SELECTABLE = new Set(MODES.filter((m) => m.hostSelectable).map((m) => m.code));

/**
 * Creates a private room.
 *
 * The response is just a code. Nothing about the Durable Object is exposed — no
 * id, no colo, no internal name — so a client has no handle on the room other
 * than the six digits it is expected to share.
 *
 * Metered, because an unmetered loop here mints Durable Objects for free and
 * eats into a six-digit code space; the limit is set well above what a person
 * opening rooms for friends could reach.
 */
multiplayerRoutes.post("/rooms", async (c) => {
  const limited = await gate(c, "RL_ROOM_CREATE", "create");
  if (limited) return limited;

  let mode: MultiplayerMode = "CLASSIC_BATTLE";
  try {
    const body = (await c.req.json()) as { mode?: unknown };
    if (typeof body.mode === "string" && HOST_SELECTABLE.has(body.mode as MultiplayerMode)) {
      mode = body.mode as MultiplayerMode;
    }
  } catch {
    // An empty or malformed body is fine: the default mode is a real choice the
    // host can change in the lobby anyway.
  }

  const code = await allocateRoom(c.env, mode);
  if (!code) return c.json({ error: "Could not allocate a room code" }, 503);
  return c.json({ code, mode });
});

/**
 * "Does this room exist and can I still get in?" — used before showing the name
 * prompt.
 *
 * THIS IS THE ENUMERATION SURFACE. Six digits is a million codes, the answer is
 * a clean 200-or-404, and there is nothing secret about a room beyond its code —
 * so with no limit, walking the space finds every live room in the product in
 * minutes. Three things make that unattractive, and none of them is enough
 * alone:
 *
 *   * the lookup is metered per client address, which turns minutes into years
 *   * a malformed code is answered with the same 404 as a well-formed absent
 *     one, on the same path and after the same work, so neither the status nor
 *     the shape of the response distinguishes "not a code" from "no such room"
 *   * rooms are short-lived by construction (empty rooms are swept after ten
 *     minutes, idle ones after two hours), so a harvested list goes stale
 *
 * What is NOT claimed: a code is not a secret and never was. Anyone who has it
 * can join, which is the whole design — it is read aloud across a room. The
 * limit is about making the space expensive to sweep, not about making a single
 * code unguessable.
 */
multiplayerRoutes.get("/rooms/:code", async (c) => {
  const limited = await gate(c, "RL_ROOM_LOOKUP", "lookup");
  if (limited) return limited;

  const code = c.req.param("code");
  if (!isValidRoomCode(code)) return c.json({ error: "Room not found" }, 404);

  const summary = await roomStub(c.env, code).summary();
  if (!summary) return c.json({ error: "Room not found" }, 404);
  return c.json(summary);
});

/**
 * The room socket. Everything real happens over this.
 *
 * The request is handed to the Durable Object as sent — player token and display
 * flag included — except for the account session, which is swapped for a verified
 * user id (below).
 */
multiplayerRoutes.get("/rooms/:code/ws", async (c) => {
  const limited = await gate(c, "RL_SOCKET", "room-ws");
  if (limited) return limited;

  const code = c.req.param("code");
  if (!isValidRoomCode(code)) return c.json({ error: "Invalid room code" }, 400);
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  // A signed-in player's session rides along as `a`, because a WebSocket cannot
  // carry an Authorization header. It is resolved here and never reaches the
  // room: the room only ever sees a user id this Worker verified.
  const url = new URL(c.req.url);
  const accountToken = url.searchParams.get("a");
  url.searchParams.delete("a");
  const forwarded = new Request(url.toString(), c.req.raw);
  forwarded.headers.delete(ACCOUNT_USER_HEADER);
  const userId = await userIdForToken(c.env.DB, accountToken);
  if (userId !== null) forwarded.headers.set(ACCOUNT_USER_HEADER, String(userId));

  return roomStub(c.env, code).fetch(forwarded);
});

multiplayerRoutes.get("/matchmaking/ws", async (c) => {
  const limited = await gate(c, "RL_SOCKET", "mm-ws");
  if (limited) return limited;

  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }
  const stub = c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName(MATCHMAKER_NAME));
  return stub.fetch(c.req.raw);
});
