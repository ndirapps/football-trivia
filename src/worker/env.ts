import type { MatchmakerDurableObject } from "./durable/MatchmakerDurableObject";
import type { RoomDurableObject } from "./durable/RoomDurableObject";

/**
 * The platform rate limiter's shape.
 *
 * Declared here rather than imported because the generated worker types describe
 * it only when a binding exists in the config, and this interface is what tells
 * the type checker the bindings below are real.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Every rate-limited surface gets its own binding, not a shared one.
 *
 * Separate namespace ids mean separate counters, so hammering room lookups
 * cannot deny you a quiz, and a generous quiz allowance cannot be spent on
 * minting rooms. The names are the units of policy; the limits live in
 * wrangler.jsonc next to them.
 */
export interface RateLimiters {
  /** Room creation: Durable Object allocation and six-digit code space. */
  RL_ROOM_CREATE?: RateLimiter;
  /** Room existence lookups — the code-enumeration oracle. */
  RL_ROOM_LOOKUP?: RateLimiter;
  /** Socket opens, for both rooms and matchmaking. */
  RL_SOCKET?: RateLimiter;
  /** Quiz generation and availability counts: the expensive D1 reads. */
  RL_QUIZ?: RateLimiter;
  /** Attempt logging: the only unauthenticated D1 write in the product. */
  RL_WRITE?: RateLimiter;
  /** Sign in with Apple: each call fetches Apple keys and may create a user. */
  RL_AUTH?: RateLimiter;
}

export type RateLimiterName = keyof RateLimiters;

export interface Env extends RateLimiters {
  DB: D1Database;
  ASSETS: Fetcher;
  /** One object per live room, addressed by room code via idFromName. */
  ROOM: DurableObjectNamespace<RoomDurableObject>;
  /** A single global queue for random duels. */
  MATCHMAKER: DurableObjectNamespace<MatchmakerDurableObject>;
  /** Sign in with Apple, server side (src/worker/auth/appleClient.ts). */
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  /** Secret: the .p8 key's PEM. */
  APPLE_PRIVATE_KEY?: string;
}
