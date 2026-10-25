// D1 access for accounts: users, their sessions and their stats.
//
// Writes are kept to what a sign-in genuinely needs — a new user is three rows
// (user, stats, session), a returning one is one (the session) — because every
// row counts against the free plan's daily write allowance.

export interface AccountUser {
  id: number;
  displayName: string;
}

export interface UserStats {
  quizzesPlayed: number;
  bestQuizScore: number;
  averageQuizScore: number;
  duelsPlayed: number;
  duelsWon: number;
  duelsLost: number;
  bestStreak: number;
}

interface StatsRow {
  quizzes_played: number;
  quiz_score_total: number;
  best_quiz_score: number;
  duels_played: number;
  duels_won: number;
  duels_lost: number;
  best_streak: number;
}

/**
 * The user for an Apple `sub`, created on first sight.
 *
 * A returning user keeps the name they already have: the name sent with a
 * sign-in is only a suggestion for a brand-new account.
 */
export async function findOrCreateAppleUser(
  db: D1Database,
  appleSub: string,
  displayName: string
): Promise<AccountUser & { created: boolean }> {
  const existing = await db
    .prepare(`SELECT id, display_name FROM users WHERE apple_sub = ?`)
    .bind(appleSub)
    .first<{ id: number; display_name: string }>();
  if (existing) return { id: existing.id, displayName: existing.display_name, created: false };

  // INSERT ... ON CONFLICT DO NOTHING, then read back: two first sign-ins racing
  // each other end up on the same row rather than one of them failing.
  await db
    .prepare(`INSERT INTO users (apple_sub, display_name) VALUES (?, ?) ON CONFLICT(apple_sub) DO NOTHING`)
    .bind(appleSub, displayName)
    .run();
  const row = await db
    .prepare(`SELECT id, display_name FROM users WHERE apple_sub = ?`)
    .bind(appleSub)
    .first<{ id: number; display_name: string }>();
  if (!row) throw new Error("user insert did not persist");
  await db.prepare(`INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)`).bind(row.id).run();
  return { id: row.id, displayName: row.display_name, created: true };
}

export async function insertSession(db: D1Database, userId: number, tokenHash: string): Promise<void> {
  await db.prepare(`INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)`).bind(tokenHash, userId).run();
}

export async function userBySessionHash(
  db: D1Database,
  tokenHash: string
): Promise<(AccountUser & { lastSeenAt: string }) | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.display_name, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first<{ id: number; display_name: string; last_seen_at: string }>();
  return row ? { id: row.id, displayName: row.display_name, lastSeenAt: row.last_seen_at } : null;
}

export async function touchSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function updateDisplayName(db: D1Database, userId: number, displayName: string): Promise<void> {
  await db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).bind(displayName, userId).run();
}

export async function getUserStats(db: D1Database, userId: number): Promise<UserStats> {
  const row = await db
    .prepare(
      `SELECT quizzes_played, quiz_score_total, best_quiz_score, duels_played, duels_won, duels_lost, best_streak
         FROM user_stats WHERE user_id = ?`
    )
    .bind(userId)
    .first<StatsRow>();
  return toStats(row);
}

export function toStats(row: StatsRow | null): UserStats {
  if (!row) {
    return { quizzesPlayed: 0, bestQuizScore: 0, averageQuizScore: 0, duelsPlayed: 0, duelsWon: 0, duelsLost: 0, bestStreak: 0 };
  }
  return {
    quizzesPlayed: row.quizzes_played,
    bestQuizScore: row.best_quiz_score,
    averageQuizScore: row.quizzes_played > 0 ? Math.round(row.quiz_score_total / row.quizzes_played) : 0,
    duelsPlayed: row.duels_played,
    duelsWon: row.duels_won,
    duelsLost: row.duels_lost,
    bestStreak: row.best_streak,
  };
}

// ------------------------------------------------------------------ recording

