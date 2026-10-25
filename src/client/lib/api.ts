// The API client.
//
// Three things it has to get right, none of which it used to:
//
// TIMEOUTS. `fetch` has none. A request that is answered by nothing — the case
// on a phone that has lost its connection without the OS noticing yet — never
// settles, so the promise never rejects and whatever is awaiting it waits
// forever. That is the stuck spinner.
//
// But an aggressive timeout is its own bug. A cold Worker doing a scoped
// question query over a 15,000-row bank, from a phone on a weak cellular link,
// is legitimately slow, and cancelling that at three seconds turns a working
// request into a failure the visitor is told about. So the values below are
// generous and differ per operation, and they are documented here rather than
// scattered as magic numbers:
//
//   read, cheap      8s   counts and room summaries: one indexed query
//   read, expensive 15s   quiz generation, daily, challenge replay
//   write           15s   attempts and challenge creation
//
// RETRIES, AND ONLY WHERE THEY ARE SAFE. A GET or an idempotent read is retried
// on a transport failure or a 5xx; a POST that changes state is NOT, ever, even
// on a timeout — a timed-out attempt submission may well have been applied, and
// retrying it writes a second row. The one apparent exception is `/api/quiz`,
// which is a POST only because its filter does not fit in a query string: it
// creates nothing and is safe to repeat. That is marked explicitly at the call
// site rather than inferred from the method.
//
// 4xx is never retried. A 400 means the request was wrong and will be wrong
// again; a 429 means slow down, and retrying is the opposite of that.
//
// WHAT THE CALLER GETS. An `ApiError` carrying a kind, so a page can tell
// "offline" from "the server said no" from "this took too long" and say
// something true. The old client threw `new Error("Request failed")` for all
// three, which is where a vague "the server stopped responding" comes from: the
// client could not tell the difference and guessed the worst one.

import type { AnswerRecord, Quiz, QuizChallenge, QuizConfiguration, ScoreBreakdown } from "../../shared/types";
import type { MultiplayerMode } from "../../shared/multiplayer/types";
import { apiUrl } from "./origin";
import { readAccountToken } from "./accountToken";
import { noteRequestId, requestFinished, requestStarted } from "./startup";

export type ApiErrorKind =
  /** The request never reached anyone: no network, DNS, or the socket died. */
  | "offline"
  /** It reached someone and nobody answered in time. */
  | "timeout"
  /** The server answered, and the answer was an error. */
  | "server"
  /** The server answered 4xx: our request was wrong, or we are being throttled. */
  | "rejected";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Hebrew, safe to show. Server copy when it sent some, ours otherwise. */
  readonly messageHe: string;

  constructor(kind: ApiErrorKind, messageHe: string, status: number | null = null, detail?: string) {
    super(detail ?? messageHe);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.messageHe = messageHe;
  }
}

/**
 * A failure whose message is already written for a player to read.
 *
 * Exists so the pages have one rule — "show `messageHe`" — rather than two,
 * where some throws carry Hebrew in `.message` and others carry an English
 * server string that must not be shown. Guessing which was which by inspecting
 * the text is how English error strings end up on screen.
 */
export class UserMessageError extends Error {
  readonly messageHe: string;

  constructor(messageHe: string) {
    super(messageHe);
    this.name = "UserMessageError";
    this.messageHe = messageHe;
  }
}

/**
 * The one thing a catch block should call.
 *
 * Anything carrying `messageHe` has copy meant for a player; anything else is an
 * internal failure whose text is not fit to show, so it gets the caller's
 * fallback. This is what keeps a D1 error string out of the UI.
 */
