# Football IQ — Retroactive UI/UX Review (6 pillars)

**Audited:** 2026-11-08
**Baseline:** Abstract 6-pillar standards, plus the project's own design rules in `src/client/styles/tokens.css` (navy ground, green = "correct/selected/go" only, colour scarce). No UI-SPEC exists.
**Primary target:** iPhone portrait, 390x844 (Capacitor iOS shell). Web is secondary.
**Screenshots:** Fresh captures from a production build (`npm run build` + `npx vite preview --port 8787`). The local Worker and local D1 served real quiz data, so every flow was played end to end, including a two-player local room. The images are in the session scratchpad (not committed):
`/private/tmp/claude-501/-Users-royasraf-Library-Application-Support-Claude-scratch-workspaces-4a881d01-e933-4bd4-9baf-a098ab5e6d49-498f4bfa-7ace-4729-ac0b-6cae4c5c65e3-scratch-2026-11-05-19723d/65193297-6c2e-4aa9-8ed7-303be9deb393/scratchpad/shots/`

> Note: `screenshots-prod/` and `screenshots-viewports/` in the repo are **stale**. They show an older green theme, six preset cards, and a different header, so they no longer match the product. Don't use them for QA or store assets until they are regenerated.

**Not verifiable in a browser:** Sign in with Apple, the WelcomeScreen, and real `env(safe-area-inset-*)` values. These only render inside the native shell, so they were reviewed from code only.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | Mixed imperative forms (התחל / הצטרף vs בנו / הצטרפו). "התחל משחק" opens the builder instead of starting a game. The free-text placeholder is wrong for non-name answers. English team names and broken bidi appear in multiplayer questions. |
| 2. Visuals | 2/4 | The GOAL/streak "shout" is off-centre and gets clipped off-screen in RTL. The net ripple renders off-screen. The question block jumps up after answering. The chat panel covers the answer options mid-question. |
| 3. Color | 3/4 | The token system is disciplined (good 60/30/10). However, `--text-3` on surfaces fails AA. Multiplayer uses green for "selected, not yet revealed", which breaks the product's own rule. Two CSS variables are undefined. |
| 4. Typography | 2/4 | 45 distinct font sizes and 6 weights. Wide letter-spacing on Hebrew labels. Lots of 11–12px text. Fonts load from Google at runtime, which is a problem for an app that should work offline. |
| 5. Spacing & touch | 2/4 | Builder pills are 29px tall with 4px gaps. Header icon buttons are 30x30. Several secondary actions are 34–35px. The sticky "הבא" button ignores the home-indicator safe area. There is no spacing scale (about 30 distinct px values). |
| 6. Experience Design | 2/4 | No visible way to quit a quiz, and the logo exits without confirming. Free text gets one try and the keyboard needs a tap on every question. No review of wrong answers on results. The daily challenge has no "already played" state and no retry. |

**Overall: 13/24**

---

## Top 3 Priority Fixes

1. **RTL centring bug in `.shout` / `.net` / `.mp-callout`.** `inset-inline-start: 50%` combined with `translate(-50%)` resolves to `right: 50%` in RTL, so the element lands half its width (or more) to the left of centre. Measured: the "מהיר!" shout sits at x=34–151 on a 390px screen, the "שלושער!" streak shout is clipped at x=−17, and the net ripple's centre is at x=−270 against an option centre of 195, so it is invisible apart from a stray vertical line inside the correct option. This is the main reward moment of the game and it looks broken. **Fix:** use physical `left: 50%` (as `.pitch-bg::after` already does at `global.css:461-466`) in `Shout.css:4`, `QuizPage.css:170`, and `mp.css:347, 383, 422`.
2. **Undersized touch targets in the most-tapped controls.** At ≤420px, builder pills are 29px tall with 4px gaps (`BuilderPage.css:360-363`; the comment at `:77` says "~38px", which is no longer true). Header icon buttons are 30x30 (`Header.css:109-112`). Other small targets: free-text hint and reveal buttons (35px), the mode-sheet "ביטול" (35px), chat presets (34px), and the daily pill (36px). Mis-taps are likely on a phone. **Fix:** make 44px the minimum height for pills and icon buttons (use `min-height: 44px` and keep the visual size with an inner padding or a `::before` hit-area). Let the builder scroll instead of squeezing five rows above the dock.
3. **No safe way out of a quiz, and the free-text flow is high-friction.** `/play` hides the daily and account links but keeps the logo link (`Header.tsx:29`), which leaves the run with no confirmation and no "exit" affordance. Free text gives one try, so a typo ends the question, and the input is not focused on touch (`FreeTextAnswer.tsx:38`), so every question costs an extra tap to open the keyboard. **Fix:** add an "יציאה" icon to the HUD with a confirm sheet, and make the logo use the same confirm. Allow 2 attempts, or show "כמעט!" on a near miss. Focus the input on touch after the first question, since the keyboard is already up.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

