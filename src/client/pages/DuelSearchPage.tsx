// Random duel matchmaking.
//
// The whole screen is one promise: press a button, get a real opponent. So the
// two things it must never do are fake a match and leave you stuck. There is no
// bot pretending to be a person — if the queue is empty you wait, and after a
// reasonable wait you are offered a choice rather than an indefinite spinner.
//
// The waiting state is a floodlight sweeping two empty VS slots rather than a
// loading indicator, because "we are looking for someone" is a different feeling
// from "please wait" and the copy rotating underneath keeps it honest about
// which one is happening.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MATCHMAKING_TIMEOUT_MS, MAX_NAME_LENGTH, SEARCHING_LINES_HE } from "../../shared/multiplayer/constants";
import { useMatchmaking } from "../lib/mp/useMatchmaking";
import { rememberPlayerName, savedPlayerName } from "../lib/mp/identity";
import { sound } from "../lib/sound";
import { motionAllowed } from "../lib/a11y";
import { Icon } from "../components/Icon";
import { Announcer } from "../components/mp/MpAtoms";
import { MatchFound, SearchingStage } from "../components/mp/MpStage";
import { ModeGlyph } from "./MultiplayerPage";
import "./DuelSearchPage.css";

/** How long the "match found" beat is held before the room takes over. */
const MATCH_BEAT_MS = 1400;

export function DuelSearchPage() {
  const navigate = useNavigate();
  const { snapshot, search, cancel, enteringGame } = useMatchmaking();
  const [nameDraft, setNameDraft] = useState(() => savedPlayerName());
  const [lineIndex, setLineIndex] = useState(0);
  const enteredRef = useRef(false);

  const searching = snapshot.state === "SEARCHING";
  const matched = snapshot.state === "MATCHED" && snapshot.match !== null;

  // Rotate the waiting copy. Slow enough to read, and it stops the moment there
  // is something better to say.
  useEffect(() => {
    if (!searching) return;
    const timer = window.setInterval(() => {
      setLineIndex((i) => (i + 1) % SEARCHING_LINES_HE.length);
    }, 3400);
    return () => window.clearInterval(timer);
  }, [searching]);

  // Match found: hold the beat, then hand over to the room, which runs the VS
  // intro and the countdown.
  useEffect(() => {
    if (!matched || !snapshot.match || enteredRef.current) return;
    enteredRef.current = true;
    const code = snapshot.match.roomCode;
    const timer = window.setTimeout(
      () => {
        enteringGame();
        navigate(`/room/${code}`);
      },
      motionAllowed() ? MATCH_BEAT_MS : 350
    );
    return () => window.clearTimeout(timer);
  }, [matched, snapshot.match, enteringGame, navigate]);

  function begin(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    rememberPlayerName(trimmed);
    sound.play("select");
    search(trimmed);
  }

  const announcement = matched
    ? `נמצא יריב: ${snapshot.match?.opponentName}`
    : searching
      ? snapshot.timedOut
        ? "לא נמצא יריב כרגע"
        : "מחפש יריב"
      : "";

  return (
    <div className="page mp-duel-page">
      <Announcer message={announcement} />

      {matched && snapshot.match ? (
        <MatchFound opponentName={snapshot.match.opponentName} />
      ) : searching ? (
        <div className="mp-duel-searching">
          <SearchingStage line={SEARCHING_LINES_HE[lineIndex]} queueSize={snapshot.queueSize} />

          {snapshot.timedOut ? (
            <div className="mp-duel-timeout">
              <p className="mp-duel-timeout-head">אין יריב פנוי כרגע.</p>
              <p className="mp-duel-timeout-body">
                מחכים כבר {Math.round(snapshot.waitedMs / 1000)} שניות. אפשר להמשיך לחכות, או לפתוח חדר
                ולהזמין מישהו.
              </p>
              <div className="mp-duel-timeout-actions">
                <button className="btn btn-ghost" onClick={() => search(nameDraft.trim())}>
                  <Icon name="replay" size={16} />
                  המשך לחפש
                </button>
                <Link to="/multiplayer" className="btn btn-ghost">
                  <Icon name="shirt" size={16} />
                  צור חדר פרטי
                </Link>
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    cancel();
                    navigate("/multiplayer");
                  }}
                >
                  ביטול
                </button>
              </div>
            </div>
          ) : (
            <>
              <WaitMeter waitedMs={snapshot.waitedMs} />
              <button className="btn btn-quiet mp-duel-cancel" onClick={cancel}>
                <Icon name="cross" size={15} />
                ביטול
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="mp-duel-intro">
          <span className="mp-duel-intro-glyph" aria-hidden="true">
            <ModeGlyph mode="RANDOM_DUEL" />
          </span>
          <h1 className="mp-duel-intro-title">דו־קרב אקראי</h1>
          <p className="mp-duel-intro-sub">
            עשר שאלות, אותן שאלות לשניכם, אותו סדר. בלי קוד ובלי הזמנות.
          </p>

          <form className="mp-duel-form" onSubmit={begin}>
            <label className="mp-duel-label" htmlFor="mp-duel-name">
              מה השם שלכם?
            </label>
            <input
              id="mp-duel-name"
              className="input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="nickname"
              enterKeyHint="search"
              dir="auto"
            />
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!nameDraft.trim()}>
              מצא יריב
              <Icon name="target" size={18} />
            </button>
          </form>

          {snapshot.state === "CANCELLED" && <p className="tiny mp-duel-cancelled">החיפוש בוטל.</p>}

          <Link to="/multiplayer" className="btn btn-quiet btn-sm">
            חזרה לרב משתתפים
          </Link>
        </div>
      )}

      {snapshot.error && (
        <p className="mp-room-error a-pop" role="alert">
          {snapshot.error.messageHe}
        </p>
      )}
    </div>
  );
}

/**
 * How long we have been looking, as a bar that fills towards the point where the
 * player is offered alternatives.
 *
 * Deliberately not presented as progress towards finding someone — it is not, and
 * a bar that implied it would be lying. The label says what it is.
 */
function WaitMeter({ waitedMs }: { waitedMs: number }) {
  const fraction = Math.min(1, waitedMs / MATCHMAKING_TIMEOUT_MS);
  return (
    <div className="mp-duel-meter">
      <span className="bar" aria-hidden="true">
        <span className="bar-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="tiny">מחפשים {Math.round(waitedMs / 1000)} שניות</span>
    </div>
  );
}
