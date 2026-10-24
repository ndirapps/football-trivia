export interface AttemptInput {
  challengeId: number | null;
  score: number;
  questionCount: number;
  durationSeconds: number;
  /** The signed-in player, or null for a guest. */
  userId?: number | null;
}

export async function insertAttempt(db: D1Database, input: AttemptInput): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO quiz_attempts (challenge_id, score, question_count, duration_seconds, user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.challengeId, input.score, input.questionCount, input.durationSeconds, input.userId ?? null)
    .run();
  return Number(result.meta.last_row_id);
}

export async function getChallengeRowIdByPublicId(db: D1Database, publicId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT id FROM quiz_challenges WHERE public_id = ?`).bind(publicId).first<{ id: number }>();
  return row?.id ?? null;
}
