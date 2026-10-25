// One Durable Object per live multiplayer room, addressed by its room code.
//
// The object is the only authority in the system. It owns the question set, the
// clock, the scores and the turn, and it is the only thing that decides whether
// an answer counted. Clients are renderers: they are told what phase they are in
// and what to draw, and the worst a tampered client can do is send a message
// that gets rejected.
//
// This file is deliberately thin. All the rules live in RoomEngine (shared, pure,
// unit-tested); everything here is plumbing:
//
//   sockets      accept, attach identity, broadcast, drop
//   persistence  the engine's state in Durable Object storage
//   scheduling   one alarm, always set to the engine's next wake time
//   questions    the one async dependency, fetched from D1 and handed in
//   history      a single pair of D1 writes when a game finishes
//
// WHY HIBERNATION. `acceptWebSocket` rather than `accept` means the runtime may
// evict this object from memory between messages while the sockets stay open. A
// lobby of six people waiting for a seventh therefore costs nothing while it
// waits. The cost of that is that in-memory state cannot be trusted across
// messages, which is why the engine is rehydrated from storage on every entry
// point and each socket carries its own identity in its attachment.

import { DurableObject } from "cloudflare:workers";
import type { Question } from "../../shared/types";
import { RoomEngine, type Effect, type RoomState } from "../../shared/multiplayer/roomEngine";
import { parseClientMessage, errorMessage, type ServerMessage } from "../../shared/multiplayer/protocol";
import { defaultSettings, PING, PONG } from "../../shared/multiplayer/constants";
import type { GameResult, MultiplayerMode, RoomSettings } from "../../shared/multiplayer/types";
import { hydrateQuestions, pickQuestionIds } from "../db/questions";
import type { Env } from "../env";
import { ACCOUNT_USER_HEADER } from "../auth/session";
import { duelOutcome, recordRoomForUserStatement } from "../db/users";
import { isDuelMode } from "../../shared/multiplayer/constants";

/** What a socket remembers about itself across a hibernation cycle. */
interface SocketAttachment {
  /** null for a socket that has connected but not yet sent JOIN_ROOM (and for display screens). */
  playerId: string | null;
  token: string;
  /** A read-only shared screen: it is broadcast to, but may never act. */
  display: boolean;
}

/** State minus the question bank — stored separately to keep each value small. */
type StoredState = Omit<RoomState, "questions">;

const STATE_KEY = "state";
const QUESTIONS_KEY = "questions";
/** Player token -> account user id, for the players who were signed in. */
const ACCOUNTS_KEY = "accounts";

export class RoomDurableObject extends DurableObject<Env> {
  /**
   * The heartbeat contract, installed once per object instance.
   *
   * WHY THIS EXISTS. The matchmaking queue has always had a heartbeat; a room
   * had none, and that asymmetry was the bug. A lobby waiting for a seventh
   * player sends nothing and receives nothing, sometimes for minutes. A mobile
   * carrier NAT or an iOS app-switch tears down an idle TCP connection without
   * either side sending a close frame, so:
   *
   *   * the room still lists the socket in getWebSockets() and still believes
   *     the player is present, because the only thing that would tell it
   *     otherwise is a failed send, and in a lobby there is nothing to send
   *   * the client's WebSocket still reports OPEN, so it shows no reconnecting
   *     badge and keeps rendering a lobby
   *   * the player taps "start", `send()` writes into a dead socket and returns
   *     true, and nothing happens, ever
   *
   * That last state is what reads as "the server stopped responding": the
   * server is fine, the socket is not, and nothing was watching.
   *
   * `setWebSocketAutoResponse` is the right tool because it is answered by the
   * runtime without waking this object — a hibernating lobby stays hibernating
   * and stays free, which is the whole reason hibernation is used here. The
   * client pings on a timer and treats silence as a dead connection; see
   * `useRoom`. Traffic in both directions also keeps the intermediaries that
   * cause this from deciding the connection is idle in the first place.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Atomically takes ownership of this room code.
   *
   * This is the whole of room-code uniqueness. A Durable Object handles one
   * request at a time, so two players creating a room in the same millisecond
   * cannot both see "unclaimed" — the second one is told no and retries with a
   * different code. No central allocator, no registry to queue behind.
   */
  async claim(mode: MultiplayerMode, settings?: Partial<RoomSettings>): Promise<boolean> {
    const existing = await this.ctx.storage.get<StoredState>(STATE_KEY);
    if (existing && !existing.closed) return false;

    const engine = RoomEngine.create(this.roomCode(), { ...defaultSettings(mode), ...settings }, Date.now());
    await this.write(engine);
    await this.reschedule(engine);
    return true;
  }

