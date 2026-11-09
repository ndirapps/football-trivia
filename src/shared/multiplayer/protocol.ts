// The WebSocket message protocol.
//
// Two rules hold this together:
//
//   1. Every message is a discriminated union on `type`, so both ends switch
//      exhaustively and TypeScript catches a missing case.
//   2. NOTHING arriving from a client is trusted. `parseClientMessage` is the
//      only door into the Durable Object, and it rebuilds each message field by
//      field from `unknown` rather than casting a parsed blob into a type. A
//      message that does not survive that rebuild is dropped with an
//      INVALID_MESSAGE error and never reaches the room engine.
//
// The server therefore never receives a score, a correctness flag, a turn, a
// timer or a question index it did not itself produce — the only numbers a
// client may influence are "which option did I tap" and "what did I type".

import { parseBlockedNames, parseBlockKeys } from "./moderation.ts";
import {
  MAX_NAME_LENGTH,
  MESSAGE_MAX_LENGTH,
  MULTIPLAYER_MODES_GUARD,
  QUESTION_COUNT_CHOICES,
  SECONDS_PER_QUESTION_CHOICES,
} from "./guards.ts";
import type {
  FinalStanding,
  GameResult,
  LiveQuestion,
  MatchmakingState,
  MultiplayerErrorCode,
  MultiplayerMode,
  ReactionEmoji,
  QuickMessageId,
  RoomSettings,
  RoomView,
  RoundReveal,
  TeamId,
} from "./types.ts";

// ------------------------------------------------------------ client → server

export type ClientMessage =
  | { type: "JOIN_ROOM"; name: string }
  | { type: "LEAVE_ROOM" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<RoomSettings> }
  | { type: "START_GAME" }
  | { type: "SUBMIT_ANSWER"; questionIndex: number; optionId: number | null; typed: string | null; reveal: boolean }
  | { type: "REQUEST_HINT"; questionIndex: number }
  | { type: "SEND_REACTION"; emoji: ReactionEmoji }
  /**
   * Trash talk. Exactly one of presetId or text: a preset is resolved to its
   * sentence on the server, so the client never supplies the words for one.
   */
  | { type: "SEND_MESSAGE"; presetId: QuickMessageId | null; text: string | null }
  | { type: "REQUEST_REMATCH" }
  | { type: "KICK_PLAYER"; playerId: string }
  | { type: "SET_TEAM"; playerId: string; team: TeamId }
  | { type: "AUTO_BALANCE" }
  | { type: "END_ROOM" }
  | { type: "JOIN_MATCHMAKING"; name: string; blocked: string[]; blockedNames: string[] }
  | { type: "CANCEL_MATCHMAKING" };

export type ClientMessageType = ClientMessage["type"];

// ------------------------------------------------------------ server → client

export type ServerMessage =
  /** The full picture. Sent on connect, on reconnect, and whenever the roster or settings change. */
  | { type: "ROOM_STATE"; room: RoomView; you: string | null }
  | { type: "PLAYER_JOINED"; playerId: string; name: string; playerCount: number }
  | { type: "PLAYER_LEFT"; playerId: string; name: string; playerCount: number }
  | { type: "HOST_CHANGED"; hostId: string; hostName: string }
  | { type: "GAME_STARTED"; mode: MultiplayerMode; questionTotal: number; deadlineAt: number; serverNow: number }
  | { type: "QUESTION_STARTED"; question: LiveQuestion; deadlineAt: number; serverNow: number }
  | { type: "TURN_STARTED"; playerId: string; name: string; deadlineAt: number; serverNow: number }
  | { type: "ANSWER_RECEIVED"; playerId: string; answeredCount: number; expectedCount: number }
  | { type: "ANSWER_REVEAL"; reveal: RoundReveal; deadlineAt: number; serverNow: number }
  | { type: "SCORE_UPDATE"; scores: { playerId: string; score: number; streak: number }[]; teamScores: Record<TeamId, number> | null }
  | { type: "ROUND_RESULT"; roundWinnerIds: string[]; headlineHe: string; deadlineAt: number; serverNow: number }
  | { type: "LEADERBOARD_UPDATE"; standings: FinalStanding[] }
  | { type: "GAME_FINISHED"; result: GameResult }
  | { type: "HINT"; questionIndex: number; hintIndex: number; text: string }
  | { type: "REACTION"; playerId: string; name: string; emoji: ReactionEmoji }
  /**
   * A message to show. playerId and name come from the server's own record of the
   * socket, never from the sender's payload, so the bubble cannot be attributed to
   * somebody else.
   */
  | { type: "PLAYER_MESSAGE"; playerId: string; name: string; text: string }
  | { type: "REMATCH_STATUS"; requested: string[]; needed: number }
  | { type: "MATCH_FOUND"; roomCode: string; opponentName: string }
  | { type: "MATCHMAKING_STATUS"; state: MatchmakingState; queueSize: number; waitedMs: number; timedOut: boolean }
  | { type: "ROOM_CLOSED"; reasonHe: string }
  | { type: "ERROR"; code: MultiplayerErrorCode; messageHe: string };