- **WARNING: inconsistent forms of address.** Most copy uses plural imperative (בנו, הקלידו, דלגו, נסו, הצטרפו, סרקו). Many primary CTAs use masculine singular: `HomePage.tsx:76` "התחל משחק", `MultiplayerPage.tsx:96-121` "צור חדר" / "הצטרף", the builder heading "צור משחק", `DailyPage.tsx:65` "התחל", and `ProfilePage` / Duel "מצא יריב", "חפש יריב חדש" (`RoomPage.tsx:648`). The same action is "הצטרף" on `/multiplayer` and "הצטרפו" on `/room/:code`. Pick plural and apply it everywhere.
- **WARNING: "התחל משחק" doesn't start a game.** `HomePage.tsx:69-78` navigates to `/build`. The largest button on the home screen promises the opposite of what it does, and the actual one-tap starts (presets) are visually subordinate pills. Rename it to "בנו חידון" (it then matches the subtitle "בנו חידון ותגלו"), or make it start a sensible default quiz.
- **WARNING: the free-text placeholder doesn't fit many questions.** `FreeTextAnswer.tsx:137` always says "שם השחקן, המועדון או הנבחרת…". Observed question: "מה התפקיד המדויק של מייקל אוון?" (answer: חלוץ). Use a neutral "התשובה שלכם…", or derive the hint from the answer type.
- **WARNING: data quality visible in UI.** Observed hint "השחקן הוא אנגליה" (should be "השחקן מאנגליה"). Local-seed multiplayer questions showed Latin names in both question and options ("M. Jansen", "Bayern München", "Austin", "FSV Mainz 05"). Verify whether production MP data has the same English names. It reads as untranslated in a Hebrew product.
- **WARNING: bidi corruption with Hebrew prefixes on Latin names.** The explanation "M. Jansen עבר מ-Borussia Mönchengladbach ל-Bayern München" renders as "Bayern-ל Borussia Mönchengladbach-מ עבר M. Jansen", and the question breaks with an orphaned "ל-" at line end. **Fix:** wrap Latin runs in `<bdi>` or insert U+2068/U+2069 isolates server-side when composing templates, or use Hebrew transliterations.
- Minor: "דו קרב אקראי" (Duel page) vs "דו־קרב" elsewhere. The daily date is raw ISO "2026-11-08" (`DailyPage.tsx:60`); use `toLocaleDateString("he-IL", {day:"numeric", month:"long"})`. The header's aria-label says "שאלה חדשה כל יום" (`Header.tsx:44`), but the daily challenge has 10 questions.
- Good: error copy is in Hebrew, specific, and actionable ("אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב."). The 404 copy has personality. The delete-account copy is clear about permanence.

### Pillar 2: Visuals (2/4)