  /** Enough to render "does this room exist, and can I still get in?" without joining it. */
  async summary(): Promise<{ exists: boolean; phase: string; playerCount: number; mode: string } | null> {
    const state = await this.ctx.storage.get<StoredState>(STATE_KEY);
    if (!state || state.closed) return null;
    return {
      exists: true,
      phase: state.phase,
      playerCount: state.players.length,
      mode: state.settings.mode,
    };
  }

  /**
   * The room code, recovered from the object's own name.
   *
   * `idFromName(code)` is how the worker addresses this object, and the name
   * comes back out of the id, so the code never has to be passed in and can never
   * disagree with the address that reached us.
   */
  private roomCode(): string {
    return this.ctx.id.name ?? "";
  }

  // --------------------------------------------------------------- lifecycle

  private async read(): Promise<RoomEngine | null> {
    const [state, questions] = await Promise.all([
      this.ctx.storage.get<StoredState>(STATE_KEY),
      this.ctx.storage.get<Question[]>(QUESTIONS_KEY),
    ]);
    if (!state) return null;
    return new RoomEngine({ ...state, questions: questions ?? [] });
  }

  private async write(engine: RoomEngine): Promise<void> {
    const { questions, ...rest } = engine.state;
    // Two keys rather than one: a 30-question bank is tens of kilobytes and there
    // is no reason to rewrite it every time somebody taps an option.
    await this.ctx.storage.put({ [STATE_KEY]: rest, [QUESTIONS_KEY]: questions });
  }

  private async reschedule(engine: RoomEngine): Promise<void> {
    const at = engine.nextWakeAt();
    const current = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    // Only rewrite the alarm when it actually moves. A 50ms tolerance keeps a
    // burst of answers from churning the alarm on every message.
    if (current === null || Math.abs(current - at) > 50) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  // ------------------------------------------------------------------ routing

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return this.openSocket(url, request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async openSocket(url: URL, request: Request): Promise<Response> {
    const engine = await this.read();
    const token = url.searchParams.get("t") ?? "";
    const display = url.searchParams.get("display") === "1";

    if (!engine || engine.state.closed) {
      // The room does not exist. Answer over the socket rather than with an HTTP
      // error so the client has one error path instead of two.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify(errorMessage("INVALID_ROOM")));
      server.close(1000, "invalid room");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!token || token.length < 8 || token.length > 128) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify(errorMessage("INVALID_MESSAGE")));
      server.close(1000, "invalid token");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Set by the Worker from a verified session, never by the client (see
    // ACCOUNT_USER_HEADER). Remembered per token so full time can credit them.
    const accountUserId = Number(request.headers.get(ACCOUNT_USER_HEADER));
    if (!display && Number.isInteger(accountUserId) && accountUserId > 0) {
      const accounts = (await this.ctx.storage.get<Record<string, number>>(ACCOUNTS_KEY)) ?? {};
      if (accounts[token] !== accountUserId) {
        accounts[token] = accountUserId;
        await this.ctx.storage.put(ACCOUNTS_KEY, accounts);
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    // A returning player is recognised by their token before they say anything,
    // so a refresh restores them without a round trip through the name prompt.
    const known = display ? undefined : engine.playerByToken(token);
    const attachment: SocketAttachment = { playerId: known?.id ?? null, token, display };
    server.serializeAttachment(attachment);

    if (known) {
      known.connected = true;
      known.disconnectedAt = null;
      await this.write(engine);
      await this.reschedule(engine);
    }

    // The opening picture. `you` is filled in per socket, which is why ROOM_STATE
    // is rewritten on its way out rather than broadcast verbatim.
    const now = Date.now();
    this.post(server, { type: "ROOM_STATE", room: engine.view(now), you: attachment.playerId });

    // …and then the moment this socket walked into: the question on screen, the
    // reveal, the standings, whatever it happens to be. Without this a refresh
    // mid-round leaves a player staring at a scoreboard and an empty board.
    for (const message of engine.resumeMessages(attachment.playerId, now)) {
      this.post(server, message);
    }

    if (known) {
      // Tell the rest of the room they are back, and re-check whether their
      // return completes a round everyone else had already answered.
      await this.apply(engine, engine.join(token, known.name, Date.now()).effects);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ------------------------------------------------------------------ sockets

  private attachmentOf(ws: WebSocket): SocketAttachment | null {
    try {
      const raw = ws.deserializeAttachment();
      if (!raw || typeof raw !== "object") return null;
      return raw as SocketAttachment;
    } catch {
      return null;
    }
  }

  private post(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A socket that has gone away is removed by webSocketClose/webSocketError;
      // a failed send is not worth unwinding an in-flight game for.
    }
  }

  /**
   * Sends to every attached socket, rewriting ROOM_STATE's `you` for each one.
   *
   * That rewrite is the reason the engine leaves `you` null: the engine has no
   * concept of "which socket", and giving it one would drag socket bookkeeping
   * into the pure layer.
   */
  private broadcast(message: ServerMessage, exceptPlayerId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      if (!attachment) continue;
      if (exceptPlayerId && attachment.playerId === exceptPlayerId) continue;
      this.post(ws, message.type === "ROOM_STATE" ? { ...message, you: attachment.playerId } : message);
    }
  }

  private sendToPlayer(playerId: string, message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws);
      if (attachment?.playerId !== playerId) continue;
      this.post(ws, message.type === "ROOM_STATE" ? { ...message, you: playerId } : message);
    }
  }

  private dropPlayerSockets(playerId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachmentOf(ws)?.playerId !== playerId) continue;
      try {
        ws.close(1000, "removed");
      } catch {
        /* already gone */
      }
    }
  }

