# Accounts with Sign in with Apple

**Status:** draft — waiting on mockup approval. Nothing is built.
**Branch:** `accounts-sign-in-with-apple` (off `capacitor-mobile`).

## Why

Today Football IQ has no accounts. A player's name and their duel record
(`LocalStats` in `src/client/lib/mp/identity.ts`) live in one browser's
storage, and quiz results (`quiz_attempts`) belong to nobody. Reinstall the
app, switch phones, or clear Safari, and it is all gone.

An optional account fixes that: sign in once, and your name and stats follow
you. Sign in with Apple is the first provider because the iOS app is the first
place this ships, and it asks for nothing — no email, no password.

## Principles

1. **Guest stays the default.** Every feature keeps working without an account.
   Signing in is offered, never required — no gate in front of a quiz.
2. **Ask for nothing we do not use.** No email scope, no full name scope. The
   account is Apple's opaque user id (`sub`) and a display name the player
   types themselves.
3. **Deleting is as easy as creating.** App Store guideline 5.1.1(v): an app
   that lets you create an account must let you delete it in the app. Delete
   removes every row tied to the user and revokes the Apple token.
4. **The server is the authority for stats.** The client sends results; the
   server counts. A local counter is a cache, not a record.

## Scope (v1)

In:
- Sign in with Apple in the **iOS app** (native sheet).
- A profile screen: display name (editable), stats, sign out, delete account.
- Stats kept on the server per user: quizzes played, best score, average
  score, duels played / won / lost, best answer streak.
- On first sign-in, the device's existing local duel stats are merged in once.
- Quiz attempts and finished multiplayer games are attributed to the signed-in
  user going forward.

Out (later specs):
- Sign in on the web and on Android (Apple JS needs a Services ID and domain
  verification; Android needs the web flow). The button is hidden there in v1.
- Google sign-in, leaderboards, friends, per-question history across devices.

## User flow

1. Home shows a small account button in the header. Guest: a person icon.
   Signed in: the first letter of the display name.
2. Tapping it as a guest opens the **account sheet**: what an account gives
   you, the Sign in with Apple button, and "המשך כאורח".
3. Apple's native sheet confirms. On success the app asks for a display name
   once, prefilled with the name already saved on the device, if any.
4. Tapping the account button when signed in opens the **profile screen**:
   name, stats, sign out, delete account.
5. Delete asks for confirmation in a sheet that says plainly what is removed.
   After deletion the app is back to guest, with local data cleared.

## Backend

### Schema — migration `0009_accounts.sql`

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apple_sub TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  apple_refresh_token TEXT,            -- only to revoke on delete
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,         -- SHA-256 of the bearer token, never the token
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
  local_merged INTEGER NOT NULL DEFAULT 0   -- the one-time device merge happened
);

ALTER TABLE quiz_attempts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE multiplayer_game_players ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
```

Write cost on the D1 free tier is small: a sign-in is ~4 rows, a finished quiz
adds 1 row to `user_stats` on top of the attempt it already writes.

### Endpoints

| Method | Path | What |
|---|---|---|
| POST | `/api/auth/apple` | `{ identityToken, authorizationCode, nonce, displayName? }` → verifies, upserts the user, returns `{ token, user }` |
| GET | `/api/me` | the user and their stats |
| PATCH | `/api/me` | `{ displayName }` |
| POST | `/api/me/merge-local` | `{ played, wins, losses, bestStreak }` — accepted once per user, clamped |
| POST | `/api/auth/signout` | deletes this session |
| DELETE | `/api/me` | revokes the Apple token, deletes the user (cascades) |

Authenticated calls send `Authorization: Bearer <token>`. The existing
`/api/attempts` and the room's end-of-game write read the same header when it
is present and attribute the row; without it they behave exactly as today.

### Verifying Apple's identity token

In the Worker, no library: fetch Apple's keys from
`https://appleid.apple.com/auth/keys` (cached), verify the RS256 signature
with WebCrypto, then check `iss = https://appleid.apple.com`,
`aud = com.royasraf.footballiq`, `exp` in the future, and
`nonce = SHA-256(nonce the client generated)`. Only `sub` is used.

The `authorizationCode` is exchanged once for a refresh token, kept only so
that delete can call Apple's revoke endpoint. That exchange needs a client
secret: a JWT signed with a **Sign in with Apple key** (`.p8`) stored as a
Worker secret.

### Sessions

The bearer token is 32 random bytes, base64url, returned once. The server
stores only its SHA-256. No expiry in v1 (sign out or delete ends it);
`last_seen_at` updates at most once a day to keep writes down.

CORS for the app origins gains the `Authorization` header and the `PATCH` and
`DELETE` methods. `/api/auth/apple` gets its own rate limit (10/min per IP).

## Client

- iOS: `@capacitor-community/apple-sign-in` for the native sheet; the
  **Sign in with Apple** capability on the App ID and in the Xcode project.
- The token is stored in `localStorage` under a new **account** category in
  `privacy.ts` — essential while signed in, removed on sign out and delete.
- `src/client/lib/account.ts`: `signInWithApple()`, `signOut()`,
  `deleteAccount()`, `useAccount()`; `api.ts` adds the header when a token
  exists.
- New `ProfilePage` at `/profile` and an `AccountSheet` component; the header
  gets the account button.
- The Apple button follows Apple's HIG: white style on the dark background,
  the system Apple logo, the localized title "התחברות עם Apple".

## Privacy and store

- The privacy page gains a section: what an account stores (Apple's opaque id,
  the name you chose, your stats), that no email is collected, and how to
  delete.
- App Store Connect privacy labels: "User ID" and "Gameplay content", linked
  to the user, not used for tracking.
- In-app deletion is the delete button above (guideline 5.1.1(v)).

## What Roy needs to do (free)

1. In the Apple Developer portal: enable **Sign in with Apple** on the App ID
   `com.royasraf.footballiq`.
2. Create a **Sign in with Apple key** (Keys → +) and download the `.p8` once.
   Claude stores it as a Worker secret and never prints it.

## Acceptance criteria

1. A guest can play every mode exactly as today; no screen requires sign-in.
2. In the iOS app, Sign in with Apple completes and the header shows the
   player's initial.
3. Signing in on a second iPhone with the same Apple ID shows the same name
   and stats.
4. A finished quiz while signed in increments `quizzes_played` and updates
   `best_quiz_score` on the server; signed out, nothing changes server-side.
5. The first sign-in merges the device's duel stats once; signing out and in
   again does not add them twice.
6. Delete account removes the `users` row and everything cascading from it,
   revokes the Apple token, and returns the app to guest.
7. An expired, forged or wrong-audience identity token is rejected with 401.
8. The web build shows no account button and behaves exactly as today.
9. `npm test` and `npm run typecheck` pass; new tests cover token
   verification, the merge-once rule and delete cascading.

## Slices

1. **Backend** — migration, Apple token verification, sessions, `/api/auth/*`
   and `/api/me`, tests.
2. **Sign in and profile** — plugin, capability, account sheet, profile page,
   header button.
3. **Stats and delete** — attribution of attempts and duels, the one-time
   merge, delete with Apple revoke, privacy page.

Each slice is its own commit and is verified in the simulator before the next.