export function messageHeOf(error: unknown, fallback = "משהו השתבש, נסו שוב."): string {
  if (error && typeof error === "object" && "messageHe" in error) {
    const value = (error as { messageHe?: unknown }).messageHe;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

const TIMEOUT_CHEAP_MS = 8_000;
const TIMEOUT_HEAVY_MS = 15_000;

/**
 * 500ms, 1s, 2s.
 *
 * Short enough to be invisible when it works — a Worker cold start or a single
 * dropped packet is recovered inside two and a half seconds — and capped at
 * three attempts so a genuine outage is reported promptly instead of being
 * retried into a worse experience than the error.
 */
const BACKOFF_MS = [500, 1000, 2000];

const COPY: Record<ApiErrorKind, string> = {
  offline: "אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.",
  timeout: "הבקשה לקחה יותר מדי זמן. נסו שוב.",
  server: "משהו השתבש אצלנו. נסו שוב.",
  rejected: "לא הצלחנו להשלים את הבקשה.",
};

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  /**
   * Whether repeating this request is harmless.
   *
   * Stated by the caller, not guessed from the method: `/api/quiz` is a POST
   * that creates nothing, and `/api/attempts` is a POST that must never run
   * twice. The method alone cannot tell them apart.
   */
  retryable?: boolean;
  /** Treated as a result rather than a failure — a 404 that means "no such room". */
  acceptStatuses?: number[];
}

/** True when the browser is certain there is no connection. Never trusted the other way. */
function definitelyOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * One attempt. Throws ApiError, or returns the Response for the caller to read.
 *
 * `AbortSignal.timeout` is feature-detected: it is Safari 16 and later, and on
 * anything older the request simply has no timeout rather than the whole call
 * throwing on an absent API. An old browser losing the timeout is a worse
 * experience; an old browser losing the app is a bug.
 */
async function attempt(path: string, options: RequestOptions, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  // Signed in: every call carries the session, so the server can attribute what
  // it records. Guests send nothing, and every route behaves as it always has.
  const accountToken = readAccountToken();
  if (accountToken) headers.Authorization = `Bearer ${accountToken}`;

  let signal: AbortSignal | undefined;
  let fallbackTimer: number | undefined;
  const controller = typeof AbortController === "undefined" ? null : new AbortController();

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    signal = AbortSignal.timeout(timeoutMs);
  } else if (controller) {
    signal = controller.signal;
    fallbackTimer = window.setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetch(apiUrl(path), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    return response;
  } catch (error) {
    const name = (error as Error)?.name;
    // Both spellings: AbortSignal.timeout rejects with TimeoutError, an explicit
    // controller.abort() with AbortError.
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ApiError("timeout", COPY.timeout);
    }
    throw new ApiError("offline", COPY.offline, null, (error as Error)?.message);
  } finally {
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
  }
}

/** The server's own Hebrew copy if it sent any, so route-specific wording survives. */
async function errorFromResponse(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string; messageHe?: string }
    | null;

  const kind: ApiErrorKind = response.status >= 500 ? "server" : "rejected";
  const messageHe = body?.messageHe ?? COPY[kind];
  return new ApiError(kind, messageHe, response.status, body?.error ?? response.statusText);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_CHEAP_MS;
  const maxAttempts = options.retryable ? BACKOFF_MS.length : 1;

  // Bracketed for the startup stage machine, in a try/finally below so a throw
  // on any path still closes the bracket — an in-flight counter that leaks would
  // mean APP_READY is never reached, and the whole point of the stage is to be
  // trustworthy when something has gone wrong.
  requestStarted();
  try {
    return await attemptAll<T>(path, options, timeoutMs, maxAttempts);
  } finally {
    requestFinished();
  }
}

async function attemptAll<T>(
  path: string,
  options: RequestOptions,
  timeoutMs: number,
  maxAttempts: number
): Promise<T> {
  let last: ApiError = new ApiError("server", COPY.server);

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      // Pointless to retry while the browser knows there is no connection; wait
      // for the next step rather than spending an attempt on a certain failure.
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[i - 1]));
    }

    try {
      const response = await attempt(path, options, timeoutMs);

      // The Worker stamps every response with this. Keeping it is what lets a
      // failure on a device be matched against the server's own log line for
      // the same request.
      noteRequestId(path, response.status, response.headers.get("X-Request-Id"));

      if (response.ok || options.acceptStatuses?.includes(response.status)) {
        if (options.acceptStatuses?.includes(response.status) && !response.ok) {
          // A handled status with no body to parse — the caller distinguishes it
          // by its own means (fetchRoomSummary returns null).
          return null as T;
        }
        return (await response.json()) as T;
      }

      const error = await errorFromResponse(response);
      // 4xx is a verdict, not a blip. Fail immediately.
      if (error.kind === "rejected") throw error;
      last = error;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.kind === "rejected") throw error;
      last = error;
      if (definitelyOffline() && i === maxAttempts - 1) break;
    }
  }

  throw last;
}

// --------------------------------------------------------------------- reads

export function fetchQuiz(config: QuizConfiguration): Promise<Quiz> {
  // A POST that creates nothing: the filter is too large for a query string.
  // Safe to repeat, and the heaviest read in the product.
  return request<Quiz>("/api/quiz", {
    method: "POST",
    body: config,
    timeoutMs: TIMEOUT_HEAVY_MS,
    retryable: true,
  });
}

export function fetchAvailableCount(config: QuizConfiguration): Promise<{ availableCount: number }> {
  // Cached server-side and called on every filter change, so it stays on the
  // short timeout and is not retried: a stale availability figure is a cosmetic
  // problem, and the builder already renders "לא הצלחנו לבדוק" for it.
  return request("/api/quiz/count", { method: "POST", body: config });
}

export interface AvailabilityResponse {
  total: number;
  types?: Record<string, number>;
  continents?: Record<string, number>;
  countries?: Record<string, number>;
  competitions?: Record<string, number>;
  presets?: Record<string, number>;
  presetCeiling?: number;
}