export type ServerMessageType = ServerMessage["type"];

// ------------------------------------------------------------------ parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  // Slice before anything else: an oversized string must not be normalized or
  // scanned in full, or a client controls how much work the server does.
  return value.slice(0, maxLength);
}

function asFiniteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown, allowed: ReadonlySet<string>, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item)) seen.add(item);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

/**
 * Rebuilds a settings patch from untrusted input.
 *
 * Only keys that are present and valid survive, so a client cannot clear a
 * setting by sending garbage for it, and cannot introduce a value the product
 * does not define. `mode` is accepted here but the room engine still refuses a
 * mode change once a game has started.
 */
export function parseSettingsPatch(value: unknown): Partial<RoomSettings> {
  if (!isRecord(value)) return {};
  const patch: Partial<RoomSettings> = {};
  const g = MULTIPLAYER_MODES_GUARD;

  if (typeof value.mode === "string" && g.modes.has(value.mode)) {
    patch.mode = value.mode as MultiplayerMode;
  }
  const count = asFiniteInt(value.questionCount);
  if (count !== null && (QUESTION_COUNT_CHOICES as readonly number[]).includes(count)) {
    patch.questionCount = count;
  }
  if (typeof value.difficulty === "string" && g.difficulties.has(value.difficulty)) {
    patch.difficulty = value.difficulty as RoomSettings["difficulty"];
  }
  if (Array.isArray(value.categories)) {
    patch.categories = asStringArray(value.categories, g.categories, 14) as RoomSettings["categories"];
  }
  if (Array.isArray(value.competitions)) {
    patch.competitions = asStringArray(value.competitions, g.competitions, 20);
  }
  if (Array.isArray(value.countries)) {
    patch.countries = asStringArray(value.countries, g.countries, 20);
  }
  if (value.region === null) {
    patch.region = null;
  } else if (typeof value.region === "string" && g.regions.has(value.region)) {
    patch.region = value.region as RoomSettings["region"];
  }
  if (value.answerMode === "MULTIPLE_CHOICE" || value.answerMode === "FREE_TEXT") {
    patch.answerMode = value.answerMode;
  }
  if (typeof value.gameMode === "string" && g.gameModes.has(value.gameMode)) {
    patch.gameMode = value.gameMode as RoomSettings["gameMode"];
  }
  const seconds = asFiniteInt(value.secondsPerQuestion);
  if (seconds !== null && (SECONDS_PER_QUESTION_CHOICES as readonly number[]).includes(seconds)) {
    patch.secondsPerQuestion = seconds;
  }
  if (typeof value.hintsAllowed === "boolean") {
    patch.hintsAllowed = value.hintsAllowed;
  }
  if (isRecord(value.teamNames)) {
    const names: Partial<Record<TeamId, string>> = {};
    for (const team of ["GREEN", "GOLD"] as TeamId[]) {
      const raw = value.teamNames[team];
      if (typeof raw === "string") {
        const trimmed = raw.slice(0, 18).trim();
        if (trimmed) names[team] = trimmed;
      }
    }
    if (Object.keys(names).length > 0) {
      patch.teamNames = names as Record<TeamId, string>;
    }
  }
  return patch;
}

