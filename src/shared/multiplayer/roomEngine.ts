// The room state machine.
//
// This is where every multiplayer rule actually lives: who may answer, when a
// round closes, what an answer is worth, who is host, what happens when someone
// drops. It is deliberately NOT a Durable Object — it is a plain class with an
// injected clock that knows nothing about WebSockets, storage or D1.
//
// Two things fall out of that:
//
//   * The Durable Object shrinks to plumbing: sockets in, effects out, state
//     persisted. There is no game logic inside it to get wrong twice.
//   * Every rule is unit-testable in Node, at speed, without a Workers runtime.
//     A three-player turn-based game with a mid-round disconnect is a dozen
//     lines of test rather than a browser harness.
//
// The engine never reaches for `Date.now()`. Time arrives as a parameter on
// every entry point, which is what makes "the answer window expired" and "the
// grace period ran out" testable at all.
//
// ASYNC IS PUSHED OUT. Loading questions from D1 is the only asynchronous thing
// a room does, so it happens in the caller: `requestStart` validates and reports
// what to fetch, and `beginGame` is handed the fetched questions. The engine
// itself has no promises in it.

import { blockKeyOf } from "./moderation.ts";
import { matchAnswer, type MatchKind } from "../answerMatching.ts";
import type { Question } from "../types.ts";
import {
  COUNTDOWN_MS,
  DUEL_INTRO_MS,
  EMPTY_ROOM_TTL_MS,
  LEADERBOARD_MS,
  MAX_PLAYERS_PER_ROOM,
  NEXT_QUESTION_MS,
  MESSAGE_COOLDOWN_MS,
  MESSAGE_MAX_PER_QUESTION,
  REACTION_COOLDOWN_MS,
  RECONNECT_GRACE_MS,
  REVEAL_MS,
  ROOM_IDLE_TTL_MS,
  ROUND_RESULTS_MS,
  isDuelMode,
  modeMeta,
} from "./constants.ts";
import { resolveOutgoingMessage } from "./messages.ts";
import { sanitizePlayerName, uniquePlayerName } from "./names.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import { errorMessage } from "./protocol.ts";
import { scoreAnswer, streakBonusEnabled } from "./scoring.ts";
import { autoBalance, buildStandings, buildTeamResult, teamTotals, winnerIdsFrom } from "./standings.ts";
import type {
  GameResult,
  LiveQuestion,
  MultiplayerErrorCode,
  PlayerRoundResult,
  PublicPlayer,
  RoomPhase,
  RoomSettings,
  RoomView,
  RoundReveal,
  TeamId,
} from "./types.ts";
import { OPEN_PHASES } from "./types.ts";

// ------------------------------------------------------------------- state

export interface PlayerState {
  id: string;
  /** The reconnect secret. Never leaves the server, never appears in a RoomView. */
  token: string;
  name: string;
  team: TeamId | null;
  joinedAt: number;
  connected: boolean;
  disconnectedAt: number | null;
  score: number;
  streak: number;
  bestStreak: number;
  correctCount: number;
  wrongCount: number;
  /** Response times in ms, for answered questions only. */
  responseTimes: number[];
  hintsUsedThisRound: number;
  lastReactionAt: number;
  lastMessageAt: number;
  /** Reset when a question starts, so the ceiling is per question. */
  messagesThisQuestion: number;
}

export interface RoundAnswer {
  playerId: string;
  optionId: number | null;
  typed: string | null;
  correct: boolean;
  revealed: boolean;
  timeMs: number;
  hintsUsed: number;
  points: number;
  matchKind: MatchKind | null;
}

export interface RoomState {
  code: string;
  createdAt: number;
  lastActivityAt: number;
  settings: RoomSettings;
  phase: RoomPhase;
  players: PlayerState[];
  hostId: string | null;
  /** Full questions, answers included. Never sent to a client in this shape. */
  questions: Question[];
  questionIndex: number;
  questionStartedAt: number | null;
  phaseDeadlineAt: number | null;
  roundAnswers: RoundAnswer[];
  roundWinnerIds: string[];
  /**
   * The reveal for the round on screen, kept so a player who reconnects during it
   * is shown the same thing everybody else is looking at rather than a blank
   * board. Cleared when the next question opens.
   */
  lastReveal: RoundReveal | null;
  /** Fixed at game start; TURN_BASED walks it. */
  turnOrder: string[];
  turnCursor: number;
  currentTurnPlayerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  rematchRequested: string[];
  played: boolean;
  closed: boolean;
  forfeitedBy: string | null;
  result: GameResult | null;
}

// ----------------------------------------------------------------- effects

export type Effect =
  | { kind: "broadcast"; message: ServerMessage; exceptPlayerId?: string }
  | { kind: "send"; playerId: string; message: ServerMessage }
  /** Drop this player's socket — used for a kick and for room teardown. */
  | { kind: "disconnect"; playerId: string }
  /** The game is over: write the single history row pair to D1. */
  | { kind: "persist"; result: GameResult }
  /** Nothing is coming back to this room; the Durable Object may delete itself. */
  | { kind: "destroy" };

export interface JoinOutcome {
  playerId: string | null;
  error: MultiplayerErrorCode | null;
  effects: Effect[];
}

export interface StartRequest {
  error: MultiplayerErrorCode | null;
  /** How many questions to fetch, when there is no error. */
  questionCount: number;
  settings: RoomSettings | null;
}

const ROUND_HEADLINE_TIE = "שוויון בסיבוב";
const ROUND_HEADLINE_NOBODY = "אף אחד לא לקח את הסיבוב";

// ------------------------------------------------------------------ engine

export class RoomEngine {
  state: RoomState;

  constructor(state: RoomState) {
    this.state = state;
  }

  static create(code: string, settings: RoomSettings, now: number): RoomEngine {
    return new RoomEngine({
      code,
      createdAt: now,
      lastActivityAt: now,
      settings,
      phase: "LOBBY",
      players: [],
      hostId: null,
      questions: [],
      questionIndex: -1,
      questionStartedAt: null,
      phaseDeadlineAt: null,
      roundAnswers: [],
      roundWinnerIds: [],
      lastReveal: null,
      turnOrder: [],
      turnCursor: 0,
      currentTurnPlayerId: null,
      startedAt: null,
      finishedAt: null,
      rematchRequested: [],
      played: false,
      closed: false,
      forfeitedBy: null,
      result: null,
    });
  }

  // ------------------------------------------------------------- read model