/**
 * Per-option availability for the step on screen.
 *
 * `dimensions` is the step's own dimension and nothing else — the server answers
 * a dimension with one GROUP BY, so asking for all of them on every step would
 * pay four times over for three numbers nobody is looking at. Same short timeout
 * and no retry as the plain count, for the same reason: a missing count greys
 * one card and the step still works.
 *
 * `gameMode: null` is meaningful rather than missing. The type step counts across
 * modes, because "מעורב" spans them.
 */
export function fetchAvailability(
  config: QuizConfiguration,
  dimensions: string[],
  options: { anyMode?: boolean } = {}
): Promise<AvailabilityResponse> {
  return request("/api/quiz/options", {
    method: "POST",
    body: { ...config, gameMode: options.anyMode ? null : config.gameMode, dimensions },
  });
}

export function fetchDaily(): Promise<{ date: string; quiz: Quiz }> {
  return request("/api/daily", { timeoutMs: TIMEOUT_HEAVY_MS, retryable: true });
}

export function fetchChallenge(publicId: string): Promise<{ challenge: QuizChallenge; quiz: Quiz }> {
  return request(`/api/challenges/${encodeURIComponent(publicId)}`, {
    timeoutMs: TIMEOUT_HEAVY_MS,
    retryable: true,
  });
}

/**
 * Checks a room before committing to it, so a mistyped code produces a clear
 * message instead of a socket that opens and immediately closes.
 * Resolves to null when there is no such room.
 */
export async function fetchRoomSummary(
  code: string
): Promise<{ exists: boolean; phase: string; playerCount: number; mode: string } | null> {
  // 404 and 400 are both "no such room" and are results, not failures. 429 is
  // not in the list on purpose: being throttled is not the same as the room not
  // existing, and telling a player their room is gone when it is not would be
  // worse than telling them to wait.
  return request("/api/mp/rooms/" + encodeURIComponent(code), {
    acceptStatuses: [400, 404],
    retryable: true,
  });
}

// -------------------------------------------------------------------- writes

export function createChallenge(config: QuizConfiguration): Promise<{ challenge: QuizChallenge; quiz: Quiz }> {
  // Writes a row. Never retried: a repeat creates a second challenge with a
  // second link, and the first one is the one already on the player's screen.
  return request("/api/challenges", { method: "POST", body: config, timeoutMs: TIMEOUT_HEAVY_MS });
}

/** Allocates a private multiplayer room and returns its code. */
export function createRoom(mode: MultiplayerMode): Promise<{ code: string; mode: MultiplayerMode }> {
  // Not retried: a repeat allocates a second Durable Object and hands back a
  // code for a room nobody is in.
  return request("/api/mp/rooms", { method: "POST", body: { mode }, timeoutMs: TIMEOUT_HEAVY_MS });
}

export function submitAttempt(payload: {
  answers: AnswerRecord[];
  durationSeconds: number;
  challengePublicId?: string;
}): Promise<{ attemptId: number; score: ScoreBreakdown }> {
  // Never retried. A timed-out submission may already have been written, and a
  // second attempt row for one quiz is worse than a missing one.
  return request("/api/attempts", { method: "POST", body: payload, timeoutMs: TIMEOUT_HEAVY_MS });
}

// ------------------------------------------------------------------ accounts

export interface AccountUser {
  displayName: string;
}

export interface AccountStats {
  quizzesPlayed: number;
  bestQuizScore: number;
  averageQuizScore: number;
  duelsPlayed: number;
  duelsWon: number;
  duelsLost: number;
  bestStreak: number;
}

export function signInWithAppleRequest(payload: {
  identityToken: string;
  authorizationCode: string;
  nonce: string;
  displayName: string;
}): Promise<{ token: string; user: AccountUser & { isNew: boolean }; stats: AccountStats }> {
  return request("/api/auth/apple", { method: "POST", body: payload, timeoutMs: TIMEOUT_HEAVY_MS });
}

export function fetchMe(): Promise<{ user: AccountUser; stats: AccountStats }> {
  return request("/api/me", { retryable: true });
}

export function updateMe(displayName: string): Promise<{ user: AccountUser }> {
  return request("/api/me", { method: "PATCH", body: { displayName } });
}

export function signOutRequest(): Promise<{ ok: true }> {
  return request("/api/auth/signout", { method: "POST" });
}

export function mergeLocalStatsRequest(local: {
  played: number;
  wins: number;
  losses: number;
  bestStreak: number;
}): Promise<{ merged: boolean; stats: AccountStats }> {
  return request("/api/me/merge-local", { method: "POST", body: local });
}

export function deleteAccountRequest(): Promise<{ deleted: true }> {
  return request("/api/me", { method: "DELETE", timeoutMs: TIMEOUT_HEAVY_MS });
}