  // ----------------------------------------------------------------- handlers

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    if (typeof raw !== "string") return;
    const attachment = this.attachmentOf(ws);
    if (!attachment) return;

    const message = parseClientMessage(raw);
    if (!message) {
      this.post(ws, errorMessage("INVALID_MESSAGE"));
      return;
    }

    // A shared screen is a spectator by construction: it never gets a player id,
    // so every action below either needs one or is refused outright.
    if (attachment.display) {
      this.post(ws, errorMessage("NOT_JOINED"));
      return;
    }

    const engine = await this.read();
    if (!engine || engine.state.closed) {
      this.post(ws, errorMessage("ROOM_EXPIRED"));
      return;
    }

    const now = Date.now();

    if (message.type === "JOIN_ROOM") {
      const outcome = engine.join(attachment.token, message.name, now);
      if (outcome.error || !outcome.playerId) {
        this.post(ws, errorMessage(outcome.error ?? "SERVER_ERROR"));
        return;
      }
      ws.serializeAttachment({ ...attachment, playerId: outcome.playerId } satisfies SocketAttachment);
      await this.apply(engine, outcome.effects);
      // The joining socket needs its own `you` immediately; the broadcast above
      // only told it the roster.
      this.post(ws, { type: "ROOM_STATE", room: engine.view(now), you: outcome.playerId });
      await this.autoStartIfReady(engine, now);
      return;
    }

    if (!attachment.playerId) {
      this.post(ws, errorMessage("NOT_JOINED"));
      return;
    }

    if (message.type === "START_GAME") {
      await this.startGame(engine, attachment.playerId, now);
      return;
    }

    await this.apply(engine, engine.handle(attachment.playerId, message, now));

    // A duel rematch both players agreed to starts itself — nobody is host in a
    // random duel, so there is nobody to press a button.
    if (engine.rematchAgreed()) await this.autoStartIfReady(engine, Date.now());
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const attachment = this.attachmentOf(ws);
    if (!attachment?.playerId) return;

    const engine = await this.read();
    if (!engine || engine.state.closed) return;