  /**
   * What every client is allowed to see. Note what is absent: tokens, the
   * question bank, correct answers, and any per-player correctness for a round
   * that is still open.
   */
  view(now: number): RoomView {
    return {
      code: this.state.code,
      phase: this.state.phase,
      settings: this.state.settings,
      players: this.state.players.map((p) => this.publicPlayer(p, now)),
      hostId: this.state.hostId,
      questionIndex: this.state.questionIndex,
      questionTotal: this.state.questions.length || this.state.settings.questionCount,
      currentTurnPlayerId: this.state.currentTurnPlayerId,
      deadlineAt: this.state.phaseDeadlineAt,
      serverNow: now,
      answered: this.state.roundAnswers.map((a) => a.playerId),
      teamScores: this.state.settings.mode === "TEAM_BATTLE" ? teamTotals(this.publicPlayers(now)) : null,
      rematch:
        this.state.phase === "FINISHED" || this.state.phase === "REMATCH_WAITING"
          ? { requested: [...this.state.rematchRequested], needed: this.connectedPlayers().length }
          : null,
      played: this.state.played,
    };
  }

  private publicPlayer(p: PlayerState, now: number): PublicPlayer {
    return {
      id: p.id,
      name: p.name,
      blockKey: blockKeyOf(p.token),
      isHost: p.id === this.state.hostId,
      connected: p.connected,
      reconnecting: !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt < RECONNECT_GRACE_MS,
      team: p.team,
      score: p.score,
      streak: p.streak,
      correctCount: p.correctCount,
      wrongCount: p.wrongCount,
      bestStreak: p.bestStreak,
      averageResponseMs: averageOf(p.responseTimes),
      joinedAt: p.joinedAt,
    };
  }

  private publicPlayers(now: number): PublicPlayer[] {
    return this.state.players.map((p) => this.publicPlayer(p, now));
  }

  player(playerId: string): PlayerState | undefined {
    return this.state.players.find((p) => p.id === playerId);
  }

  playerByToken(token: string): PlayerState | undefined {
    return this.state.players.find((p) => p.token === token);
  }

  private connectedPlayers(): PlayerState[] {
    return this.state.players.filter((p) => p.connected);
  }