/** The longest run of consecutive correct answers in a quiz. */
export function longestCorrectStreak(answers: readonly { correct: boolean }[]): number {
  let best = 0;
  let run = 0;
  for (const answer of answers) {
    run = answer.correct ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** One finished quiz: count it, add its score, and keep the best score and streak. */
export async function recordQuizForUser(db: D1Database, userId: number, score: number, streak: number): Promise<void> {
  await db
    .prepare(
      `UPDATE user_stats
          SET quizzes_played = quizzes_played + 1,
              quiz_score_total = quiz_score_total + ?,
              best_quiz_score = MAX(best_quiz_score, ?),
              best_streak = MAX(best_streak, ?)
        WHERE user_id = ?`
    )
    .bind(score, score, streak, userId)
    .run();
}

export interface DuelOutcome {
  played: number;
  won: number;
  lost: number;
}

/**
 * What a finished room means for one player's duel record.
 *
 * Only duel modes count as duels. A sole winner won; a tie for first is played
 * but neither won nor lost; everyone else lost — including the player who
 * forfeited by never coming back.
 */
export function duelOutcome(
  game: { winnerIds: readonly string[] },
  playerId: string,
  isDuel: boolean
): DuelOutcome {
  if (!isDuel) return { played: 0, won: 0, lost: 0 };
  const soleWinner = game.winnerIds.length === 1 ? game.winnerIds[0] : null;
  if (soleWinner === playerId) return { played: 1, won: 1, lost: 0 };
  if (game.winnerIds.length > 1 && game.winnerIds.includes(playerId)) return { played: 1, won: 0, lost: 0 };
  return { played: 1, won: 0, lost: 1 };
}

export function recordRoomForUserStatement(
  db: D1Database,
  userId: number,
  outcome: DuelOutcome,
  bestStreak: number
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE user_stats
          SET duels_played = duels_played + ?,
              duels_won = duels_won + ?,
              duels_lost = duels_lost + ?,
              best_streak = MAX(best_streak, ?)
        WHERE user_id = ?`
    )
    .bind(outcome.played, outcome.won, outcome.lost, bestStreak, userId);
}

// ------------------------------------------------------------------ the one-time device merge

export interface LocalDuelStats {
  played: number;
  wins: number;
  losses: number;
  bestStreak: number;
}

/** Device-side numbers are the client's word: bounded, whole, and internally consistent. */
export function clampLocalStats(value: unknown): LocalDuelStats | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const whole = (n: unknown, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(0, Math.trunc(n))) : 0;
  const played = whole(v.played, 10_000);
  const wins = Math.min(whole(v.wins, 10_000), played);
  const losses = Math.min(whole(v.losses, 10_000), played - wins);
  return { played, wins, losses, bestStreak: whole(v.bestStreak, 100) };
}

/** Adds the device's numbers once per account. Returns whether this call was the one. */
export async function mergeLocalStats(db: D1Database, userId: number, local: LocalDuelStats): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE user_stats
          SET duels_played = duels_played + ?,
              duels_won = duels_won + ?,
              duels_lost = duels_lost + ?,
              best_streak = MAX(best_streak, ?),
              local_merged = 1
        WHERE user_id = ? AND local_merged = 0`
    )
    .bind(local.played, local.wins, local.losses, local.bestStreak, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------------ Apple grant and deletion

export async function setAppleRefreshToken(db: D1Database, userId: number, refreshToken: string): Promise<void> {
  await db.prepare(`UPDATE users SET apple_refresh_token = ? WHERE id = ?`).bind(refreshToken, userId).run();
}

export async function getAppleRefreshToken(db: D1Database, userId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT apple_refresh_token FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ apple_refresh_token: string | null }>();
  return row?.apple_refresh_token ?? null;
}

/**
 * Removes the account and everything it owns, in one batch.
 *
 * Spelled out rather than left to ON DELETE CASCADE / SET NULL, so the result
 * does not depend on foreign-key enforcement being switched on: the history
 * rows stay (they are anonymous game records) but lose their owner.
 */
export async function deleteUser(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE quiz_attempts SET user_id = NULL WHERE user_id = ?`).bind(userId),
    db.prepare(`UPDATE multiplayer_game_players SET user_id = NULL WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM user_stats WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);
}
