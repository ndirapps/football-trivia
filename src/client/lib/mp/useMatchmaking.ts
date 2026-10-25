// The random-duel queue, from the client's side.
//
// Simpler than the room hook on purpose: there is no game state to keep, only a
// queue position and a verdict. The one thing it must get right is CANCEL — a
// player who presses "ביטול" has to leave the queue immediately, and must not be
// matched a moment later by a socket that was still hanging around.
//
// So cancelling closes the socket as well as sending the message: the matchmaker
// derives its entire queue from live sockets, so a closed one is out of the pool
// whether or not the cancel message was processed first.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage } from "../../../shared/multiplayer/protocol";
import type { MatchmakingState, MultiplayerErrorCode } from "../../../shared/multiplayer/types";
import { sound } from "../sound";
import { playerToken } from "./identity";
import { socketUrl } from "../origin";

export interface MatchmakingSnapshot {
  state: MatchmakingState;
  connected: boolean;
  queueSize: number;
  waitedMs: number;
  /** The queue has been slow; the player is offered a choice rather than left waiting. */
  timedOut: boolean;
  match: { roomCode: string; opponentName: string } | null;
  error: { code: MultiplayerErrorCode; messageHe: string } | null;
}

const INITIAL: MatchmakingSnapshot = {
  state: "IDLE",
  connected: false,
  queueSize: 0,
  waitedMs: 0,
  timedOut: false,
  match: null,
  error: null,
};

export function useMatchmaking() {
  const [snapshot, setSnapshot] = useState<MatchmakingSnapshot>(INITIAL);
  const socketRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  /** Replayed on reconnect so a brief blip does not silently drop the player out of the queue. */
  const searchingNameRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (socketRef.current) return;
    cancelledRef.current = false;

    const url = socketUrl(`/api/mp/matchmaking/ws?t=${encodeURIComponent(playerToken())}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setSnapshot((p) => ({ ...p, error: { code: "SERVER_ERROR", messageHe: "לא הצלחנו להתחבר. נסו שוב." } }));
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      setSnapshot((p) => ({ ...p, connected: true, error: null }));
      const name = searchingNameRef.current;
      if (name) socket.send(JSON.stringify({ type: "JOIN_MATCHMAKING", name }));
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "MATCHMAKING_STATUS") {
        setSnapshot((p) => ({
          ...p,
          state: message.state,
          queueSize: message.queueSize,
          waitedMs: message.waitedMs,
          timedOut: message.timedOut,
        }));
        return;
      }

      if (message.type === "MATCH_FOUND") {
        sound.play("matchFound");
        searchingNameRef.current = null;
        setSnapshot((p) => ({
          ...p,
          state: "MATCHED",
          match: { roomCode: message.roomCode, opponentName: message.opponentName },
        }));
        return;
      }

      if (message.type === "ERROR") {
        setSnapshot((p) => ({ ...p, error: { code: message.code, messageHe: message.messageHe } }));
      }
    };

    socket.onclose = () => {
      socketRef.current = null;
      setSnapshot((p) => ({ ...p, connected: false }));
      // Still looking and not cancelled? The socket dropped under us; come back.
      if (!cancelledRef.current && searchingNameRef.current) {
        window.setTimeout(connect, 800);
      }
    };
  }, []);

  const search = useCallback(
    (name: string) => {
      searchingNameRef.current = name;
      setSnapshot((p) => ({ ...p, state: "SEARCHING", timedOut: false, match: null, error: null, waitedMs: 0 }));
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "JOIN_MATCHMAKING", name }));
      } else {
        connect();
      }
    },
    [connect]
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    searchingNameRef.current = null;
    const socket = socketRef.current;
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "CANCEL_MATCHMAKING" }));
      }
      // Closing is the real cancellation: the queue is made of live sockets, so
      // this removes the player even if the message above never lands.
      socket?.close(1000, "cancelled");
    } catch {
      /* already closing */
    }
    socketRef.current = null;
    setSnapshot({ ...INITIAL, state: "CANCELLED" });
  }, []);

  /** Called once the client is on its way into the duel room. */
  const enteringGame = useCallback(() => {
    cancelledRef.current = true;
    searchingNameRef.current = null;
    try {
      socketRef.current?.close(1000, "entering game");
    } catch {
      /* already closing */
    }
    socketRef.current = null;
    setSnapshot((p) => ({ ...p, state: "IN_GAME" }));
  }, []);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      try {
        socketRef.current?.close(1000, "unmounted");
      } catch {
        /* already closing */
      }
      socketRef.current = null;
    },
    []
  );

  return { snapshot, search, cancel, enteringGame };
}