  /**
   * The earliest moment the engine needs to be woken. The Durable Object turns
   * this into an alarm after every mutation, so there is exactly one scheduling
   * rule in the system rather than one per transition.
   */
  nextWakeAt(): number | null {
    if (this.state.closed) return null;
    const candidates: number[] = [];
    if (this.state.phaseDeadlineAt !== null) candidates.push(this.state.phaseDeadlineAt);

    for (const p of this.state.players) {
      if (!p.connected && p.disconnectedAt !== null) candidates.push(p.disconnectedAt + RECONNECT_GRACE_MS);
    }

    // An unattended room is swept: quickly when nobody is connected at all,
    // and on a long fuse when it is merely idle.
    if (this.connectedPlayers().length === 0) {
      candidates.push(this.state.lastActivityAt + EMPTY_ROOM_TTL_MS);
    }
    candidates.push(this.state.lastActivityAt + ROOM_IDLE_TTL_MS);

    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  // ---------------------------------------------------------------- joining

  /**
   * Attaches a socket to this room.
   *
   * A known token always reconnects, whatever phase the room is in — that is the
   * whole point of the token, and it is why a refresh mid-game does not cost a
   * player their score. An unknown token may only become a player in the lobby.
   */
  join(token: string, rawName: string, now: number): JoinOutcome {
    this.touch(now);

    if (this.state.closed) {
      return { playerId: null, error: "ROOM_EXPIRED", effects: [] };
    }

    const existing = this.playerByToken(token);
    if (existing) {
      const wasDisconnected = !existing.connected;
      existing.connected = true;
      existing.disconnectedAt = null;
      // A returning player may also have changed their name (a fresh tab with a
      // new name typed in). Honour it, but keep it unique.
      const cleaned = sanitizePlayerName(rawName);
      if (cleaned && cleaned !== existing.name) {
        existing.name = uniquePlayerName(
          cleaned,
          this.state.players.filter((p) => p.id !== existing.id).map((p) => p.name)
        );
      }
      const effects: Effect[] = [];
      if (wasDisconnected) {
        effects.push({
          kind: "broadcast",
          message: {
            type: "PLAYER_JOINED",
            playerId: existing.id,
            name: existing.name,
            playerCount: this.state.players.length,
          },
        });
      }
      effects.push(...this.broadcastState(now));
      return { playerId: existing.id, error: null, effects };
    }

    if (this.state.phase !== "LOBBY") {
      return { playerId: null, error: "GAME_ALREADY_STARTED", effects: [] };
    }

    const limit = Math.min(MAX_PLAYERS_PER_ROOM, modeMeta(this.state.settings.mode).maxPlayers);
    if (this.state.players.length >= limit) {
      return { playerId: null, error: "ROOM_FULL", effects: [] };
    }

    const cleaned = sanitizePlayerName(rawName);
    if (!cleaned) {
      return { playerId: null, error: "INVALID_NAME", effects: [] };
    }

    const name = uniquePlayerName(cleaned, this.state.players.map((p) => p.name));
    const player: PlayerState = {
      id: newId(),
      token,
      name,
      team: null,
      joinedAt: now,
      connected: true,
      disconnectedAt: null,
      score: 0,
      streak: 0,
      bestStreak: 0,
      correctCount: 0,
      wrongCount: 0,
      responseTimes: [],
      hintsUsedThisRound: 0,
      lastReactionAt: 0,
      lastMessageAt: 0,
      messagesThisQuestion: 0,
    };
    this.state.players.push(player);

    // First one through the door hosts.
    if (this.state.hostId === null) this.state.hostId = player.id;

    return {
      playerId: player.id,
      error: null,
      effects: [
        {
          kind: "broadcast",
          message: {
            type: "PLAYER_JOINED",
            playerId: player.id,
            name: player.name,
            playerCount: this.state.players.length,
          },
        },
        ...this.broadcastState(now),
      ],
    };
  }

  /**
   * A socket went away. The player is NOT removed: they keep their score, their
   * place and their host role until the grace window closes, because on a phone
   * a dropped socket usually means a tunnel and not a departure.
   */
  detach(playerId: string, now: number): Effect[] {
    const player = this.player(playerId);
    if (!player || !player.connected) return [];
    this.touch(now);
    player.connected = false;
    player.disconnectedAt = now;

    const effects: Effect[] = [...this.broadcastState(now)];
    // Everyone else may now have finished answering.
    effects.push(...this.closeRoundIfComplete(now));
    return effects;
  }

  /** An explicit "I'm leaving" — no grace, the seat is given up immediately. */
  private leave(playerId: string, now: number): Effect[] {
    const player = this.player(playerId);
    if (!player) return [];
    this.touch(now);
    return this.removePlayer(player, now, "PLAYER_LEFT");
  }

  private removePlayer(player: PlayerState, now: number, reason: "PLAYER_LEFT"): Effect[] {
    this.state.players = this.state.players.filter((p) => p.id !== player.id);
    this.state.roundAnswers = this.state.roundAnswers.filter((a) => a.playerId !== player.id);
    this.state.rematchRequested = this.state.rematchRequested.filter((id) => id !== player.id);
    this.state.turnOrder = this.state.turnOrder.filter((id) => id !== player.id);

    const effects: Effect[] = [
      {
        kind: "broadcast",
        message: {
          type: reason,
          playerId: player.id,
          name: player.name,
          playerCount: this.state.players.length,
        },
      },
    ];

    if (this.state.hostId === player.id) {
      effects.push(...this.transferHost(now));
    }
    if (this.state.currentTurnPlayerId === player.id && OPEN_PHASES.includes(this.state.phase)) {
      // Their turn dies with them rather than holding the room hostage.
      effects.push(...this.closeRound(now));
      effects.push(...this.broadcastState(now));
      return effects;
    }

    effects.push(...this.broadcastState(now));
    effects.push(...this.closeRoundIfComplete(now));
    effects.push(...this.forfeitIfDuelAbandoned(now));
    return effects;
  }

  /**
   * Host handover. Deterministic on purpose: the oldest still-connected player
   * takes it, so every client can predict the outcome and nobody has to trust a
   * coin flip.
   */
  private transferHost(now: number): Effect[] {
    const candidates = this.connectedPlayers().sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates[0] ?? null;
    this.state.hostId = next?.id ?? null;
    if (!next) return [];
    return [
      { kind: "broadcast", message: { type: "HOST_CHANGED", hostId: next.id, hostName: next.name } },
      ...this.broadcastState(now),
    ];
  }

  // --------------------------------------------------------------- messages

  handle(playerId: string, message: ClientMessage, now: number): Effect[] {
    const player = this.player(playerId);
    if (!player) return [{ kind: "send", playerId, message: errorMessage("NOT_JOINED") }];
    this.touch(now);

    switch (message.type) {
      case "LEAVE_ROOM":
        return this.leave(playerId, now);

      case "UPDATE_SETTINGS":
        return this.updateSettings(player, message.settings, now);

      case "SUBMIT_ANSWER":
        return this.submitAnswer(player, message, now);

      case "REQUEST_HINT":
        return this.requestHint(player, message.questionIndex, now);

      case "SEND_REACTION":
        return this.reaction(player, message.emoji, now);

      case "SEND_MESSAGE":
        return this.playerMessage(player, message, now);

      case "REQUEST_REMATCH":
        return this.requestRematch(player, now);

      case "KICK_PLAYER":
        return this.kick(player, message.playerId, now);

      case "SET_TEAM":
        return this.setTeam(player, message.playerId, message.team, now);

      case "AUTO_BALANCE":
        return this.autoBalanceTeams(player, now);

      case "END_ROOM":
        return this.endRoom(player, now);

      // START_GAME and JOIN_ROOM are handled by the Durable Object, which has to
      // touch D1 for questions before the engine can act.
      default:
        return [];
    }
  }

  private updateSettings(player: PlayerState, patch: Partial<RoomSettings>, now: number): Effect[] {
    if (player.id !== this.state.hostId) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("NOT_HOST") }];
    }
    if (this.state.phase !== "LOBBY") {
      return [{ kind: "send", playerId: player.id, message: errorMessage("GAME_ALREADY_STARTED") }];
    }

    // RANDOM_DUEL is created by the matchmaker with fixed rules; a host cannot
    // reconfigure their private room into one, and a matchmade room's settings
    // are not open for editing.
    const nextMode = patch.mode && patch.mode !== "RANDOM_DUEL" ? patch.mode : this.state.settings.mode;
    if (this.state.settings.mode === "RANDOM_DUEL") {
      return [{ kind: "send", playerId: player.id, message: errorMessage("NOT_HOST") }];
    }

    this.state.settings = {
      ...this.state.settings,
      ...patch,
      mode: nextMode,
      teamNames: { ...this.state.settings.teamNames, ...(patch.teamNames ?? {}) },
    };

    // Leaving team mode should not leave stale team badges on the team sheet.
    if (this.state.settings.mode !== "TEAM_BATTLE") {
      for (const p of this.state.players) p.team = null;
    }

    return this.broadcastState(now);
  }

  private kick(host: PlayerState, targetId: string, now: number): Effect[] {
    if (host.id !== this.state.hostId) {
      return [{ kind: "send", playerId: host.id, message: errorMessage("NOT_HOST") }];
    }
    if (targetId === host.id) return [];
    const target = this.player(targetId);
    if (!target) return [];
    return [{ kind: "disconnect", playerId: target.id }, ...this.removePlayer(target, now, "PLAYER_LEFT")];
  }

  private setTeam(host: PlayerState, targetId: string, team: TeamId, now: number): Effect[] {
    if (host.id !== this.state.hostId) {
      return [{ kind: "send", playerId: host.id, message: errorMessage("NOT_HOST") }];
    }
    if (this.state.phase !== "LOBBY") {
      return [{ kind: "send", playerId: host.id, message: errorMessage("GAME_ALREADY_STARTED") }];
    }
    const target = this.player(targetId);
    if (!target) return [];
    target.team = team;
    return this.broadcastState(now);
  }

  private autoBalanceTeams(host: PlayerState, now: number): Effect[] {
    if (host.id !== this.state.hostId) {
      return [{ kind: "send", playerId: host.id, message: errorMessage("NOT_HOST") }];
    }
    if (this.state.phase !== "LOBBY") {
      return [{ kind: "send", playerId: host.id, message: errorMessage("GAME_ALREADY_STARTED") }];
    }
    this.applyAutoBalance(now);
    return this.broadcastState(now);
  }

  private applyAutoBalance(now: number) {
    const assignment = autoBalance(this.publicPlayers(now));
    for (const p of this.state.players) p.team = assignment.get(p.id) ?? "GREEN";
  }

  private endRoom(host: PlayerState, now: number): Effect[] {
    if (host.id !== this.state.hostId) {
      return [{ kind: "send", playerId: host.id, message: errorMessage("NOT_HOST") }];
    }
    return this.close("המארח סגר את החדר.", now);
  }

  close(reasonHe: string, now: number): Effect[] {
    if (this.state.closed) return [];
    this.state.closed = true;
    this.state.phase = "FINISHED";
    this.state.phaseDeadlineAt = null;
    this.touch(now);
    return [
      { kind: "broadcast", message: { type: "ROOM_CLOSED", reasonHe } },
      { kind: "destroy" },
    ];
  }

  /**
   * Trash talk.
   *
   * The sender's id and name come from `player`, which is this room's record of
   * the socket that sent the frame — never from the payload. A client can therefore
   * say what it likes and still cannot put words in another player's bubble.
   *
   * Two limits, because either alone leaves a gap: the cooldown stops a burst, and
   * the per-question ceiling stops a steady drip for the whole of a 30-second
   * question. Both are enforced here rather than in the UI, which only mirrors them.
   *
   * In a duel the message goes to the opponent alone. Everywhere else it goes to
   * the room except the sender — seeing your own jibe pop up over your own
   * scoreboard reads as a bug.
   */
  private playerMessage(
    player: PlayerState,
    message: { presetId: string | null; text: string | null },
    now: number
  ): Effect[] {
    if (now - player.lastMessageAt < MESSAGE_COOLDOWN_MS) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("RATE_LIMITED") }];
    }
    if (player.messagesThisQuestion >= MESSAGE_MAX_PER_QUESTION) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("RATE_LIMITED") }];
    }

    const { text, rejection } = resolveOutgoingMessage(message);
    if (rejection !== null || !text) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("INVALID_MESSAGE") }];
    }

    player.lastMessageAt = now;
    player.messagesThisQuestion += 1;
    this.touch(now);

    const outgoing = {
      type: "PLAYER_MESSAGE" as const,
      playerId: player.id,
      name: player.name,
      text,
    };

    if (isDuelMode(this.state.settings.mode)) {
      const opponent = this.state.players.find((p) => p.id !== player.id && p.connected);
      return opponent ? [{ kind: "send", playerId: opponent.id, message: outgoing }] : [];
    }
    return [{ kind: "broadcast", message: outgoing, exceptPlayerId: player.id }];
  }

  private reaction(player: PlayerState, emoji: string, now: number): Effect[] {
    if (now - player.lastReactionAt < REACTION_COOLDOWN_MS) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("RATE_LIMITED") }];
    }
    player.lastReactionAt = now;
    return [
      {
        kind: "broadcast",
        message: {
          type: "REACTION",
          playerId: player.id,
          name: player.name,
          emoji: emoji as never,
        },
      },
    ];
  }

  // ------------------------------------------------------------ start / play

  /**
   * Validates a start request without touching the question bank.
   *
   * Returns the number of questions the caller should fetch, so the Durable
   * Object never has to know what "enough players for a duel" means.
   */
  requestStart(playerId: string, now: number): StartRequest {
    const fail = (error: MultiplayerErrorCode): StartRequest => ({ error, questionCount: 0, settings: null });
    const player = this.player(playerId);
    if (!player) return fail("NOT_JOINED");
    if (playerId !== this.state.hostId) return fail("NOT_HOST");
    if (this.state.phase !== "LOBBY") return fail("GAME_ALREADY_STARTED");

    const meta = modeMeta(this.state.settings.mode);
    const active = this.connectedPlayers();
    if (active.length < meta.minPlayers) return fail("NEEDS_MORE_PLAYERS");
    if (active.length > meta.maxPlayers) return fail("TOO_MANY_PLAYERS");

    this.touch(now);
    return { error: null, questionCount: this.state.settings.questionCount, settings: this.state.settings };
  }

  /**
   * Starts the game with a question set the caller has already fetched.
   *
   * The full questions stay here. Clients are sent one sanitized question at a
   * time (see `liveQuestion`), which is the single measure that makes reading the
   * network tab useless: the answers to questions 2..N simply are not on the
   * client yet.
   */
  beginGame(questions: Question[], now: number): Effect[] {
    if (questions.length === 0) {
      return [{ kind: "broadcast", message: errorMessage("NO_QUESTIONS") }];
    }

    this.touch(now);
    this.state.questions = questions;
    this.state.questionIndex = -1;
    this.state.roundAnswers = [];
    this.state.roundWinnerIds = [];
    this.state.rematchRequested = [];
    this.state.forfeitedBy = null;
    this.state.result = null;
    this.state.startedAt = now;
    this.state.finishedAt = null;

    for (const p of this.state.players) {
      p.score = 0;
      p.streak = 0;
      p.bestStreak = 0;
      p.correctCount = 0;
      p.wrongCount = 0;
      p.responseTimes = [];
      p.hintsUsedThisRound = 0;
    }

    if (this.state.settings.mode === "TEAM_BATTLE") {
      const unassigned = this.state.players.some((p) => p.team === null);
      if (unassigned) this.applyAutoBalance(now);
    }

    // Turn order is frozen here so it cannot be reshuffled by someone joining or
    // leaving mid-game.
    this.state.turnOrder = this.connectedPlayers()
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => p.id);
    this.state.turnCursor = 0;

    this.state.phase = "COUNTDOWN";
    const introMs = COUNTDOWN_MS + (isDuelMode(this.state.settings.mode) ? DUEL_INTRO_MS : 0);
    this.state.phaseDeadlineAt = now + introMs;

    return [
      {
        kind: "broadcast",
        message: {
          type: "GAME_STARTED",
          mode: this.state.settings.mode,
          questionTotal: questions.length,
          deadlineAt: this.state.phaseDeadlineAt,
          serverNow: now,
        },
      },
      ...this.broadcastState(now),
    ];
  }

  /** The question the client is allowed to see. */
  liveQuestion(index: number): LiveQuestion | null {
    const question = this.state.questions[index];
    if (!question) return null;
    const freeText = this.state.settings.answerMode === "FREE_TEXT" && question.supportsFreeText;
    return {
      index,
      total: this.state.questions.length,
      id: question.id,
      mode: question.mode,
      category: question.category,
      difficulty: question.difficulty,
      questionHe: question.questionHe,
      clues: question.clues,
      // Option order is whatever it was when the set was hydrated — once, for the
      // whole game — so two duellists get the same board in the same order.
      options: freeText ? [] : question.options.map((o) => ({ id: o.id, text: o.text })),
      answerMode: freeText ? "FREE_TEXT" : "MULTIPLE_CHOICE",
      hintCount: this.state.settings.hintsAllowed ? question.hints.length : 0,
      turnPlayerId: this.state.settings.mode === "TURN_BASED" ? this.state.currentTurnPlayerId : null,
    };
  }

  private openQuestion(index: number, now: number): Effect[] {
    this.state.questionIndex = index;
    this.state.phase = "QUESTION";
    this.state.questionStartedAt = now;
    this.state.phaseDeadlineAt = now + this.limitMs();
    this.state.roundAnswers = [];
    this.state.roundWinnerIds = [];
    this.state.lastReveal = null;
    for (const p of this.state.players) {
      p.hintsUsedThisRound = 0;
      // The trash-talk ceiling is per question, so it lifts here rather than
      // lasting the whole game.
      p.messagesThisQuestion = 0;
    }

    const effects: Effect[] = [];

    if (this.state.settings.mode === "TURN_BASED") {
      const turn = this.pickTurnPlayer();
      this.state.currentTurnPlayerId = turn?.id ?? null;
      if (turn) {
        effects.push({
          kind: "broadcast",
          message: {
            type: "TURN_STARTED",
            playerId: turn.id,
            name: turn.name,
            deadlineAt: this.state.phaseDeadlineAt,
            serverNow: now,
          },
        });
      }
    } else {
      this.state.currentTurnPlayerId = null;
    }

    const question = this.liveQuestion(index);
    if (question) {
      effects.push({
        kind: "broadcast",
        message: {
          type: "QUESTION_STARTED",
          question,
          deadlineAt: this.state.phaseDeadlineAt,
          serverNow: now,
        },
      });
    }
    effects.push(...this.broadcastState(now));

    // A turn-based round with nobody available to answer must not sit on a timer
    // for fifteen seconds; close it now.
    if (this.state.settings.mode === "TURN_BASED" && this.state.currentTurnPlayerId === null) {
      effects.push(...this.closeRound(now));
    }
    return effects;
  }

  private limitMs(): number {
    return Math.max(5, this.state.settings.secondsPerQuestion) * 1000;
  }

  /**
   * Round-robin, skipping anyone who is not connected.
   *
   * Skipping rather than waiting is what keeps a room alive when someone closes
   * their laptop mid-game: their turn passes, the next player gets the question,
   * and if they come back inside the grace window they simply rejoin the rotation.
   */
  private pickTurnPlayer(): PlayerState | null {
    const order = this.state.turnOrder;
    if (order.length === 0) return null;
    for (let step = 0; step < order.length; step++) {
      const candidate = this.player(order[(this.state.turnCursor + step) % order.length]);
      if (candidate?.connected) {
        this.state.turnCursor = (this.state.turnCursor + step + 1) % order.length;
        return candidate;
      }
    }
    return null;
  }

  /** Who the room is still waiting on this round. */
  private expectedAnswerers(): PlayerState[] {
    if (this.state.settings.mode === "TURN_BASED") {
      const turn = this.state.currentTurnPlayerId ? this.player(this.state.currentTurnPlayerId) : null;
      return turn && turn.connected ? [turn] : [];
    }
    return this.connectedPlayers();
  }

  private submitAnswer(
    player: PlayerState,
    message: Extract<ClientMessage, { type: "SUBMIT_ANSWER" }>,
    now: number
  ): Effect[] {
    const deny = (code: MultiplayerErrorCode): Effect[] => [
      { kind: "send", playerId: player.id, message: errorMessage(code) },
    ];

    if (!OPEN_PHASES.includes(this.state.phase)) return deny("TOO_LATE");
    // An answer for a different question is a late packet from the previous
    // round, or a client trying to answer ahead. Either way it is not this round.
    if (message.questionIndex !== this.state.questionIndex) return deny("TOO_LATE");
    if (this.state.phaseDeadlineAt !== null && now > this.state.phaseDeadlineAt) return deny("TOO_LATE");
    if (this.state.roundAnswers.some((a) => a.playerId === player.id)) return deny("ALREADY_ANSWERED");
    if (this.state.settings.mode === "TURN_BASED" && this.state.currentTurnPlayerId !== player.id) {
      return deny("NOT_YOUR_TURN");
    }

    const question = this.state.questions[this.state.questionIndex];
    if (!question) return deny("SERVER_ERROR");

    const freeText = this.state.settings.answerMode === "FREE_TEXT" && question.supportsFreeText;

    let correct = false;
    let matchKind: MatchKind | null = null;
    let optionId: number | null = null;
    let typed: string | null = null;

    if (message.reveal) {
      // Gave up. Scored as not correct, and reported separately so the room can
      // say "נחשף" rather than "טעה".
      correct = false;
    } else if (freeText) {
      typed = (message.typed ?? "").trim();
      if (!typed) return deny("INVALID_MESSAGE");
      const result = matchAnswer(typed, {
        canonical: question.canonicalAnswer ?? "",
        aliases: question.aliases,
      });
      correct = result.correct;
      matchKind = result.kind;
    } else {
      // The option id has to be one this question actually offers: a client that
      // invents an id, or replays another question's, gets nothing.
      const option = question.options.find((o) => o.id === message.optionId);
      if (!option) return deny("INVALID_MESSAGE");
      optionId = option.id;
      correct = option.isCorrect;
    }

    const started = this.state.questionStartedAt ?? now;
    const timeMs = Math.min(this.limitMs(), Math.max(0, now - started));

    const score = scoreAnswer({
      correct,
      revealed: message.reveal,
      timeMs,
      limitMs: this.limitMs(),
      streakBefore: player.streak,
      hintsUsed: player.hintsUsedThisRound,
      streakBonusEnabled: streakBonusEnabled(this.state.settings.mode),
    });

    // Recorded, NOT applied. The player's score, streak and counters are only
    // moved when the round closes — see `applyRound`.
    //
    // This is not tidiness, it is the leak it closes: the room view carries every
    // player's score, so bumping it here would broadcast "that answer was right"
    // to the whole room the instant somebody tapped, which is exactly what the
    // reveal exists to withhold. The score is computed now, while the pre-round
    // streak is still intact, and banked until the reveal.
    this.state.roundAnswers.push({
      playerId: player.id,
      optionId,
      typed,
      correct,
      revealed: message.reveal,
      timeMs,
      hintsUsed: player.hintsUsedThisRound,
      points: score.total,
      matchKind,
    });

    const expected = this.expectedAnswerers();
    const effects: Effect[] = [
      {
        kind: "broadcast",
        message: {
          type: "ANSWER_RECEIVED",
          playerId: player.id,
          answeredCount: this.state.roundAnswers.length,
          expectedCount: expected.length,
        },
      },
    ];

    // Still open, but no longer untouched. Note that NO score is broadcast here:
    // a score update before the reveal would tell everyone whether the answer was
    // right, which is exactly what the reveal is for.
    if (this.state.phase === "QUESTION") this.state.phase = "WAITING_FOR_ANSWERS";

    effects.push(...this.broadcastState(now));
    effects.push(...this.closeRoundIfComplete(now));
    return effects;
  }

  private requestHint(player: PlayerState, questionIndex: number, now: number): Effect[] {
    if (!this.state.settings.hintsAllowed) return [];
    if (!OPEN_PHASES.includes(this.state.phase)) return [];
    if (questionIndex !== this.state.questionIndex) return [];
    if (this.state.settings.mode === "TURN_BASED" && this.state.currentTurnPlayerId !== player.id) {
      return [{ kind: "send", playerId: player.id, message: errorMessage("NOT_YOUR_TURN") }];
    }
    if (this.state.roundAnswers.some((a) => a.playerId === player.id)) return [];

    const question = this.state.questions[this.state.questionIndex];
    if (!question) return [];
    const hintIndex = player.hintsUsedThisRound;
    if (hintIndex >= question.hints.length) return [];

    // Counted here, on the server, before the text is handed over. A client that
    // reads a hint and then hides it from us does not exist: it never had the
    // text to begin with.
    player.hintsUsedThisRound = hintIndex + 1;

    return [
      {
        kind: "send",
        playerId: player.id,
        message: {
          type: "HINT",
          questionIndex: this.state.questionIndex,
          hintIndex,
          text: question.hints[hintIndex],
        },
      },
    ];
  }

  private closeRoundIfComplete(now: number): Effect[] {
    if (!OPEN_PHASES.includes(this.state.phase)) return [];
    const expected = this.expectedAnswerers();
    // Nobody left to answer at all — close rather than wait out the clock.
    if (expected.length === 0) return this.closeRound(now);
    const answered = new Set(this.state.roundAnswers.map((a) => a.playerId));
    if (expected.every((p) => answered.has(p.id))) return this.closeRound(now);
    return [];
  }

  /**
   * Banks the round: the points recorded during the answer window are applied to
   * the players now, at the reveal, and not a moment earlier.
   *
   * A player who was expected to answer and did not has their streak broken. That
   * is the honest rule — a run of correct answers should not survive a question
   * you sat out — and it only applies to players the room was actually waiting on,
   * so a disconnected player is not punished for being disconnected.
   */
  private applyRound(): void {
    const expected = new Set(this.expectedAnswerers().map((p) => p.id));

    for (const player of this.state.players) {
      const answer = this.state.roundAnswers.find((a) => a.playerId === player.id);

      if (!answer) {
        if (expected.has(player.id)) player.streak = 0;
        continue;
      }

      player.score += answer.points;
      player.responseTimes.push(answer.timeMs);
      if (answer.correct) {
        player.correctCount += 1;
        player.streak += 1;
        if (player.streak > player.bestStreak) player.bestStreak = player.streak;
      } else {
        player.wrongCount += 1;
        player.streak = 0;
      }
    }
  }

  private closeRound(now: number): Effect[] {
    const question = this.state.questions[this.state.questionIndex];
    if (!question) return [];

    this.applyRound();
    this.state.phase = "ANSWER_REVEAL";
    this.state.phaseDeadlineAt = now + REVEAL_MS;

    const correctOption = question.options.find((o) => o.isCorrect) ?? null;
    const answerText =
      question.canonicalAnswer && question.canonicalAnswer.trim().length > 0
        ? question.canonicalAnswer
        : (correctOption?.text ?? "");

    // Everyone in the room gets a row, including players who never answered:
    // "לא ענה" is information the scoreboard needs.
    const relevant =
      this.state.settings.mode === "TURN_BASED"
        ? this.state.players.filter((p) => p.id === this.state.currentTurnPlayerId)
        : this.state.players;

    const results: PlayerRoundResult[] = relevant.map((p) => {
      const answer = this.state.roundAnswers.find((a) => a.playerId === p.id);
      return {
        playerId: p.id,
        answered: !!answer,
        correct: answer?.correct ?? false,
        revealed: answer?.revealed ?? false,
        timeMs: answer?.timeMs ?? null,
        hintsUsed: answer?.hintsUsed ?? 0,
        pointsAwarded: answer?.points ?? 0,
        matchKind: answer?.matchKind ?? null,
        typedAnswer: answer?.typed ?? null,
      };
    });

    // The round goes to the highest scoring correct answer. Ties share it.
    const best = Math.max(0, ...this.state.roundAnswers.filter((a) => a.correct).map((a) => a.points));
    this.state.roundWinnerIds =
      best > 0
        ? this.state.roundAnswers.filter((a) => a.correct && a.points === best).map((a) => a.playerId)
        : [];

    const reveal: RoundReveal = {
      questionIndex: this.state.questionIndex,
      correctOptionId: correctOption?.id ?? null,
      correctAnswer: answerText,
      explanationHe: question.explanationHe,
      results,
      roundWinnerIds: [...this.state.roundWinnerIds],
    };
    this.state.lastReveal = reveal;

    return [
      { kind: "broadcast", message: { type: "ANSWER_REVEAL", reveal, deadlineAt: this.state.phaseDeadlineAt, serverNow: now } },
      { kind: "broadcast", message: this.scoreUpdate(now) },
      ...this.broadcastState(now),
    ];
  }

  private scoreUpdate(now: number): ServerMessage {
    return {
      type: "SCORE_UPDATE",
      scores: this.state.players.map((p) => ({ playerId: p.id, score: p.score, streak: p.streak })),
      teamScores: this.state.settings.mode === "TEAM_BATTLE" ? teamTotals(this.publicPlayers(now)) : null,
    };
  }

  /** Football language for who took the round. Never generic. */
  private roundHeadline(): string {
    const winners = this.state.roundWinnerIds.map((id) => this.player(id)?.name).filter(Boolean) as string[];
    if (winners.length === 0) return ROUND_HEADLINE_NOBODY;
    if (winners.length === 1) return `${winners[0]} לקח את הסיבוב`;
    if (winners.length === 2) return `${winners[0]} ו${winners[1]} חולקים את הסיבוב`;
    return ROUND_HEADLINE_TIE;
  }

  // ------------------------------------------------------------------- clock

  /**
   * The alarm handler: everything the passage of time can cause, in one place.
   * Runs the grace sweep first, because a player timing out can itself close the
   * round that is about to be checked.
   */
  tick(now: number): Effect[] {
    if (this.state.closed) return [];
    const effects: Effect[] = [];

    effects.push(...this.sweepDisconnected(now));
    if (this.state.closed) return effects;

    // A room nobody is connected to, and an ancient room, are both swept.
    if (
      this.connectedPlayers().length === 0 &&
      now - this.state.lastActivityAt >= EMPTY_ROOM_TTL_MS
    ) {
      return [...effects, ...this.close("החדר נסגר מחוסר פעילות.", now)];
    }
    if (now - this.state.lastActivityAt >= ROOM_IDLE_TTL_MS) {
      return [...effects, ...this.close("החדר נסגר מחוסר פעילות.", now)];
    }

    const deadline = this.state.phaseDeadlineAt;
    if (deadline === null || now < deadline) return effects;

    switch (this.state.phase) {
      case "COUNTDOWN":
        return [...effects, ...this.openQuestion(0, now)];

      case "QUESTION":
      case "WAITING_FOR_ANSWERS":
        return [...effects, ...this.closeRound(now)];

      case "ANSWER_REVEAL": {
        this.state.phase = "ROUND_RESULTS";
        this.state.phaseDeadlineAt = now + ROUND_RESULTS_MS;
        return [
          ...effects,
          {
            kind: "broadcast",
            message: {
              type: "ROUND_RESULT",
              roundWinnerIds: [...this.state.roundWinnerIds],
              headlineHe: this.roundHeadline(),
              deadlineAt: this.state.phaseDeadlineAt,
              serverNow: now,
            },
          },
          ...this.broadcastState(now),
        ];
      }

      case "ROUND_RESULTS": {
        const isLast = this.state.questionIndex >= this.state.questions.length - 1;
        if (isLast) {
          this.state.phase = "LEADERBOARD";
          this.state.phaseDeadlineAt = now + LEADERBOARD_MS;
          return [
            ...effects,
            {
              kind: "broadcast",
              message: { type: "LEADERBOARD_UPDATE", standings: buildStandings(this.publicPlayers(now)) },
            },
            ...this.broadcastState(now),
          ];
        }
        this.state.phase = "NEXT_QUESTION";
        this.state.phaseDeadlineAt = now + NEXT_QUESTION_MS;
        return [...effects, ...this.broadcastState(now)];
      }

      case "NEXT_QUESTION":
        return [...effects, ...this.openQuestion(this.state.questionIndex + 1, now)];

      case "LEADERBOARD":
        return [...effects, ...this.finish(now, null)];

      default:
        this.state.phaseDeadlineAt = null;
        return effects;
    }
  }

  /**
   * Players whose grace window closed.
   *
   * In the lobby they lose their seat. Mid-game they keep their score and their
   * row in the standings — they played those questions — but they stop being
   * waited on, and in a duel their absence hands the win to their opponent.
   */
  private sweepDisconnected(now: number): Effect[] {
    const expired = this.state.players.filter(
      (p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= RECONNECT_GRACE_MS
    );
    if (expired.length === 0) return [];

    const effects: Effect[] = [];
    for (const player of expired) {
      // Mark the timeout as handled so the same player is not swept every tick.
      player.disconnectedAt = null;

      if (this.state.phase === "LOBBY") {
        effects.push(...this.removePlayer(player, now, "PLAYER_LEFT"));
        continue;
      }

      if (this.state.hostId === player.id) {
        effects.push(...this.transferHost(now));
      }
      effects.push(...this.broadcastState(now));
    }

    effects.push(...this.closeRoundIfComplete(now));
    effects.push(...this.forfeitIfDuelAbandoned(now));
    return effects;
  }

  /**
   * A duel with one player left standing.
   *
   * Stated plainly because it decides a result: in a one-on-one, if your opponent
   * does not come back inside the grace window, you win by forfeit. Anything
   * gentler would mean a player who is losing can take the result away by pulling
   * the plug.
   */
  private forfeitIfDuelAbandoned(now: number): Effect[] {
    if (!isDuelMode(this.state.settings.mode)) return [];
    if (this.state.phase === "LOBBY" || this.state.phase === "FINISHED" || this.state.phase === "REMATCH_WAITING") {
      return [];
    }
    const present = this.state.players.filter((p) => p.connected || p.disconnectedAt !== null);
    if (present.length >= 2) return [];

    const absent = this.state.players.find((p) => !p.connected && p.disconnectedAt === null);
    return this.finish(now, absent?.id ?? null);
  }

  private finish(now: number, forfeitedBy: string | null): Effect[] {
    const standings = buildStandings(this.publicPlayers(now));
    const teamResult =
      this.state.settings.mode === "TEAM_BATTLE"
        ? buildTeamResult(this.publicPlayers(now), this.state.settings.teamNames)
        : null;

    // A forfeit overrides the scoreline: the player who stayed wins, whatever the
    // board said when the other one left.
    const winnerIds = forfeitedBy
      ? this.state.players.filter((p) => p.id !== forfeitedBy).map((p) => p.id)
      : winnerIdsFrom(standings);

    const result: GameResult = {
      mode: this.state.settings.mode,
      standings,
      teamResult,
      winnerIds,
      forfeitedBy,
      startedAt: this.state.startedAt ?? now,
      finishedAt: now,
    };

    this.state.phase = "FINISHED";
    this.state.phaseDeadlineAt = null;
    this.state.finishedAt = now;
    this.state.forfeitedBy = forfeitedBy;
    this.state.played = true;
    this.state.result = result;
    this.state.rematchRequested = [];
    this.state.currentTurnPlayerId = null;

    return [
      { kind: "broadcast", message: { type: "GAME_FINISHED", result } },
      ...this.broadcastState(now),
      { kind: "persist", result },
    ];
  }

  // ----------------------------------------------------------------- resume

  /**
   * Everything a socket that has just attached needs in order to render the
   * moment it walked into, beyond the room state it is already sent.
   *
   * This exists because ROOM_STATE alone is not enough: it says "we are in the
   * ANSWER_REVEAL phase of question four" but carries no question and no reveal,
   * so a player who refreshes mid-round would see a scoreboard, a clock, and an
   * empty space where the question should be. That is the single most likely
   * moment for a refresh to happen — a phone that has just woken up — so it has
   * to work rather than merely not crash.
   *
   * Already-paid-for hints are replayed too. The player was charged for them when
   * they asked; making them buy the same hint again because their signal dropped
   * would be charging twice for one thing.
   */
  resumeMessages(playerId: string | null, now: number): ServerMessage[] {
    const messages: ServerMessage[] = [];
    const deadline = this.state.phaseDeadlineAt ?? now;

    const inRound =
      this.state.phase === "QUESTION" ||
      this.state.phase === "WAITING_FOR_ANSWERS" ||
      this.state.phase === "ANSWER_REVEAL" ||
      this.state.phase === "ROUND_RESULTS" ||
      this.state.phase === "NEXT_QUESTION";

    if (inRound) {
      const question = this.liveQuestion(this.state.questionIndex);
      if (question) {
        messages.push({ type: "QUESTION_STARTED", question, deadlineAt: deadline, serverNow: now });
      }

      if (this.state.settings.mode === "TURN_BASED" && this.state.currentTurnPlayerId) {
        const turn = this.player(this.state.currentTurnPlayerId);
        if (turn) {
          messages.push({
            type: "TURN_STARTED",
            playerId: turn.id,
            name: turn.name,
            deadlineAt: deadline,
            serverNow: now,
          });
        }
      }

      messages.push(this.scoreUpdate(now));

      const player = playerId ? this.player(playerId) : null;
      if (player && this.state.settings.hintsAllowed) {
        const question = this.state.questions[this.state.questionIndex];
        for (let index = 0; index < player.hintsUsedThisRound; index++) {
          const text = question?.hints[index];
          if (text) {
            messages.push({ type: "HINT", questionIndex: this.state.questionIndex, hintIndex: index, text });
          }
        }
      }

      if (this.state.lastReveal && this.state.phase !== "QUESTION" && this.state.phase !== "WAITING_FOR_ANSWERS") {
        messages.push({
          type: "ANSWER_REVEAL",
          reveal: this.state.lastReveal,
          deadlineAt: deadline,
          serverNow: now,
        });
      }

      if (this.state.phase === "ROUND_RESULTS") {
        messages.push({
          type: "ROUND_RESULT",
          roundWinnerIds: [...this.state.roundWinnerIds],
          headlineHe: this.roundHeadline(),
          deadlineAt: deadline,
          serverNow: now,
        });
      }
    }

    if (this.state.phase === "LEADERBOARD") {
      messages.push({ type: "LEADERBOARD_UPDATE", standings: buildStandings(this.publicPlayers(now)) });
    }

    if ((this.state.phase === "FINISHED" || this.state.phase === "REMATCH_WAITING") && this.state.result) {
      messages.push({ type: "GAME_FINISHED", result: this.state.result });
      if (this.state.phase === "REMATCH_WAITING") {
        messages.push({
          type: "REMATCH_STATUS",
          requested: [...this.state.rematchRequested],
          needed: this.connectedPlayers().length,
        });
      }
    }

    return messages;
  }

  // ---------------------------------------------------------------- rematch

  /**
   * "משחק חוזר".
   *
   * In a duel both players have to say yes, and until they do the one who asked
   * sees a waiting state rather than a dead button. In a private room the host
   * simply takes everyone back to the lobby, which is also where they can change
   * the settings before going again.
   */
  private requestRematch(player: PlayerState, now: number): Effect[] {
    if (this.state.phase !== "FINISHED" && this.state.phase !== "REMATCH_WAITING") return [];

    if (!isDuelMode(this.state.settings.mode)) {
      if (player.id !== this.state.hostId) {
        return [{ kind: "send", playerId: player.id, message: errorMessage("NOT_HOST") }];
      }
      return this.resetToLobby(now);
    }

    if (!this.state.rematchRequested.includes(player.id)) {
      this.state.rematchRequested.push(player.id);
    }
    const needed = this.connectedPlayers().length;
    const everybody = needed > 1 && this.state.rematchRequested.length >= needed;

    if (everybody) {
      // Back to the lobby; the Durable Object notices `pendingRematch` and starts
      // a fresh game with new questions on the spot.
      return this.resetToLobby(now);
    }

    this.state.phase = "REMATCH_WAITING";
    return [
      {
        kind: "broadcast",
        message: { type: "REMATCH_STATUS", requested: [...this.state.rematchRequested], needed },
      },
      ...this.broadcastState(now),
    ];
  }

  /** True when a duel rematch was agreed and the caller should start a new game. */
  rematchAgreed(): boolean {
    return (
      isDuelMode(this.state.settings.mode) &&
      this.state.phase === "LOBBY" &&
      this.state.played &&
      this.state.questions.length === 0
    );
  }

  private resetToLobby(now: number): Effect[] {
    this.state.phase = "LOBBY";
    this.state.questions = [];
    this.state.questionIndex = -1;
    this.state.questionStartedAt = null;
    this.state.phaseDeadlineAt = null;
    this.state.roundAnswers = [];
    this.state.roundWinnerIds = [];
    this.state.currentTurnPlayerId = null;
    this.state.rematchRequested = [];
    this.state.forfeitedBy = null;
    this.state.result = null;
    this.state.startedAt = null;
    this.state.finishedAt = null;
    for (const p of this.state.players) {
      p.score = 0;
      p.streak = 0;
      p.bestStreak = 0;
      p.correctCount = 0;
      p.wrongCount = 0;
      p.responseTimes = [];
      p.hintsUsedThisRound = 0;
    }
    this.touch(now);
    return this.broadcastState(now);
  }

  // ----------------------------------------------------------------- helpers

  private broadcastState(now: number): Effect[] {
    return [{ kind: "broadcast", message: { type: "ROOM_STATE", room: this.view(now), you: null } }];
  }

  private touch(now: number) {
    this.state.lastActivityAt = now;
  }
}

function averageOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/**
 * Public player ids. Short and random rather than sequential: a sequential id
 * would tell every client how many people have ever been in the room, and would
 * make another player's id guessable.
 */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