    // Another tab may still hold this player: only mark them gone once the last
    // of their sockets has. Without this, closing a duplicate tab would start a
    // reconnect countdown for a player who is sitting right there.
    const stillHere = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && this.attachmentOf(other)?.playerId === attachment.playerId);
    if (stillHere) return;

    await this.apply(engine, engine.detach(attachment.playerId, Date.now()));
  }

  async alarm(): Promise<void> {
    const engine = await this.read();
    if (!engine) return;
    await this.apply(engine, engine.tick(Date.now()));
  }

  // -------------------------------------------------------------------- start

  /**
   * Starts a game, fetching its questions from D1 first.
   *
   * The room is re-read AFTER the fetch. Loading questions is an outbound D1 call,
   * which Durable Object input gating does not defer other events behind, so the
   * room can change while it is in flight — somebody leaves, somebody's grace
   * window expires. Beginning the game on the engine we held before the fetch
   * would then write that stale roster back over the change. Re-reading and
   * re-validating costs one storage read and makes the start atomic with respect
   * to everything that happened during the fetch.
   */
  private async startGame(engine: RoomEngine, playerId: string, now: number): Promise<void> {
    const request = engine.requestStart(playerId, now);
    if (request.error || !request.settings) {
      this.sendToPlayer(playerId, errorMessage(request.error ?? "SERVER_ERROR"));
      return;
    }

    const questions = await this.loadQuestions(request.settings);
    if (questions.length === 0) {
      this.sendToPlayer(playerId, errorMessage("NO_QUESTIONS"));
      return;
    }

    const fresh = (await this.read()) ?? engine;
    const recheck = fresh.requestStart(playerId, Date.now());
    if (recheck.error) {
      this.sendToPlayer(playerId, errorMessage(recheck.error));
      return;
    }

    await this.apply(fresh, fresh.beginGame(questions, Date.now()));
  }

  /**
   * Starts a game that nobody is going to press start for.
   *
   * Two cases, and they are different:
   *
   *   * A random duel has no host at all, so it starts itself the moment both
   *     players are present.
   *   * A duel rematch that BOTH players accepted has already been agreed to —
   *     making them then find a start button would be asking the same question
   *     twice. This applies to a private duel as much as to a matchmade one,
   *     which is what an earlier version got wrong: a private duel's agreed
   *     rematch reset the room to the lobby and then sat there.
   */
  private async autoStartIfReady(engine: RoomEngine, now: number): Promise<void> {
    if (engine.state.phase !== "LOBBY") return;

    const matchmade = engine.state.settings.mode === "RANDOM_DUEL";
    if (!matchmade && !engine.rematchAgreed()) return;

    const connected = engine.state.players.filter((p) => p.connected);
    if (connected.length < 2) return;

    const questions = await this.loadQuestions(engine.state.settings);
    if (questions.length === 0) {
      this.broadcast(errorMessage("NO_QUESTIONS"));
      return;
    }

    // Re-read after the fetch, for the same reason as startGame — and re-check,
    // because the second player may have dropped while we were loading.
    const fresh = (await this.read()) ?? engine;
    if (fresh.state.phase !== "LOBBY") return;
    if (fresh.state.players.filter((p) => p.connected).length < 2) return;

    await this.apply(fresh, fresh.beginGame(questions, Date.now()));
  }

  /**
   * Draws a question set from the existing bank.
   *
   * Reuses the single-player engine's own selector, so multiplayer inherits
   * difficulty, categories, competitions, countries, free-text eligibility and
   * de-duplication for free — and a question fixed for the solo game is fixed
   * here too. There is deliberately no multiplayer question table.
   */
  private async loadQuestions(settings: RoomSettings): Promise<Question[]> {
    const filter = {
      region: settings.region,
      countries: settings.countries,
      competitions: settings.competitions,
      categories: settings.categories,
      difficulty: settings.difficulty,
      gameMode: settings.gameMode,
      answerMode: settings.answerMode,
    };
    const ids = await pickQuestionIds(this.env.DB, filter, settings.questionCount, []);
    // Hydration shuffles options once, here, and that order is then frozen into
    // the room's state — which is what guarantees two duellists see the same
    // board in the same order.
    return hydrateQuestions(this.env.DB, ids);
  }

  // ------------------------------------------------------------------ effects

  /**
   * Applies the engine's effects and then persists.
   *
   * ORDER MATTERS, and the bug it fixes is worth stating. Writing the finished
   * game to D1 used to happen inside this loop, i.e. BEFORE the room's own state
   * was written to storage. Durable Object input gating defers incoming events
   * while a STORAGE operation is in flight, but a D1 call is an outbound fetch and
   * is not gated — so a message arriving during that write was handled against the
   * state as it was before the game ended. In practice: both players finish a duel,
   * one presses "משחק חוזר" immediately, and the room reads a pre-FINISHED phase,
   * decides a rematch is not valid right now, and silently drops it. It reproduced
   * roughly one run in three against the deployment and never once locally, because
   * locally the D1 write is sub-millisecond.
   *
   * So: local state first, side effects after. The `storage.put` is gated, which
   * closes the window, and the history write can take as long as it likes.
   */
  private async apply(engine: RoomEngine, effects: Effect[]): Promise<void> {
    let destroy = false;
    const histories: GameResult[] = [];

    for (const effect of effects) {
      switch (effect.kind) {
        case "broadcast":
          this.broadcast(effect.message, effect.exceptPlayerId);
          break;
        case "send":
          this.sendToPlayer(effect.playerId, effect.message);
          break;
        case "disconnect":
          this.dropPlayerSockets(effect.playerId);
          break;
        case "persist":
          histories.push(effect.result);
          break;
        case "destroy":
          destroy = true;
          break;
      }
    }

    if (destroy) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "room closed");
        } catch {
          /* already gone */
        }
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.write(engine);
    await this.reschedule(engine);

    // Only now, with the room's own state safely durable and visible to the next
    // message this object handles.
    for (const result of histories) {
      await this.persist(engine, result);
    }
  }

  /**
   * The only D1 write multiplayer makes: one game row and one row per player,
   * once, at full time.
   *
   * Nothing about a live room touches D1 — not a join, not an answer, not a score
   * change. That is a hard rule rather than an optimisation: the free tier's daily
   * row budget is small enough that logging WebSocket traffic to D1 would exhaust
   * it in a single evening of play, which is the same trap migration 0004 exists
   * to keep the seed out of.
   */
  private async persist(engine: RoomEngine, game: GameResult): Promise<void> {
    try {
      const inserted = await this.env.DB.prepare(
        `INSERT INTO multiplayer_games
           (room_code, mode, configuration_json, question_count, player_count, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          engine.state.code,
          game.mode,
          JSON.stringify(engine.state.settings),
          engine.state.questions.length,
          game.standings.length,
          new Date(game.startedAt).toISOString(),
          new Date(game.finishedAt).toISOString()
        )
        .run();

      const gameId = inserted.meta.last_row_id;
      if (!gameId || game.standings.length === 0) return;

      // Which standings belong to signed-in players: playerId -> token -> user.
      const accounts = (await this.ctx.storage.get<Record<string, number>>(ACCOUNTS_KEY)) ?? {};
      const userIdOf = (playerId: string): number | null => {
        const token = engine.state.players.find((p) => p.id === playerId)?.token;
        return token ? accounts[token] ?? null : null;
      };
      const duel = isDuelMode(game.mode);

      const statements = game.standings.map((s) =>
        this.env.DB.prepare(
          `INSERT INTO multiplayer_game_players
             (game_id, player_name, team, score, position, correct_count, wrong_count, best_streak, average_response_time, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          gameId,
          s.name,
          s.team,
          s.score,
          s.position,
          s.correctCount,
          s.wrongCount,
          s.bestStreak,
          s.averageResponseMs,
          userIdOf(s.playerId)
        )
      );
      for (const s of game.standings) {
        const userId = userIdOf(s.playerId);
        if (userId !== null) {
          statements.push(recordRoomForUserStatement(this.env.DB, userId, duelOutcome(game, s.playerId, duel), s.bestStreak));
        }
      }
      await this.env.DB.batch(statements);
    } catch (err) {
      // History is a nice-to-have. A player must never see a game fail to end
      // because a log row could not be written.
      console.error("multiplayer history write failed", err);
    }
  }
}
