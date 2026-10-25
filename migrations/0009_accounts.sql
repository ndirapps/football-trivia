-- Optional accounts, signed in with Apple.
--
-- An account is Apple's opaque user id (`sub`) and a display name the player
-- chose. No email, no real name: Sign in with Apple is asked for neither scope.
-- Everything a user owns hangs off `users.id` with ON DELETE CASCADE, so deleting
-- the user row is the whole of "delete my account".

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apple_sub TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  -- Kept only so account deletion can revoke the grant with Apple.
  apple_refresh_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The bearer token itself is never stored, only its SHA-256: a leaked table
-- cannot be replayed as sessions.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE user_stats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quizzes_played INTEGER NOT NULL DEFAULT 0,
  quiz_score_total INTEGER NOT NULL DEFAULT 0,
  best_quiz_score INTEGER NOT NULL DEFAULT 0,
  duels_played INTEGER NOT NULL DEFAULT 0,
  duels_won INTEGER NOT NULL DEFAULT 0,
  duels_lost INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  -- The one-time merge of a device's local duel stats has happened.
  local_merged INTEGER NOT NULL DEFAULT 0
);

-- Attribution going forward. NULL for guests and for everything before this.
ALTER TABLE quiz_attempts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE multiplayer_game_players ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