/**
 * The single entry point for untrusted client input.
 * Returns null for anything that is not a message this protocol defines.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    // A client can send megabytes; refuse before parsing rather than after.
    if (raw.length > 4096) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "JOIN_ROOM":
    case "JOIN_MATCHMAKING": {
      const name = asString(value.name, MAX_NAME_LENGTH * 4);
      if (name === null) return null;
      return value.type === "JOIN_ROOM"
        ? { type: "JOIN_ROOM", name }
        : {
            type: "JOIN_MATCHMAKING",
            name,
            blocked: parseBlockKeys(value.blocked),
            blockedNames: parseBlockedNames(value.blockedNames),
          };
    }

    case "LEAVE_ROOM":
      return { type: "LEAVE_ROOM" };

    case "UPDATE_SETTINGS":
      return { type: "UPDATE_SETTINGS", settings: parseSettingsPatch(value.settings) };

    case "START_GAME":
      return { type: "START_GAME" };

    case "SUBMIT_ANSWER": {
      const questionIndex = asFiniteInt(value.questionIndex);
      if (questionIndex === null || questionIndex < 0) return null;
      const optionId = value.optionId === null || value.optionId === undefined ? null : asFiniteInt(value.optionId);
      if (value.optionId !== null && value.optionId !== undefined && optionId === null) return null;
      const typed = value.typed === null || value.typed === undefined ? null : asString(value.typed, 120);
      if (value.typed !== null && value.typed !== undefined && typed === null) return null;
      return {
        type: "SUBMIT_ANSWER",
        questionIndex,
        optionId,
        typed,
        reveal: value.reveal === true,
      };
    }

    case "REQUEST_HINT": {
      const questionIndex = asFiniteInt(value.questionIndex);
      if (questionIndex === null || questionIndex < 0) return null;
      return { type: "REQUEST_HINT", questionIndex };
    }

    case "SEND_MESSAGE": {
      // Shape only. The content decision — preset lookup, sanitising, length,
      // blocked words — belongs to resolveOutgoingMessage, and the rate limit to
      // the room, so that a malformed frame and a refused message stay distinct.
      const presetId = typeof value.presetId === "string" ? value.presetId : null;
      const text = typeof value.text === "string" ? value.text : null;
      if (presetId === null && text === null) return null;
      if (presetId !== null && !MULTIPLAYER_MODES_GUARD.quickMessages.has(presetId)) return null;
      // An over-long frame is rejected at the door rather than walked.
      if (text !== null && text.length > MESSAGE_MAX_LENGTH * 8) return null;
      return {
        type: "SEND_MESSAGE",
        presetId: presetId as QuickMessageId | null,
        text: presetId !== null ? null : text,
      };
    }

    case "SEND_REACTION": {
      if (typeof value.emoji !== "string" || !MULTIPLAYER_MODES_GUARD.reactions.has(value.emoji)) return null;
      return { type: "SEND_REACTION", emoji: value.emoji as ReactionEmoji };
    }

    case "REQUEST_REMATCH":
      return { type: "REQUEST_REMATCH" };

    case "KICK_PLAYER": {
      const playerId = asString(value.playerId, 64);
      if (!playerId) return null;
      return { type: "KICK_PLAYER", playerId };
    }

    case "SET_TEAM": {
      const playerId = asString(value.playerId, 64);
      if (!playerId) return null;
      if (value.team !== "GREEN" && value.team !== "GOLD") return null;
      return { type: "SET_TEAM", playerId, team: value.team };
    }

    case "AUTO_BALANCE":
      return { type: "AUTO_BALANCE" };

    case "END_ROOM":
      return { type: "END_ROOM" };

    case "CANCEL_MATCHMAKING":
      return { type: "CANCEL_MATCHMAKING" };

    default:
      return null;
  }
}

/** Human-readable Hebrew for each error code. Raw server text never reaches a player. */
export const ERROR_COPY_HE: Record<MultiplayerErrorCode, string> = {
  INVALID_ROOM: "החדר הזה לא קיים. בדקו את הקוד ונסו שוב.",
  ROOM_EXPIRED: "החדר הזה נסגר. אפשר לפתוח חדר חדש.",
  ROOM_FULL: "החדר מלא.",
  INVALID_NAME: "השם לא תקין. נסו שם אחר, קצר ומכבד.",
  GAME_ALREADY_STARTED: "המשחק כבר התחיל.",
  NOT_JOINED: "צריך להצטרף לחדר קודם.",
  NOT_HOST: "רק המארח יכול לעשות את זה.",
  NOT_YOUR_TURN: "זה לא התור שלכם.",
  ALREADY_ANSWERED: "כבר עניתם על השאלה הזו.",
  TOO_LATE: "הזמן נגמר.",
  NEEDS_MORE_PLAYERS: "צריך עוד שחקנים כדי להתחיל.",
  TOO_MANY_PLAYERS: "יותר מדי שחקנים למשחק הזה.",
  NO_QUESTIONS: "לא נמצאו שאלות להגדרות האלה. נסו להרחיב את הסינון.",
  RATE_LIMITED: "רגע, לאט יותר.",
  INVALID_MESSAGE: "משהו השתבש בתקשורת. נסו שוב.",
  MATCHMAKING_TIMEOUT: "לא נמצא יריב כרגע.",
  SERVER_ERROR: "משהו השתבש אצלנו. נסו שוב.",
};

export function errorMessage(code: MultiplayerErrorCode): ServerMessage {
  return { type: "ERROR", code, messageHe: ERROR_COPY_HE[code] };
}
