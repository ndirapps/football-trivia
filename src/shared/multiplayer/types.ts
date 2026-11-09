// Multiplayer domain types, shared by the Durable Objects and the React client.
//
// Framework-free on purpose: the Room Durable Object, the matchmaker, the client
// hook and the Node test runner all import this file, so it must not reach for
// anything browser- or Workers-specific.

import type {
  AnswerMode,
  Category,
  Difficulty,
  GameMode,
  QuestionClue,
  Region,
} from "../types.ts";
import type { MatchKind } from "../answerMatching.ts";

/**
 * How a room is played. This is a different axis from the single-player
 * `GameMode`, which decides how one *question* is rendered (CLASSIC, WHO_AM_I,
 * CAREER_PATH…). A room has both: a multiplayer mode and a question game mode.
 */
export type MultiplayerMode =
  | "CLASSIC_BATTLE"
  | "TURN_BASED"
  | "EVERYONE_ANSWERS"
  | "DUEL"
  | "TEAM_BATTLE"
  | "RANDOM_DUEL";

export const MULTIPLAYER_MODES: MultiplayerMode[] = [
  "CLASSIC_BATTLE",
  "TURN_BASED",
  "EVERYONE_ANSWERS",
  "DUEL",
  "TEAM_BATTLE",
  "RANDOM_DUEL",
];

/**
 * The room state machine. Every transition is driven by the Durable Object, and
 * the client only ever renders the phase it is told it is in — there are no
 * client-side booleans deciding whether a question is open.
 *
 * LOBBY              players gather, host configures
 * COUNTDOWN          3-2-1 before the first question (and the duel VS intro)
 * QUESTION           answer window open, nobody has answered yet
 * WAITING_FOR_ANSWERS answer window still open, some players have answered
 * ANSWER_REVEAL      correct answer shown, per-player correctness shown
 * ROUND_RESULTS      who took the round, score deltas
 * LEADERBOARD        standings between questions (shown on the last beat)
 * NEXT_QUESTION      brief hand-off before the next question opens
 * FINISHED           podium / winner screen, full standings
 * REMATCH_WAITING    at least one player asked for a rematch, not everyone has
 */
export type RoomPhase =
  | "LOBBY"
  | "COUNTDOWN"
  | "QUESTION"
  | "WAITING_FOR_ANSWERS"
  | "ANSWER_REVEAL"
  | "ROUND_RESULTS"
  | "LEADERBOARD"
  | "NEXT_QUESTION"
  | "FINISHED"
  | "REMATCH_WAITING";

/** Phases in which the answer window is open. */
export const OPEN_PHASES: RoomPhase[] = ["QUESTION", "WAITING_FOR_ANSWERS"];

export type TeamId = "GREEN" | "GOLD";

export const TEAM_IDS: TeamId[] = ["GREEN", "GOLD"];

export const DEFAULT_TEAM_NAMES: Record<TeamId, string> = {
  GREEN: "הירוקים",
  GOLD: "הזהובים",
};

/**
 * Everything about a player that every client is allowed to see.
 *
 * `id` is a public, per-room identifier. It is NOT the reconnect token: that
 * secret never leaves the socket that owns it, so knowing another player's id
 * buys you nothing.
 */
export interface PublicPlayer {
  id: string;
  name: string;
  /** Stable public handle derived from the private token; what "block" stores. */
  blockKey: string;
  isHost: boolean;
  /** Socket currently attached. */
  connected: boolean;
  /** Dropped but still inside the grace window — shown as "מתחבר מחדש…". */
  reconnecting: boolean;
  team: TeamId | null;
  score: number;
  /** Current run of correct answers. */
  streak: number;
  correctCount: number;
  wrongCount: number;
  bestStreak: number;
  averageResponseMs: number | null;
  joinedAt: number;
}

export interface RoomSettings {
  mode: MultiplayerMode;
  questionCount: number;
  difficulty: Difficulty | "MIXED";
  categories: Category[];
  competitions: string[];
  countries: string[];
  region: Region | null;
  answerMode: AnswerMode;
  /** Which question shape to draw from the existing bank. */
  gameMode: GameMode;
  secondsPerQuestion: number;
  hintsAllowed: boolean;
  teamNames: Record<TeamId, string>;
}

/**
 * The room as broadcast to clients.
 *
 * `serverNow` travels with every deadline so a client with a skewed clock still
 * renders the right countdown: it animates against `deadlineAt - serverNow`
 * rather than against its own wall clock.
 */
export interface RoomView {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  hostId: string | null;
  /** 0-based index of the question in play; -1 before the game starts. */
  questionIndex: number;
  questionTotal: number;
  currentTurnPlayerId: string | null;
  deadlineAt: number | null;
  serverNow: number;
  /** Player ids that have locked in an answer this round. */
  answered: string[];
  teamScores: Record<TeamId, number> | null;
  rematch: { requested: string[]; needed: number } | null;
  /** True once the game has been played at least once in this room. */
  played: boolean;
}

