// The random-duel matchmaking queue.
//
// One Durable Object holds the whole queue. That is the point: a single-threaded
// object cannot double-book a player, so "no player is matched twice" and "no
// pair is formed twice" are properties of the runtime rather than of a lock we
// have to get right. Ten players arriving at once are processed one at a time, in
// arrival order, and the odd one out is simply still in the queue afterwards.
//
// THE QUEUE IS THE SOCKETS. There is no stored list of waiting players. A player
// is in the queue if and only if they have an accepted WebSocket whose attachment
// says SEARCHING, and `ctx.getWebSockets()` only returns live sockets — so a
// closed tab leaves the queue by construction and there is no such thing as a
// stale entry to garbage-collect. Attachments survive hibernation, so this holds
// across an eviction too.
//
// A half-dead socket (network gone, no close frame) is a different problem, and is
// handled by the heartbeat: every waiting player is sent a status message every
// couple of seconds, and a send that throws removes them. The heartbeat doubles as
// the rotating "מחפש יריב…" copy, so the liveness check is also the feature.

import { DurableObject } from "cloudflare:workers";
import {
  MATCHMAKING_TIMEOUT_MS,
  PING,
  PONG,
  randomDuelSettings,
} from "../../shared/multiplayer/constants";
import { sanitizePlayerName } from "../../shared/multiplayer/names";
import { blockKeyOf, nameBlockKey } from "../../shared/multiplayer/moderation";
import { errorMessage, parseClientMessage, type ServerMessage } from "../../shared/multiplayer/protocol";
import type { MatchmakingState } from "../../shared/multiplayer/types";
import { allocateRoom } from "../multiplayer/allocate";
import type { Env } from "../env";

interface QueueAttachment {
  state: MatchmakingState;
  name: string;
  queuedAt: number;
  /** The player's reconnect token, so the same person cannot occupy two slots. */
  token: string;
  /** This player's own block key, and the keys of players they blocked. */
  key?: string;
  blocked?: string[];
  /** Normalized names this player blocked (see nameBlockKey). */
  blockedNames?: string[];
}

/** How often waiting players are pinged and pairing is retried. */
const HEARTBEAT_MS = 2500;

export class MatchmakerDurableObject extends DurableObject<Env> {
  /**
   * The same ping/pong contract the room socket has.
   *
   * This queue does not need it to stay alive — the 2.5s status heartbeat above
   * is already both its liveness check and its rotating copy. It is registered
   * so the two sockets in the product speak the same protocol: without it, a
   * client heartbeat pointed at this socket would fall through to
   * `webSocketMessage`, fail to parse as a protocol message, and come back as an
   * INVALID_MESSAGE error every twenty seconds. Two lines now, rather than a
   * confusing bug for whoever shares the heartbeat helper later.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get("t") ?? "";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (!token || token.length < 8 || token.length > 128) {
      server.accept();
      server.send(JSON.stringify(errorMessage("INVALID_MESSAGE")));
      server.close(1000, "invalid token");
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ state: "IDLE", name: "", queuedAt: 0, token } satisfies QueueAttachment);
    this.post(server, this.status("IDLE", 0, 0, false));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ helpers

  private attachmentOf(ws: WebSocket): QueueAttachment | null {
    try {
      const raw = ws.deserializeAttachment();
      return raw && typeof raw === "object" ? (raw as QueueAttachment) : null;
    } catch {
      return null;
    }
  }

  /**
   * Sends, and reports whether the socket is still alive.
   *
   * The boolean is the liveness signal the heartbeat relies on: a socket whose
   * peer vanished without closing throws here, and the caller drops it.
   */
  private post(ws: WebSocket, message: ServerMessage): boolean {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private status(state: MatchmakingState, queueSize: number, waitedMs: number, timedOut: boolean): ServerMessage {
    return { type: "MATCHMAKING_STATUS", state, queueSize, waitedMs, timedOut };
  }

  /** Everyone currently searching, oldest first — first in, first matched. */
  private waiting(): { ws: WebSocket; entry: QueueAttachment }[] {
    const rows: { ws: WebSocket; entry: QueueAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const entry = this.attachmentOf(ws);
      if (entry?.state === "SEARCHING") rows.push({ ws, entry });
    }
    return rows.sort((a, b) => a.entry.queuedAt - b.entry.queuedAt);
  }

  private setEntry(ws: WebSocket, entry: QueueAttachment): void {
    try {
      ws.serializeAttachment(entry);
    } catch {
      /* socket already gone; the next getWebSockets() will not list it */
    }
  }

  // ----------------------------------------------------------------- handlers

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    if (typeof raw !== "string") return;
    const entry = this.attachmentOf(ws);
    if (!entry) return;

    const message = parseClientMessage(raw);
    if (!message) {
      this.post(ws, errorMessage("INVALID_MESSAGE"));
      return;
    }

    if (message.type === "JOIN_MATCHMAKING") {
      // Already looking: re-sending is a no-op rather than a second slot. This is
      // the "no duplicate queue entries" rule, and it holds for a reconnecting
      // client that re-sends on every retry.
      if (entry.state === "SEARCHING" || entry.state === "MATCHED") {
        this.post(ws, this.status(entry.state, this.waiting().length, Date.now() - entry.queuedAt, false));
        return;
      }

      const name = sanitizePlayerName(message.name);
      if (!name) {
        this.post(ws, errorMessage("INVALID_NAME"));
        return;
      }

      // The same person on two tabs holds one place in the queue, not two —
      // otherwise they could be matched against themselves.
      for (const other of this.waiting()) {
        if (other.entry.token === entry.token && other.ws !== ws) {
          this.setEntry(other.ws, { ...other.entry, state: "CANCELLED" });
          this.post(other.ws, this.status("CANCELLED", 0, 0, false));
        }
      }

      const now = Date.now();
      this.setEntry(ws, {
        ...entry,
        state: "SEARCHING",
        name,
        queuedAt: now,
        key: blockKeyOf(entry.token),
        blocked: message.blocked,
        blockedNames: message.blockedNames,
      });
      this.post(ws, this.status("SEARCHING", this.waiting().length, 0, false));

      await this.pair();
      await this.scheduleHeartbeat();
      return;
    }

    if (message.type === "CANCEL_MATCHMAKING") {
      this.setEntry(ws, { ...entry, state: "CANCELLED", queuedAt: 0 });
      this.post(ws, this.status("CANCELLED", this.waiting().length, 0, false));
      await this.scheduleHeartbeat();
      return;
    }

    this.post(ws, errorMessage("INVALID_MESSAGE"));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Nothing to clean up: a closed socket is no longer in getWebSockets(), so it
    // has already left the queue. Reschedule in case it was the last one waiting.
    void ws;
    await this.scheduleHeartbeat();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    void ws;
    await this.scheduleHeartbeat();
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // Heartbeat: keeps the searching UI moving, and evicts sockets whose peer has
    // gone without a close frame.
    for (const { ws, entry } of this.waiting()) {
      const waited = now - entry.queuedAt;
      const timedOut = waited >= MATCHMAKING_TIMEOUT_MS;
      const alive = this.post(ws, this.status("SEARCHING", this.waiting().length, waited, timedOut));
      if (!alive) {
        try {
          ws.close(1011, "unreachable");
        } catch {
          /* already gone */
        }
      }
    }

    await this.pair();
    await this.scheduleHeartbeat();
  }

