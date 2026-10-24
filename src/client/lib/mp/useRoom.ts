// The room connection.
//
// One hook owns the socket, the reconnect loop, the clock correction, the sound
// cues and the screen-reader announcements, and hands the pages a plain snapshot
// to render. Pages therefore contain no socket code and no timing code: they draw
// `state.room.phase` and send messages.
//
// THE CLOCK. Every message that starts a timed phase carries both `deadlineAt`
// and `serverNow`. A phone with a clock two minutes out would otherwise render a
// countdown that is either already over or twice as long, so the hook keeps the
// offset between the two and converts every server deadline into local time. The
// server remains the authority — the local clock only drives the animation.
//
// RECONNECT. A closed socket is retried with backoff, and because the player's
// token travels in the URL the room recognises them and restores their seat and
// score. If a reconnect lands with no player attached (the room swept them from
// the lobby during a long outage) the hook re-joins under the same name rather
// than dumping the player back on the name prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../../shared/multiplayer/protocol";
import type {
  FinalStanding,
  GameResult,
  LiveQuestion,
  MultiplayerErrorCode,
  ReactionEmoji,
  RoomView,
  RoundReveal,
} from "../../../shared/multiplayer/types";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isDuelMode,
  PING,
  PONG,
} from "../../../shared/multiplayer/constants";
import { sound } from "../sound";
import { playerToken } from "./identity";
import { socketUrl } from "../origin";
import { readAccountToken } from "../accountToken";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface LiveReaction {
  key: number;
  playerId: string;
  name: string;
  emoji: ReactionEmoji;
}

/** A trash-talk bubble currently on screen. */
export interface LiveMessage {
  key: number;
  playerId: string;
  name: string;
  text: string;
  /** When it arrived, so the bubble can time itself out. */
  at: number;
}

export interface RoomClientState {
  status: ConnectionStatus;
  room: RoomView | null;
  /** This client's player id, or null while it is still a spectator. */
  you: string | null;
  question: LiveQuestion | null;
  /** The current phase deadline, already converted to this device's clock. */
  deadlineAt: number | null;
  reveal: RoundReveal | null;
  roundHeadline: string | null;
  roundWinnerIds: string[];
  standings: FinalStanding[] | null;
  result: GameResult | null;
  /** Hint texts handed over for the question in play, in the order they were asked for. */
  hints: string[];
  reactions: LiveReaction[];
  messages: LiveMessage[];
  error: { code: MultiplayerErrorCode; messageHe: string } | null;
  closedReason: string | null;
  /**
   * Reconnect has been failing for long enough to say so.
   *
   * Distinct from `status`, because "reconnecting" and "we have been trying for
   * twenty seconds and getting nowhere" want different words on screen and the
   * second one wants a button. Collapsing them is how a momentary blip ends up
   * announcing that the server has died.
   */
  stalled: boolean;
  /** The latest thing worth saying out loud, for the live region. */
  announcement: string;
}

const INITIAL: RoomClientState = {
  status: "connecting",
  room: null,
  you: null,
  question: null,
  deadlineAt: null,
  reveal: null,
  roundHeadline: null,
  roundWinnerIds: [],
  standings: null,
  result: null,
  hints: [],
  reactions: [],
  messages: [],
  error: null,
  closedReason: null,
  stalled: false,
  announcement: "",
};

/** Backoff schedule for reconnect attempts, in ms. The last value repeats. */
const BACKOFF_MS = [400, 800, 1600, 3000, 5000, 8000];

/**
 * How many consecutive failed reconnects before the UI stops saying
 * "reconnecting" and admits it cannot get through.
 *
 * Six attempts spans roughly nineteen seconds of backoff, which covers every
 * ordinary blip — a lift, a tunnel, a wifi-to-cellular handover — without ever
 * telling a player the game is gone while it is in fact coming back. Past that,
 * continuing to show a hopeful spinner is the dishonest option: the player is
 * entitled to know, and to be offered a button.
 */