- **BLOCKER (polish-critical): the Shout and net ripple are mispositioned in RTL.** See Top fix 1. Under reduced motion it gets worse: `.a-shout` loses its transform (`animations.css:332`), so the badge's right edge sits at screen centre.
- **WARNING: layout shift on answer.** `.sheet` is vertically centred (`QuizPage.css:10-16`), so when the explanation and the "הבא" button appear, the question and options jump up about 65px (question top moved from y=337 to y=270). It also puts the options mid-screen, with ~150px of dead space above the question, instead of in the thumb zone. **Fix:** top-align the sheet (`justify-content: flex-start`) with a fixed top margin, and reserve space for `.why`.
- **WARNING: the multiplayer chat panel covers the answers.** `.mp-talk-panel` opens upward over options 3 and 4 during a live, timed question. It is interactive, so it blocks taps on them. The incoming bubble (`mp.css:1384`, `inset-block-end: 132px`) sits on top of the 👏 reaction. **Fix:** open the panel downward or as a bottom sheet below the reactions, and disable it while the local player hasn't answered.
- **WARNING: the pitch background paints over cards.** `.pitch-bg` is `position: fixed; z-index: 0` (`global.css:443-449`), so it paints above non-positioned in-flow surfaces. The halfway line and centre circle visibly cut through the results stats card, the MP room-code card, and the home CTAs. **Fix:** give `.app-main` `position: relative; z-index: 1`, or set `.pitch-bg` to `z-index: -1`.
- WARNING: on the results screen, the 3-stat grid collapses to 2 columns on phones (`ResultsPage.css:121`), leaving an empty quadrant next to "50% דיוק". Use 3 columns or a single row.
- WARNING: the builder heading shows a 3px green focus ring after programmatic focus (`BuilderPage.tsx:116`, `tabIndex={-1}`, plus the global `[tabindex]:focus-visible` at `global.css:433`). Add `.bld-title:focus { outline: none }`.
- WARNING: the chat bubble tail uses physical radii `14px 14px 14px 4px` (`mp.css:1398`), so in RTL the tail points away from the sender's side. Use `border-end-start-radius`.
- Good: the correct/wrong states use colour **and** icon (✓/✗) **and** option-key fill, eliminated options recede, the explanation follows immediately, and screen-reader verdicts are present (`QuizPage.tsx:268-279`). The results score ring and rank give a clear focal point.

### Pillar 3: Color (3/4)

- Distribution follows the 60/30/10 split: navy ground and surfaces dominate, green is limited to CTAs and states, gold to score and streak.
- **WARNING: contrast failures (WCAG AA 4.5:1 for small text).** `--text-3 #75869c` on `--surface #152032` = **4.40**. It is used for most 11–12px labels (builder row labels, `.tiny`, HUD "נק׳", stat labels). `.opt-key` `--text-3` on `--surface-3` = **3.29**. Eliminated options (`.opt.is-out { opacity: .4 }`, `QuizPage.css:164`) give an effective **3.5**, which contradicts the comment "stay readable". Disabled primary buttons are about 2.9 ("הצטרפו" before a name is typed reads as broken rather than disabled). **Fix:** raise `--text-3` to about `#8596ab`, and use opacity 0.55 for `.is-out`.
- **WARNING: green means "selected" before the reveal in multiplayer.** The player's picked option gets a green border while waiting (observed in a 2-player room). This violates the tokens rule "green = correct" and makes players think they got it right. Use blue (`--blue`, defined as "neutral/informational") for pending selection.
- WARNING: undefined variables `--accent` (`mp.css:1334, 1401, 1413`) and `--text-dim` (`mp.css:1370, 1481, 1529`). Bubble accents fall back to `currentColor` and the counters to inherited text.
- Minor: green also carries the brand "IQ", the daily pill, filter selection, and the primary CTA. Green is overloaded but still within the documented role "go/selected".

### Pillar 4: Typography (2/4)

- **WARNING: no type scale.** 45 distinct rem sizes in CSS (0.65 … 3.1rem: 0.72, 0.73, 0.74, 0.75, 0.76, 0.78 all coexist) and 6 weights (400–900, mostly 600/700/800). Consolidate to about 6 sizes (12/14/16/20/26/40) and 3 weights (500/700/900).
- **WARNING: letter-spacing on Hebrew.** `MultiplayerPage.css:13` (0.22em), `:38`, `:152`, `RoomPage.css:84, 158`, `HomePage.css:193`, `mp.css:40, 965, 1059`. Tracking breaks Hebrew word shapes ("ר ב  מ ש ת ת פ י ם"). Remove it on Hebrew text and keep it only for Latin or numerals.
- WARNING: much of the copy is 11–12px (`BuilderPage.css:359` 0.72rem row labels, `mp.css` 0.7–0.72rem, the HUD tags). Combined with the `--text-3` contrast, this hurts readability on a phone.
- WARNING: fonts load at runtime from Google (`global.css:1`, `index.html:17-18`). In the iOS app this is a network dependency at startup, it falls back to system fonts offline, and it is a third-party request that the privacy copy ("אין מעקב") arguably should disclose. Self-host Rubik and Assistant (Hebrew subsets) in `dist`.
- Good: tabular numerals for scores and timers (`.num`), sizes in rem driven by the `--text-scale` accessibility setting, and `text-wrap: balance` on questions.

