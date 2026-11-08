// The in-flight quiz and the last result, kept in sessionStorage.
//
// This module was one of the two confirmed causes of the blank screen, and it
// failed in two distinct ways at once. Both were reproduced against production:
//
//   access threw        it used the global `sessionStorage` directly, with no
//                       guard. Safari with "Block all cookies" throws on the
//                       accessor, so `loadActiveQuiz()` threw inside QuizPage's
//                       render. React 19 unmounts the whole root when a render
//                       throws, so /play and /results went blank with no message
//                       — not a broken quiz, a missing product.
//
//   the shape was wrong `JSON.parse(raw) as ActiveQuizSession` catches text that
//                       is not JSON and nothing else. `[]`, `null`, `{}` and
//                       `{"quiz":null}` all parse cleanly and then throw one
//                       property access later: "Cannot read properties of
//                       undefined (reading 'questions')". Seven of nine junk
//                       payloads took out /play or /results this way, which is
//                       what a visitor whose tab survived a deployment with an
//                       older schema in it would hit.
//
// So every read now goes through the guarded store AND a predicate. A value that
// does not match is dropped and reported as absent — which is the state the
// pages already handle, because it is the state every visitor starts in.
//
// The validators check what the pages actually touch, which is `quiz.questions`
// being an array of things with an id and an options list. They deliberately do
// not re-validate every field of every question: this is a tripwire against
// corrupt and outdated data, not a schema engine, and a predicate that has to be
// updated for every new optional field is one that will drift out of date and
// start rejecting good data.

import type { AnswerRecord, Quiz, ScoreBreakdown } from "../../shared/types";
// Explicit .ts, matching privacy.ts and the other modules the Node test runner
// loads directly: its type-stripping loader does no extension resolution.
import { readJson, safeSession, writeJson } from "./safeStorage.ts";

const ACTIVE_KEY = "fiq_active_quiz";
const RESULT_KEY = "fiq_last_result";

export interface ActiveQuizSession {
  quiz: Quiz;
  startedAt: number;
  challengePublicId?: string;
  isDaily?: boolean;
  /** The daily challenge's date (YYYY-MM-DD), when isDaily. */
  dailyDate?: string;
}

export interface QuizResultSession {
  quiz: Quiz;
  answers: AnswerRecord[];
  score: ScoreBreakdown;
  durationSeconds: number;
  challengePublicId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A quiz the pages can render: questions present, an array, and each one usable. */
function isQuiz(value: unknown): value is Quiz {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.questions)) return false;
  if (!isRecord(value.configuration)) return false;
  return value.questions.every(
    (question) =>
      isRecord(question) &&
      typeof question.id === "number" &&
      typeof question.questionHe === "string" &&
      Array.isArray(question.options)
  );
}

function isActiveQuizSession(value: unknown): value is ActiveQuizSession {
  if (!isRecord(value)) return false;
  if (!isQuiz(value.quiz)) return false;
  // An empty question list is a quiz that cannot be played; treating it as
  // absent sends the player back to the builder instead of to an empty board.
  if (value.quiz.questions.length === 0) return false;
  return typeof value.startedAt === "number" && Number.isFinite(value.startedAt);
}

function isQuizResultSession(value: unknown): value is QuizResultSession {
  if (!isRecord(value)) return false;
  if (!isQuiz(value.quiz)) return false;
  // `t.answers is not iterable` was the second error every corrupted-storage
  // reproduction produced, from the results page spreading this.
  if (!Array.isArray(value.answers)) return false;
  if (!isRecord(value.score)) return false;
  return typeof value.score.total === "number";
}

export function saveActiveQuiz(session: ActiveQuizSession): void {
  // The return value is deliberately dropped. A browser that refuses storage
  // still plays the quiz — it just cannot survive a refresh, which is a far
  // better outcome than refusing to start.
  writeJson(safeSession, ACTIVE_KEY, session);
}

export function loadActiveQuiz(): ActiveQuizSession | null {
  return readJson(safeSession, ACTIVE_KEY, isActiveQuizSession);
}

export function clearActiveQuiz(): void {
  safeSession.remove(ACTIVE_KEY);
}

export function saveResult(result: QuizResultSession): void {
  writeJson(safeSession, RESULT_KEY, result);
}

export function loadResult(): QuizResultSession | null {
  return readJson(safeSession, RESULT_KEY, isQuizResultSession);
}