/**
 * A question as it reaches the client: no `isCorrect`, no canonical answer, no
 * aliases, no hint text. Option order is fixed by the server so every player in
 * a duel sees the same board in the same order.
 */
export interface LiveQuestion {
  index: number;
  total: number;
  id: number;
  mode: GameMode;
  category: Category;
  difficulty: Difficulty;
  questionHe: string;
  clues: QuestionClue[];
  options: { id: number; text: string }[];
  answerMode: AnswerMode;
  hintCount: number;
  /** Set in TURN_BASED: only this player may submit. */
  turnPlayerId: string | null;
}

export interface PlayerRoundResult {
  playerId: string;
  answered: boolean;
  correct: boolean;
  revealed: boolean;
  timeMs: number | null;
  hintsUsed: number;
  pointsAwarded: number;
  /** Lets the client run the VAR beat for an answer that only passed on tolerance. */
  matchKind: MatchKind | null;
  typedAnswer: string | null;
}

export interface RoundReveal {
  questionIndex: number;
  correctOptionId: number | null;
  correctAnswer: string;
  explanationHe: string | null;
  results: PlayerRoundResult[];
  /** Empty when nobody took the round. More than one on a tie. */
  roundWinnerIds: string[];
}

export interface FinalStanding {
  position: number;
  playerId: string;
  name: string;
  team: TeamId | null;
  score: number;
  correctCount: number;
  wrongCount: number;
  /** 0-100, one decimal place. */
  accuracy: number;
  bestStreak: number;
  averageResponseMs: number | null;
}

export interface TeamResult {
  winner: TeamId | null;
  scores: Record<TeamId, number>;
  names: Record<TeamId, string>;
  mvpPlayerId: string | null;
}

export interface GameResult {
  mode: MultiplayerMode;
  standings: FinalStanding[];
  teamResult: TeamResult | null;
  /** More than one id when the top score is tied on every tiebreak. */
  winnerIds: string[];
  /** Set when a random-duel opponent never came back inside the grace window. */
  forfeitedBy: string | null;
  startedAt: number;
  finishedAt: number;
}

export type MatchmakingState =
  | "IDLE"
  | "SEARCHING"
  | "MATCHED"
  | "CONNECTING"
  | "IN_GAME"
  | "CANCELLED";

/** Reactions are a fixed list so no arbitrary text can reach another client. */
export const REACTIONS = [
  { emoji: "👏", labelHe: "מחיאות כפיים" },
  { emoji: "😂", labelHe: "צחוק" },
  { emoji: "😱", labelHe: "הפתעה" },
  { emoji: "🔥", labelHe: "אש" },
  { emoji: "⚽", labelHe: "כדור" },
] as const;

export type ReactionEmoji = (typeof REACTIONS)[number]["emoji"];

/**
 * One-tap trash talk.
 *
 * Presets exist so the common case needs no keyboard — on a phone, mid-question,
 * opening one costs more time than the message is worth. They are also the only
 * thing a player can send without any text of theirs reaching another screen,
 * which is why they are identified by id on the wire: the client sends "easy",
 * never the sentence, so a preset can never be a channel for something else.
 *
 * Tone is competitive but never abusive. That is a product decision, not a
 * moderation feature — the defaults set what the mode feels like.
 */
export const QUICK_MESSAGES = [
  { id: "easy", textHe: "זה היה קל" },
  { id: "var", textHe: "VAR בבקשה" },
  { id: "almost", textHe: "כמעט..." },
  { id: "hattrick", textHe: "שלושער בדרך" },
  { id: "your_turn", textHe: "נראה אותך עכשיו" },
  { id: "lucky", textHe: "איזה מזל" },
  { id: "warming_up", textHe: "אני מתחמם" },
  { id: "didnt_see", textHe: "לא ראית את זה בא" },
] as const;

export type QuickMessageId = (typeof QUICK_MESSAGES)[number]["id"];

export const QUICK_MESSAGE_TEXT: Record<QuickMessageId, string> = QUICK_MESSAGES.reduce(
  (all, m) => ({ ...all, [m.id]: m.textHe }),
  {} as Record<QuickMessageId, string>
);

export type MultiplayerErrorCode =
  | "INVALID_ROOM"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "INVALID_NAME"
  | "GAME_ALREADY_STARTED"
  | "NOT_JOINED"
  | "NOT_HOST"
  | "NOT_YOUR_TURN"
  | "ALREADY_ANSWERED"
  | "TOO_LATE"
  | "NEEDS_MORE_PLAYERS"
  | "TOO_MANY_PLAYERS"
  | "NO_QUESTIONS"
  | "RATE_LIMITED"
  | "INVALID_MESSAGE"
  | "MATCHMAKING_TIMEOUT"
  | "SERVER_ERROR";
