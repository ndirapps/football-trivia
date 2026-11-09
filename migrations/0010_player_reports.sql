-- Reports of objectionable player names or messages (App Store guideline 1.2).
--
-- A report records what the reporter saw, not who they are: guests have no
-- account, and the reported player is identified only by their public block key
-- (a one-way handle on their private token) and the name shown at the time.
-- Reports are reviewed by the developer within 24 hours; an abusive name can then
-- be added to the blocked-words list in src/shared/multiplayer/moderation.ts.

CREATE TABLE player_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT,
  reported_key TEXT NOT NULL,
  reported_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  message_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX idx_player_reports_open ON player_reports(reviewed_at, created_at);
