// Applies this device's block list to what the room sends (guideline 1.2).
//
// A blocked player's messages and reactions are dropped, and their name is
// replaced wherever the room picture or the standings carry it.

import type { ServerMessage } from "../../../shared/multiplayer/protocol";
import type { FinalStanding, RoomView } from "../../../shared/multiplayer/types";
import { isBlocked } from "./blocklist";

export const BLOCKED_NAME = "שחקן חסום";

export function blockedIds(room: RoomView | null): Set<string> {
  const ids = new Set<string>();
  for (const p of room?.players ?? []) if (isBlocked(p.blockKey, p.name)) ids.add(p.id);
  return ids;
}

export function maskStandings(standings: FinalStanding[], ids: Set<string>): FinalStanding[] {
  if (ids.size === 0) return standings;
  return standings.map((s) => (ids.has(s.playerId) ? { ...s, name: BLOCKED_NAME } : s));
}

/** The message as this player should see it, or null to drop it. */
export function withBlockedMasked(message: ServerMessage, room: RoomView | null): ServerMessage | null {
  switch (message.type) {
    case "ROOM_STATE":
      return { ...message, room: maskRoom(message.room) };
    case "PLAYER_MESSAGE":
    case "REACTION":
      return blockedIds(room).has(message.playerId) ? null : message;
    case "LEADERBOARD_UPDATE":
      return { ...message, standings: maskStandings(message.standings, blockedIds(room)) };
    case "GAME_FINISHED":
      return {
        ...message,
        result: { ...message.result, standings: maskStandings(message.result.standings, blockedIds(room)) },
      };
    default:
      return message;
  }
}

/** The room with blocked players' names replaced. */
export function maskRoom(room: RoomView): RoomView {
  const ids = blockedIds(room);
  if (ids.size === 0) return room;
  return { ...room, players: room.players.map((p) => (ids.has(p.id) ? { ...p, name: BLOCKED_NAME } : p)) };
}