  private async scheduleHeartbeat(): Promise<void> {
    const hasQueue = this.waiting().length > 0;
    const current = await this.ctx.storage.getAlarm();
    if (!hasQueue) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  // ------------------------------------------------------------------ pairing

  /**
   * Pairs off the queue, oldest two first, until fewer than two remain.
   *
   * Every pair gets a brand new room whose settings are the fixed random-duel
   * rules, so both players get the same questions in the same order with the same
   * timer — the room, not the clients, decides all of it.
   */
  private async pair(): Promise<void> {
    for (;;) {
      const queue = this.waiting();
      if (queue.length < 2) return;

      const match = firstCompatiblePair(queue);
      if (!match) return;
      const [a, b] = match;

      // Claimed before the await so that nothing re-enters and matches either of
      // them again while the room is being created.
      this.setEntry(a.ws, { ...a.entry, state: "MATCHED" });
      this.setEntry(b.ws, { ...b.entry, state: "MATCHED" });

      const code = await allocateRoom(this.env, "RANDOM_DUEL", randomDuelSettings());

      if (!code) {
        // Could not get a room. Put both back rather than dropping them.
        this.setEntry(a.ws, { ...a.entry, state: "SEARCHING" });
        this.setEntry(b.ws, { ...b.entry, state: "SEARCHING" });
        this.post(a.ws, errorMessage("SERVER_ERROR"));
        this.post(b.ws, errorMessage("SERVER_ERROR"));
        return;
      }

      this.post(a.ws, { type: "MATCH_FOUND", roomCode: code, opponentName: b.entry.name });
      this.post(b.ws, { type: "MATCH_FOUND", roomCode: code, opponentName: a.entry.name });
    }
  }
}

type Waiting = { ws: WebSocket; entry: QueueAttachment };

/** True when either player has blocked the other. */
function blocks(a: QueueAttachment, b: QueueAttachment): boolean {
  return blocksOneWay(a, b) || blocksOneWay(b, a);
}

function blocksOneWay(blocker: QueueAttachment, other: QueueAttachment): boolean {
  if (other.key && blocker.blocked?.includes(other.key)) return true;
  return Boolean(blocker.blockedNames?.includes(nameBlockKey(other.name)));
}

/**
 * The oldest two players who have not blocked each other. Blocking (App Store
 * guideline 1.2) means a blocked player is never put in front of the blocker
 * again, so an incompatible pair is skipped rather than matched.
 */
function firstCompatiblePair(queue: Waiting[]): [Waiting, Waiting] | null {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (!blocks(queue[i].entry, queue[j].entry)) return [queue[i], queue[j]];
    }
  }
  return null;
}
