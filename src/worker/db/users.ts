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