### Pillar 5: Spacing & Touch (2/4)

Measured at 390px:

| Control | Size | Where |
|---|---|---|
| Builder pills (all options) | 29px tall, 4px gap | `BuilderPage.css:360-363` |
| Header sound/a11y/account | 30x30 | `Header.css:109-112` |
| Daily pill | 124x36 | `Header.css:150` |
| Mode-sheet "ביטול" | 62x35 | `HomePage.tsx:214` |
| Free-text "רמז" / "גלה תשובה" | 99x35 / 121x35 | `FreeTextAnswer.tsx:151-163` |
| MP chat presets, toggle | 34px tall | `mp.css:1320` |
| MP lobby segmented controls | 38px | RoomSettingsPanel |
| Quiz options, primary CTAs | 57px, 45–55px | OK |

- **WARNING: safe area on the sticky "הבא".** `.quiz-next { position: sticky; inset-block-end: 12px }` (`QuizPage.css:196-200`). With `viewport-fit=cover` and `contentInset: "never"`, the button sits inside the 34px home-indicator zone on Face ID iPhones, so swipe-up gestures compete with "next". Use `calc(12px + env(safe-area-inset-bottom))`. The builder dock, account sheet, mode sheet, and welcome screen already handle this correctly.
- WARNING: no spacing scale. About 30 distinct px values in gaps, padding, and margins (2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,20,22,24,26,28,30…). 24 raw `border-radius` values bypass the `--r-*` tokens (mostly in `mp.css`).
- WARNING: the host lobby is about 1,600px tall. "התחל משחק" sits under five settings groups and advanced filters (screenshot 31). Collapse settings behind a summary row ("קרב רגיל · 10 שאלות · 20 שנ׳ · ערוך") so Start is above the fold.
- Good: no horizontal overflow at 390px. Options span the full width. The top safe area is handled once on `#root` (`global.css:45`).

### Pillar 6: Experience Design (2/4)

- **WARNING: no quit or confirm in a quiz** (Top fix 3). The same applies to a live room, where the logo is the exit.
- **WARNING: free-text friction.** One attempt per question. No keyboard autofocus on touch (`FreeTextAnswer.tsx:38`), so each question costs tap input → type → send → "הבא". Free text is marked as the recommended mode in the mode sheet (`HomePage.tsx:199`), so this cost lands on the default path.
- **WARNING: taps to start.** A preset takes 2 taps plus a kickoff (topic, then mode sheet), and the mode is asked every time and never remembered. Remember the last mode, show it on the tiles ("כל העולם · חופשי"), and keep a long-press or small switch to change it.
- **WARNING: results don't teach.** There is a per-category breakdown, but no list of missed questions with the right answers (`ResultsPage.tsx:119-148`). For trivia, "what did I get wrong" is the main thing players want after the score.
- **WARNING: daily challenge states.** No "already played today / your score / come back in Xh" state. The challenge can be replayed freely, so the shared-daily idea loses its meaning. The error state offers only "בנו חידון משלכם" with no retry (`DailyPage.tsx:38-49`). The loading spinner is fine.
- WARNING: the quick-start loading state is weak. Only the tapped pill's label changes to "טוען…". The big CTAs stay enabled, and the request can take up to the heavy timeout (about 15s observed before the offline error). The error toast has no retry and sits below the fold on small phones. Show a full-width loading state or spinner on the tile, and add "נסו שוב" to the error.
- WARNING: the multiplayer reveal pushes the per-player result rows below the fold at 844px height (screenshot 38).
- No timer in solo play. If the brief expects a timer, it exists only in multiplayer (`MpAtoms.tsx:137-200`, with an urgent state under 5s). Solo has no time pressure apart from the "מהיר!" bonus.
- Good: Hebrew error mapping instead of raw server messages (`messageHeOf`). `/play` without a session redirects to the builder, and `/results` survives a reload. Delete account uses an `alertdialog` with Cancel focused (`ProfilePage.tsx:181-240`). The mode sheet supports Escape and focus. 404 and ErrorBoundary are in place. MP has a connection badge, kick confirmation via an explicit control, and a waiting-for-host state.

