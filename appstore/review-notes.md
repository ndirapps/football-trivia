# App Review — answer to "Guideline 2.1 – Information Needed" (2026-11-09)

Apple asked for six items in the **Notes** field of **App Review Information** in
App Store Connect, plus a screen recording. The block below is paste-ready
(it fits within the 4,000-character limit of the Notes field). After you record
the video, replace the placeholder with the link to it.

---

## Paste into App Store Connect → App Review Information → Notes

```
1. SCREEN RECORDING
Recorded on a physical iPhone running the latest iOS, starting from app launch: https://drive.google.com/file/d/1EDWma3MANIGANG_lspFJcLLUOi48oGgY/view?usp=sharing
It shows: guest play, a quick quiz, the custom quiz builder, a friends room played live against a second player, the in-room "report or block player" flow, Sign in with Apple, and account deletion. There is no paid content.

2. PURPOSE AND AUDIENCE
Football IQ is a Hebrew football (soccer) trivia game for Hebrew-speaking fans, teens and adults. It turns football knowledge into a quick, social game: a daily challenge (the same 10 questions for everyone), custom quizzes (league, era, difficulty, multiple-choice or typed answers), "Who am I?" player puzzles, live 1-on-1 duels against a random opponent, and private rooms for playing with friends. It is free, with no ads, no in-app purchases and no tracking.

3. HOW TO ACCESS THE MAIN FEATURES
No login is needed. On the first screen tap "המשיכו כאורח" (Continue as guest).
- Daily challenge: "האתגר היומי" button in the top bar.
- Custom quiz: Home → "בנו חידון" → pick options → start.
- Random duel: Home → "מצאו יריב לדו־קרב" → enter a name → wait to be matched (to test alone, open the app on two devices).
- Friends room: Home → "משחק עם חברים" → "פתחו חדר" → share the 6-digit code; a second device joins with the code.
- Report / block: in any room or duel, tap "דיווח או חסימת שחקן" at the bottom of the screen, choose the player and a reason, then "לדווח ולחסום" (report and block) or "לחסום בלי לדווח" (block only).
- Optional account: account button (top) → Sign in with Apple. It only syncs the chosen display name and stats between devices.
- Delete account: account button → profile → "מחיקת החשבון". This permanently deletes the account and revokes the Sign in with Apple token.
No demo account is needed: Sign in with Apple works with any Apple ID, and every feature also works as a guest.

User-generated content: the only free text another player sees is the display name. Names are filtered for offensive words on the server. Room chat in the iOS app is preset phrases only (no free text). Players can report and block others from inside every room. A blocked player's messages are hidden, their name is masked, and the matchmaker never pairs them again. Reports are stored on our server and reviewed by the developer within 24 hours. Offending names are added to the server-side filter.

4. EXTERNAL SERVICES
- Cloudflare Workers, D1 and Durable Objects: our backend (API, question database, real-time multiplayer rooms).
- Sign in with Apple: optional login.
- API-Football (api-sports.io): the source of the football facts (players, clubs, results) our questions are generated from. It is used offline on our side; the app never calls it.
- Apple local notifications: optional daily reminder, scheduled on the device.
No AI services, analytics, advertising or payment providers are used.

5. REGIONAL DIFFERENCES
None. The app works the same in all regions. Its interface and questions are in Hebrew.

6. REGULATED INDUSTRY / THIRD-PARTY MATERIAL
Not a regulated industry, and the app has no gambling or betting. The app contains no league, club or player logos, images or trademarks, only text facts (names, results, stats) licensed through our API-Football subscription. API-Football's terms permit using its data in apps.
```

---

## How to record the video (on your iPhone)

Requirements: a real iPhone on the **latest iOS**, the **same build** you are
submitting (install it via TestFlight), and the recording must **start from
launching the app**.

1. Settings → Control Center → add **Screen Recording**.
2. Delete the app and reinstall from TestFlight, so you start from the first screen.
3. Start recording from Control Center, then go to the home screen.
4. Tap the app icon (the launch must be in the video).
5. Go through this order (about 2–3 minutes):
   1. Welcome screen → "המשיכו כאורח".
   2. "האתגר היומי" (in the top bar) → answer 2–3 questions.
   3. "בנו חידון" → pick options → answer 2 questions → exit.
   4. "משחק עם חברים" → "פתחו חדר". On a second device (or in a browser at
      football-iq.beast-bootcamp-photon-auth.workers.dev) join with the code.
      Start a game, send a preset message.
   5. Tap "דיווח או חסימת שחקן" → pick the player → "שם פוגעני" →
      "לדווח ולחסום" → show the confirmation and that their name became
      "שחקן חסום" → "לצאת מהחדר".
   6. "מצאו יריב לדו־קרב" → enter a name → show the search (with a second device you get a match).
   7. Account button → Sign in with Apple → sign in → profile screen.
   8. Profile → "מחיקת החשבון" → confirm → show that you are back as a guest.
6. Stop the recording. Upload the video somewhere a link can be opened without
   logging in (YouTube "Unlisted", Google Drive "anyone with the link", Dropbox),
   and put the link in place of the placeholder.

## Before resubmitting

- [ ] Deploy the server (`npm run db:migrate:remote` for migration 0010, then `npm run deploy`).
- [ ] Build a new version (`npm run app:ios`), bump the build number in Xcode, and upload to TestFlight.
- [ ] Test the new build on a physical iPhone (guideline 2.1: bugs and crashes).
- [ ] Record the video from the new build.
- [ ] Paste the notes above into **App Review Information → Notes**, select the new build, and resubmit.
- [ ] Reply to the message in App Store Connect: "We added the requested information to the Notes field and resubmitted."
