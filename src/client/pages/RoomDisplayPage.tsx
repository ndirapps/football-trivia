// The shared screen: /room/:code/display
//
// A TV or a laptop in the middle of the room, with the phones as controllers.
// It joins the same Durable Object over the same protocol, but connects with
// `display=1`, which makes the server treat it as a spectator: it is broadcast to
// and may never act. There is no "display mode" in the room's state machine at
// all — the room does not know or care that one of its sockets is a television.
//
// Everything is scaled up and thinned out: the QR and the code while people are
// joining, the question and the clock while they answer, the standings between
// rounds, the podium at the end. Nothing here is interactive, so nothing here
// needs to be reachable by keyboard.

import { useParams } from "react-router-dom";
import { isValidRoomCode } from "../../shared/multiplayer/roomCode";
import { isDuelMode, modeMeta } from "../../shared/multiplayer/constants";
import { roomJoinUrl } from "../../shared/multiplayer/roomCode";
import { publicOrigin } from "../lib/origin";
import { useRoom } from "../lib/mp/useRoom";
import { Announcer, PhaseClock, QrCode } from "../components/mp/MpAtoms";
import { Countdown, DuelIntro } from "../components/mp/MpStage";
import {
  AnswerStatus,
  DuelScoreboard,
  LiveScoreboard,
  Podium,
  StandingsTable,
  TeamScoreboard,
  TeamSheet,
  TeamWinCard,
  WinnerCard,
} from "../components/mp/MpBoards";
import { formatRoomCode } from "../../shared/multiplayer/roomCode";
import { playerCountHe } from "./RoomPage";
import "./RoomDisplayPage.css";

export function RoomDisplayPage() {
  const { code } = useParams<{ code: string }>();
  const valid = isValidRoomCode(code);
  const { state } = useRoom(code, { display: true, enabled: valid });
  const room = state.room;

  if (!valid) {
    return (
      <div className="mp-display is-message">
        <p>קוד חדר לא תקין</p>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="mp-display is-message">
        <p>{state.closedReason ?? "מתחבר לחדר…"}</p>
      </div>
    );
  }

  const url = typeof window === "undefined" ? "" : roomJoinUrl(publicOrigin(), room.code);
  const duel = isDuelMode(room.settings.mode);
  const teams = room.settings.mode === "TEAM_BATTLE";

  return (
    <div className="mp-display" data-phase={room.phase}>
      <Announcer message={state.announcement} />

      <header className="mp-display-top">
        <span className="mp-display-brand">
          Football <b className="green">IQ</b>
        </span>
        <span className="mp-display-mode">{modeMeta(room.settings.mode).labelHe}</span>
        {room.questionIndex >= 0 && room.phase !== "FINISHED" && (
          // `dir="ltr"` because "3 / 10" is a fraction, not a sentence: left to
          // itself in an RTL container the bidi algorithm reorders it to "10 / 3",
          // which reads as the wrong question number.
          <span className="mp-display-progress num" dir="ltr">
            {room.questionIndex + 1} / {room.questionTotal}
          </span>
        )}
      </header>

      {room.phase === "LOBBY" && (
        <div className="mp-display-lobby">
          <div className="mp-display-join">
            <p className="mp-display-kicker">הצטרפו עכשיו</p>
            <p className="mp-display-code num">{formatRoomCode(room.code)}</p>
            <QrCode url={url} code={room.code} size={260} />
            <p className="mp-display-scan">סרקו כדי להצטרף</p>
          </div>
          <div className="mp-display-sheet">
            <p className="mp-display-kicker">ההרכב · {playerCountHe(room.players.length)}</p>
            <TeamSheet players={room.players} youId={null} teams={teams} teamNames={room.settings.teamNames} />
          </div>
        </div>
      )}

      {room.phase === "COUNTDOWN" && state.deadlineAt !== null && (
        <div className="mp-display-stage">
          {duel ? (
            <DuelIntro
              left={[...room.players].sort((a, b) => a.joinedAt - b.joinedAt)[0]?.name ?? ""}
              right={[...room.players].sort((a, b) => a.joinedAt - b.joinedAt)[1]?.name ?? ""}
            />
          ) : (
            <Countdown deadlineAt={state.deadlineAt} />
          )}
        </div>
      )}

      {(room.phase === "QUESTION" ||
        room.phase === "WAITING_FOR_ANSWERS" ||
        room.phase === "ANSWER_REVEAL" ||
        room.phase === "ROUND_RESULTS" ||
        room.phase === "NEXT_QUESTION") &&
        state.question && (
          <div className="mp-display-play">
            <div className="mp-display-question">
              {room.settings.mode === "TURN_BASED" && room.currentTurnPlayerId && (
                <p className="mp-display-turn">
                  התור של {room.players.find((p) => p.id === room.currentTurnPlayerId)?.name ?? ""}
                </p>
              )}
              <h1 className="mp-display-q">{state.question.questionHe}</h1>

              {state.question.options.length > 0 && (
                <ol className="mp-display-options">
                  {state.question.options.map((option) => (
                    <li
                      key={option.id}
                      className={
                        state.reveal && state.reveal.correctOptionId === option.id ? "is-correct" : ""
                      }
                    >
                      {option.text}
                    </li>
                  ))}
                </ol>
              )}

              {state.reveal && (
                <p className="mp-display-answer">
                  התשובה: <b>{state.reveal.correctAnswer}</b>
                </p>
              )}
              {room.phase === "ROUND_RESULTS" && state.roundHeadline && (
                <p className="mp-display-verdict">{state.roundHeadline}</p>
              )}
            </div>

            <aside className="mp-display-side">
              {(room.phase === "QUESTION" || room.phase === "WAITING_FOR_ANSWERS") && (
                <>
                  <PhaseClock
                    deadlineAt={state.deadlineAt}
                    totalMs={room.settings.secondsPerQuestion * 1000}
                    label="זמן לשאלה"
                  />
                  <AnswerStatus
                    players={room.players}
                    answeredIds={room.answered}
                    turnPlayerId={room.settings.mode === "TURN_BASED" ? room.currentTurnPlayerId : null}
                  />
                </>
              )}

              {duel ? (
                <DuelScoreboard players={room.players} youId={null} roundWinnerIds={state.roundWinnerIds} />
              ) : teams && room.teamScores ? (
                <TeamScoreboard
                  players={room.players}
                  scores={room.teamScores}
                  names={room.settings.teamNames}
                  youId={null}
                />
              ) : (
                <LiveScoreboard players={room.players} youId={null} roundWinnerIds={state.roundWinnerIds} />
              )}
            </aside>
          </div>
        )}

      {room.phase === "LEADERBOARD" && state.standings && (
        <div className="mp-display-stage">
          <StandingsTable standings={state.standings} youId={null} />
        </div>
      )}

      {(room.phase === "FINISHED" || room.phase === "REMATCH_WAITING") && state.result && (
        <div className="mp-display-stage">
          {state.result.teamResult ? (
            <TeamWinCard result={state.result.teamResult} standings={state.result.standings} />
          ) : state.result.standings.length >= 3 ? (
            <Podium standings={state.result.standings} />
          ) : (
            <WinnerCard
              standings={state.result.standings}
              winnerIds={state.result.winnerIds}
              forfeited={state.result.forfeitedBy !== null}
            />
          )}
          <StandingsTable standings={state.result.standings} youId={null} />
        </div>
      )}
    </div>
  );
}