---

## Prioritized Improvements (user impact vs effort)

| # | Improvement | Impact | Effort |
|---|---|---|---|
| 1 | Fix the RTL centring of `.shout`, `.net`, `.mp-callout` (physical `left: 50%`) | High: the core reward moment is visibly broken or clipped | **S** |
| 2 | Add `env(safe-area-inset-bottom)` to the sticky `.quiz-next`, and audit other sticky bottoms in the native shell | High on every Face ID iPhone | **S** |
| 3 | 44px minimum targets: builder pills, header icon buttons, hint/reveal, sheet cancel, chat presets | High: mis-taps on the most-used controls | **S–M** |
| 4 | Quit button in the HUD with a confirm sheet, and confirm on the logo during `/play` and in rooms | High: no discoverable exit, and accidental loss of progress | **S** |
| 5 | Stop the quiz layout jump (top-align `.sheet`, reserve space for the explanation) | Medium–High: happens every question | **S** |
| 6 | Free text: 2 attempts or a near-miss prompt, autofocus after the first question, neutral placeholder | High on the recommended mode | **M** |
| 7 | Copy pass: one form of address (plural), rename "התחל משחק" → "בנו חידון", Hebrew date, "דו־קרב", fix hint grammar | Medium: trust and polish | **S** |
| 8 | Multiplayer: chat panel must not cover the options; blue (not green) for pending selection; collapse host settings so Start is above the fold | Medium–High in multiplayer | **M** |
| 9 | Results: "השאלות שפספסתם" list with the correct answers; daily "already played / come back tomorrow" state with a retry on error | Medium: retention and learning | **M** |
| 10 | Bidi isolation for Latin names in questions and explanations (`<bdi>` / U+2068–2069), plus Hebrew names in MP data | Medium: garbled sentences in MP | **M–L** (data) |
| 11 | Typography and colour tokens: about 6 sizes / 3 weights, remove Hebrew letter-spacing, raise `--text-3` to AA, define `--accent` / `--text-dim`, self-host fonts, fix `.pitch-bg` z-index | Medium: readability and offline robustness | **M** |
| 12 | Remember the last answer mode on the presets (1 tap to play) | Medium: fewer taps on the main loop | **S** |

---

## Files Audited

- `src/client/App.tsx`, `main.tsx`, `index.html`, `capacitor.config.ts`
- `src/client/styles/tokens.css`, `global.css`, `animations.css`
- `src/client/lib/presets.ts`, `lib/platform.ts`, `lib/api.ts`
- `src/client/pages/`: `HomePage.tsx/.css`, `QuizPage.tsx/.css`, `ResultsPage.tsx/.css`, `DailyPage.tsx`, `BuilderPage.tsx/.css`, `MultiplayerPage.tsx/.css`, `RoomPage.tsx/.css`, `ProfilePage.tsx`, `DuelSearchPage`
- `src/client/components/`: `Header.tsx/.css`, `Hud.tsx`, `FreeTextAnswer.tsx`, `Shout.css`, `Kickoff.tsx`, `WelcomeScreen.tsx`, `AccountSheet`, `mp/MpAtoms.tsx`, `mp/MpQuestion.tsx`, `mp/mp.css`
- Fresh screenshots (scratchpad, listed above): home, consent, mode sheet, MC question/answered, shout, free text (hint/wrong), results, builder, daily, multiplayer home, room lobby (host and guest), countdown, MP question/chat/bubble/reveal, duel, 404, offline start error.

Registry audit: skipped (no shadcn `components.json`).