const RECONNECT_ATTEMPTS_BEFORE_STALLED = BACKOFF_MS.length;

export interface UseRoomOptions {
  /** A read-only shared screen: it never becomes a player. */
  display?: boolean;
  /** Skip connecting entirely (used while a route is still resolving). */
  enabled?: boolean;
}

export function useRoom(code: string | undefined, options: UseRoomOptions = {}) {
  const { display = false, enabled = true } = options;

  const [state, setState] = useState<RoomClientState>(INITIAL);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  /** Set when we close on purpose, so the reconnect loop knows to stand down. */
  const deliberateRef = useRef(false);
  /** Difference between this device's clock and the server's, in ms. */
  const clockOffsetRef = useRef(0);
  /** The name this client joined under, replayed if a reconnect loses the seat. */
  const joinNameRef = useRef<string | null>(null);
  const reactionKeyRef = useRef(0);
  const messageKeyRef = useRef(0);
  const youRef = useRef<string | null>(null);
  const modeRef = useRef<RoomView["settings"]["mode"] | null>(null);

  const toLocalTime = useCallback((serverTime: number) => serverTime + clockOffsetRef.current, []);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const join = useCallback(
    (name: string) => {
      joinNameRef.current = name;
      return send({ type: "JOIN_ROOM", name });
    },
    [send]
  );

  const handle = useCallback((message: ServerMessage) => {
    // Any message carrying the server's clock re-syncs the offset. Doing it on
    // every such message rather than once at connect means a device that sleeps
    // and wakes mid-game corrects itself.
    if ("serverNow" in message && typeof message.serverNow === "number") {
      clockOffsetRef.current = Date.now() - message.serverNow;
    } else if (message.type === "ROOM_STATE") {
      clockOffsetRef.current = Date.now() - message.room.serverNow;
    }

    /** A server deadline, expressed on this device's clock. */
    const toLocalTimeWith = (serverTime: number) => serverTime + clockOffsetRef.current;

    setState((previous) => {
      const next: RoomClientState = { ...previous, error: null };

      switch (message.type) {
        case "ROOM_STATE": {
          next.room = message.room;
          next.status = "open";
          // A full room picture is the strongest possible evidence the
          // connection is working, so it clears the stalled flag too.
          next.stalled = false;
          if (message.you !== null) {
            next.you = message.you;
            youRef.current = message.you;
          }
          modeRef.current = message.room.settings.mode;
          next.deadlineAt = message.room.deadlineAt === null ? null : toLocalTimeWith(message.room.deadlineAt);
          // Leaving the lobby for a new game clears the last game's residue, so a
          // rematch does not open on the previous podium.
          if (message.room.phase === "LOBBY") {
            next.result = null;
            next.standings = null;
            next.reveal = null;
            next.roundHeadline = null;
            next.question = null;
          }
          return next;
        }

        case "PLAYER_JOINED":
          sound.play("playerJoin");
          next.announcement = `הצטרף שחקן חדש: ${message.name}`;
          return next;

        case "PLAYER_LEFT":
          sound.play("playerLeave");
          next.announcement = `${message.name} יצא מהחדר`;
          return next;

        case "HOST_CHANGED":
          next.announcement = `המארח הועבר ל${message.hostName}`;
          return next;

        case "GAME_STARTED":
          next.deadlineAt = toLocalTimeWith(message.deadlineAt);
          next.result = null;
          next.standings = null;
          next.reveal = null;
          next.roundHeadline = null;
          next.announcement = `המשחק מתחיל. ${message.questionTotal} שאלות.`;
          return next;

        case "QUESTION_STARTED":
          sound.play("next");
          next.question = message.question;
          next.deadlineAt = toLocalTimeWith(message.deadlineAt);
          next.reveal = null;
          next.roundHeadline = null;
          next.roundWinnerIds = [];
          next.hints = [];
          next.announcement = `שאלה ${message.question.index + 1} מתוך ${message.question.total}. ${message.question.questionHe}`;
          return next;

        case "TURN_STARTED":
          sound.play("turnStart");
          next.deadlineAt = toLocalTimeWith(message.deadlineAt);
          next.announcement =
            message.playerId === youRef.current ? "התור שלכם" : `התור של ${message.name}`;
          return next;

        case "ANSWER_RECEIVED":
          // Deliberately silent and unannounced beyond the count: saying more
          // would be saying whether the answer was right.
          next.announcement = `${message.answeredCount} מתוך ${message.expectedCount} ענו`;
          return next;

        case "ANSWER_REVEAL": {
          next.reveal = message.reveal;
          next.deadlineAt = toLocalTimeWith(message.deadlineAt);
          const mine = message.reveal.results.find((r) => r.playerId === youRef.current);
          if (mine?.answered) sound.play(mine.correct ? "correct" : "wrong");
          next.announcement = `התשובה הנכונה: ${message.reveal.correctAnswer}.${
            mine?.answered ? (mine.correct ? " עניתם נכון." : " עניתם לא נכון.") : ""
          }`;
          return next;
        }

        case "SCORE_UPDATE": {
          if (!previous.room) return next;
          const byId = new Map(message.scores.map((s) => [s.playerId, s]));
          next.room = {
            ...previous.room,
            players: previous.room.players.map((p) => {
              const update = byId.get(p.id);
              return update ? { ...p, score: update.score, streak: update.streak } : p;
            }),
            teamScores: message.teamScores,
          };
          return next;
        }

        case "ROUND_RESULT":
          next.roundHeadline = message.headlineHe;
          next.roundWinnerIds = message.roundWinnerIds;
          next.deadlineAt = toLocalTimeWith(message.deadlineAt);
          if (youRef.current && message.roundWinnerIds.includes(youRef.current)) {
            sound.play("roundWin");
          } else if (message.roundWinnerIds.length > 0) {
            sound.play("roundLoss");
          }
          next.announcement = message.headlineHe;
          return next;

        case "LEADERBOARD_UPDATE":
          sound.play("leaderboardMove");
          next.standings = message.standings;
          return next;

        case "GAME_FINISHED": {
          next.result = message.result;
          next.standings = message.result.standings;
          next.deadlineAt = null;
          const won = youRef.current ? message.result.winnerIds.includes(youRef.current) : false;
          if (message.result.teamResult) sound.play("teamWin");
          else if (isDuelMode(message.result.mode)) sound.play(won ? "duelVictory" : "duelDefeat");
          else sound.play("podium");

          const winnerNames = message.result.standings
            .filter((s) => message.result.winnerIds.includes(s.playerId))
            .map((s) => s.name);
          next.announcement =
            winnerNames.length === 0
              ? "המשחק הסתיים."
              : winnerNames.length === 1
                ? `המשחק הסתיים. המנצח: ${winnerNames[0]}.`
                : `המשחק הסתיים בשוויון בין ${winnerNames.join(" ו")}.`;
          return next;
        }

        case "HINT":
          sound.play("hint");
          next.hints = [...previous.hints, message.text];
          next.announcement = `רמז: ${message.text}`;
          return next;

        case "PLAYER_MESSAGE": {
          sound.play("reaction");
          messageKeyRef.current += 1;
          // Only the most recent few are kept: a bubble that has aged out is gone,
          // and nothing here is replayed after a reconnect because the messages
          // live in this state alone and a reconnect starts it empty.
          next.messages = [
            ...previous.messages.slice(-2),
            {
              key: messageKeyRef.current,
              playerId: message.playerId,
              name: message.name,
              text: message.text,
              at: Date.now(),
            },
          ];
          next.announcement = `${message.name}: ${message.text}`;
          return next;
        }

        case "REACTION": {
          sound.play("reaction");
          reactionKeyRef.current += 1;
          next.reactions = [
            ...previous.reactions.slice(-5),
            { key: reactionKeyRef.current, playerId: message.playerId, name: message.name, emoji: message.emoji },
          ];
          return next;
        }

        case "REMATCH_STATUS":
          if (previous.room) {
            next.room = { ...previous.room, rematch: { requested: message.requested, needed: message.needed } };
          }
          next.announcement = `${message.requested.length} מתוך ${message.needed} מבקשים משחק חוזר`;
          return next;

        case "ROOM_CLOSED":
          next.closedReason = message.reasonHe;
          next.status = "closed";
          next.announcement = message.reasonHe;
          // Nothing is coming back; stop the reconnect loop.
          deliberateRef.current = true;
          return next;

        case "ERROR":
          next.error = { code: message.code, messageHe: message.messageHe };
          next.announcement = message.messageHe;
          // These three mean there is nothing to reconnect to.
          if (message.code === "INVALID_ROOM" || message.code === "ROOM_EXPIRED") {
            next.status = "closed";
            deliberateRef.current = true;
          }
          return next;

        default:
          return next;
      }
    });
  }, []);

  /** Rejoin automatically when a reconnect comes back without a seat. */
  useEffect(() => {
    if (display) return;
    if (state.status !== "open") return;
    if (state.you !== null) return;
    const name = joinNameRef.current;
    if (!name) return;
    if (state.room?.phase !== "LOBBY") return;
    send({ type: "JOIN_ROOM", name });
  }, [display, send, state.status, state.you, state.room?.phase]);

  useEffect(() => {
    if (!code || !enabled) return;

    deliberateRef.current = false;
    let disposed = false;

    /**
     * THE HALF-OPEN SOCKET, which is the bug this block exists for.
     *
     * A room in the lobby sends nothing and receives nothing. When a mobile
     * carrier NAT or an iOS app-switch tears the connection down without a close
     * frame — which is the normal way a phone loses a connection, not an edge
     * case — the result is a socket that both ends still believe is open:
     *
     *   * the room keeps the player on the roster, because the only thing that
     *     would tell it otherwise is a failed send, and in a lobby there is
     *     nothing to send
     *   * `readyState` here stays OPEN, so no reconnect is scheduled and no
     *     badge is shown
     *   * the player taps a button, `send()` writes into the dead socket and
     *     reports success, and nothing happens
     *
     * There is no error anywhere in that sequence. It reads as "the server
     * stopped responding" because from the player's seat that is exactly what it
     * looks like — and nothing was watching, so it could stay that way
     * indefinitely.
     *
     * The fix is traffic plus a watchdog. The ping is answered by the runtime's
     * auto-responder without waking the Durable Object, so a hibernating lobby
     * stays hibernating; the traffic itself also stops the intermediaries that
     * cause this from deciding the connection is idle. The watchdog is what turns
     * silence into a reconnect instead of a wait with no end.
     */
    let heartbeatTimer: number | null = null;
    let watchdogTimer: number | null = null;
    let lastTrafficAt = Date.now();

    const stopTimers = () => {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
      heartbeatTimer = null;
      watchdogTimer = null;
    };

    /** Drops a socket we have decided is dead, and starts the reconnect loop. */
    const giveUpOn = (socket: WebSocket) => {
      stopTimers();
      if (socketRef.current === socket) socketRef.current = null;
      try {
        // 4000 is in the application-defined range: it distinguishes "we decided
        // this socket is dead" from a real close in a Worker log.
        socket.close(4000, "heartbeat timeout");
      } catch {
        /* already gone */
      }
      scheduleRetry();
    };

    const startTimers = (socket: WebSocket) => {
      stopTimers();
      lastTrafficAt = Date.now();

      heartbeatTimer = window.setInterval(() => {
        if (disposed || socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(PING);
        } catch {
          giveUpOn(socket);
        }
      }, HEARTBEAT_INTERVAL_MS);

      watchdogTimer = window.setInterval(() => {
        if (disposed || deliberateRef.current) return;
        if (Date.now() - lastTrafficAt < HEARTBEAT_TIMEOUT_MS) return;
        giveUpOn(socket);
      }, HEARTBEAT_INTERVAL_MS);
    };

    const connect = () => {
      if (disposed || deliberateRef.current) return;

      const params = new URLSearchParams({ t: playerToken() });
      if (display) params.set("display", "1");
      // Signed in: the Worker turns this into a verified user id so full time
      // can credit the game to the account. Browsers cannot send headers on a
      // WebSocket, which is why it travels in the URL.
      const accountToken = display ? null : readAccountToken();
      if (accountToken) params.set("a", accountToken);
      const url = socketUrl(`/api/mp/rooms/${code}/ws?${params}`);

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        attemptRef.current = 0;
        startTimers(socket);
        setState((previous) => ({ ...previous, status: "open", stalled: false }));
      };

      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;

        // Before anything else: the connection is demonstrably alive. Counting
        // every frame rather than only pongs means a busy game never trips the
        // watchdog on a pong that was dropped.
        lastTrafficAt = Date.now();

        // The auto-responder's reply is a bare string, not protocol JSON. It has
        // already done its only job above.
        if (event.data === PONG) return;

        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handle(parsed);
      };

      socket.onclose = () => {
        stopTimers();
        if (disposed || deliberateRef.current) return;
        socketRef.current = null;
        scheduleRetry();
      };

      socket.onerror = () => {
        // onclose always follows, and that is where the retry lives; handling it
        // here too would double the backoff steps.
      };
    };

    const scheduleRetry = () => {
      if (disposed || deliberateRef.current) return;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);

      const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)];
      attemptRef.current += 1;
      const stalled = attemptRef.current > RECONNECT_ATTEMPTS_BEFORE_STALLED;
      setState((previous) => ({ ...previous, status: "reconnecting", stalled }));
      retryTimerRef.current = window.setTimeout(connect, delay);
    };

    /**
     * Reconnect the moment the device says it is back, rather than waiting out a
     * backoff that was scheduled while it was offline.
     *
     * `navigator.onLine` is only trusted in this direction. False negatives are
     * common — a captive portal reports online — so it is never used to decide
     * that a connection is impossible, only as a hint that it is now worth
     * another try.
     */
    const onBackOnline = () => {
      if (disposed || deliberateRef.current) return;
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      attemptRef.current = 0;
      setState((previous) => ({ ...previous, status: "reconnecting", stalled: false }));
      connect();
    };

    /**
     * A tab coming back to the foreground.
     *
     * This is the iOS case specifically: Safari suspends a background tab, and a
     * socket that died while it was suspended has had no timer running to notice.
     * Checking on return makes a backgrounded phone recover on the frame the
     * player looks at it, rather than after a watchdog interval.
     */
    const onVisible = () => {
      if (disposed || deliberateRef.current) return;
      if (document.visibilityState !== "visible") return;
      const socket = socketRef.current;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        onBackOnline();
        return;
      }
      // Alive as far as the browser knows, but it may have been suspended for a
      // while: probe immediately instead of waiting for the next interval.
      lastTrafficAt = Date.now();
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(PING);
      } catch {
        giveUpOn(socket);
      }
    };

    window.addEventListener("online", onBackOnline);
    document.addEventListener("visibilitychange", onVisible);

    setState((previous) => ({ ...previous, status: "connecting", stalled: false }));
    connect();

    return () => {
      disposed = true;
      deliberateRef.current = true;
      stopTimers();
      window.removeEventListener("online", onBackOnline);
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      try {
        socket?.close(1000, "left");
      } catch {
        /* already closing */
      }
    };
  }, [code, display, enabled, handle]);

  /** Leaves for good: tells the room, then stops reconnecting. */
  const leave = useCallback(() => {
    send({ type: "LEAVE_ROOM" });
    deliberateRef.current = true;
    try {
      socketRef.current?.close(1000, "left");
    } catch {
      /* already closing */
    }
  }, [send]);

  const me = state.room?.players.find((p) => p.id === state.you) ?? null;
  const isHost = !!me?.isHost;

  return { state, send, join, leave, me, isHost, toLocalTime };
}
