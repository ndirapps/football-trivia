// A multiplayer room, from the name prompt to the podium.
//
// One page for the whole arc, because it is one continuous thing: the room never
// navigates, it changes phase. `state.room.phase` is the only switch — there is no
// local "is the game running" flag anywhere here, and nothing on this screen
// decides anything about the game. The server says what phase the room is in and
// this draws it.
//
// That is also why the anti-cheat story holds on the client side: this page has
// no correct answer to hide until the reveal arrives, and no score to compute.
// The worst a tampered copy of this file can do is send a message the room
// refuses.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  LEADERBOARD_MS,
  REVEAL_MS,
  ROUND_RESULTS_MS,
  isDuelMode,
  modeMeta,
} from "../../shared/multiplayer/constants";
import { isValidRoomCode } from "../../shared/multiplayer/roomCode";
import type { RoomSettings, TeamId } from "../../shared/multiplayer/types";
import { MAX_NAME_LENGTH } from "../../shared/multiplayer/constants";
import { useRoom } from "../lib/mp/useRoom";
import { recordLocalGame, rememberPlayerName, savedPlayerName } from "../lib/mp/identity";
import { sound } from "../lib/sound";
import { Icon } from "../components/Icon";
import {
  Announcer,
  ConnectionBadge,
  PhaseClock,
  MessageBubbles,
  MessageComposer,
  ReactionBar,
  ReactionBurst,
  RoomCodePanel,
} from "../components/mp/MpAtoms";
import { Callout, KickoffSequence, RoundVerdict, VarStamp } from "../components/mp/MpStage";
import { isStreakMilestone, streakCall } from "../components/Shout";
import {
  AnswerStatus,
  DuelScoreboard,
  LiveScoreboard,
  Podium,
  RoundResults,
  StandingsTable,
  TeamScoreboard,
  TeamSheet,
  TeamWinCard,
  WinnerCard,
} from "../components/mp/MpBoards";
import { MpQuestion } from "../components/mp/MpQuestion";
import { RoomSettingsPanel } from "../components/mp/RoomSettingsPanel";
import { ReportSheet } from "../components/mp/ReportSheet";
import "./RoomPage.css";

export function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const valid = isValidRoomCode(code);
  const { state, send, join, leave, me, isHost } = useRoom(code, { enabled: valid });

  const [nameDraft, setNameDraft] = useState(() => savedPlayerName());
  const [joining, setJoining] = useState(false);
  const [flash, setFlash] = useState("");
  const [reporting, setReporting] = useState(false);
  /** What this client sent for the question in play, for the "locked in" mark. */
  const [chosen, setChosen] = useState<{ optionId: number | null; text: string | null } | null>(null);
  const recordedRef = useRef<number | null>(null);

  const room = state.room;
  const phase = room?.phase ?? "LOBBY";
  const question = state.question;
  const you = state.you;

  // A new question wipes the local echo of the last answer.
  useEffect(() => {
    setChosen(null);
  }, [question?.index]);

  // One line in the local tally per finished game. Keyed on the finish time so a
  // re-render (or a reconnect that replays GAME_FINISHED) cannot count it twice.
  useEffect(() => {
    if (!state.result || !you) return;
    if (recordedRef.current === state.result.finishedAt) return;
    recordedRef.current = state.result.finishedAt;
    const mine = state.result.standings.find((s) => s.playerId === you);
    recordLocalGame({ won: state.result.winnerIds.includes(you), bestStreak: mine?.bestStreak ?? 0 });
  }, [state.result, you]);

  const announce = useCallback((text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(""), 2500);
  }, []);

  /**
   * A matchmade duel joins itself.
   *
   * The player already typed their name to enter the queue, so putting the name
   * prompt in front of them again on arrival is asking the same question twice —
   * and worse, it does it while their opponent is waiting. A private room still
   * prompts, because there the join IS a decision: the code may have been passed
   * to a phone somebody else is holding.
   *
   * Driven off the room's own mode rather than router state, so it survives a
   * refresh in the middle of the duel too.
   */
  const autoJoined = useRef(false);
  useEffect(() => {
    if (autoJoined.current) return;
    if (you !== null || !room) return;
    if (room.settings.mode !== "RANDOM_DUEL") return;
    if (room.phase !== "LOBBY") return;
    const name = savedPlayerName().trim();
    if (!name) return;
    autoJoined.current = true;
    join(name);
  }, [you, room, join]);

  // Streak call-outs, fired on the reveal — the first moment the room is allowed
  // to know the answer was right. The same names the single-player board uses
  // (שלושער, ברצף, בלתי ניתן לעצירה), so a player hears the same language in both.
  const [callout, setCallout] = useState<{ text: string; id: number }>({ text: "", id: 0 });
  const calloutSeenRef = useRef(-1);
  const myStreak = me?.streak ?? 0;

  useEffect(() => {
    if (phase !== "ANSWER_REVEAL" || !room) return;
    if (calloutSeenRef.current === room.questionIndex) return;
    calloutSeenRef.current = room.questionIndex;
    if (!isStreakMilestone(myStreak)) return;
    const text = streakCall(myStreak);
    if (!text) return;
    sound.play("streak");
    setCallout((previous) => ({ text, id: previous.id + 1 }));
  }, [phase, room?.questionIndex, myStreak, room]);

  const answer = useCallback(
    (payload: { optionId: number | null; typed: string | null; reveal: boolean }) => {
      if (!question) return;
      setChosen({ optionId: payload.optionId, text: payload.typed });
      send({
        type: "SUBMIT_ANSWER",
        questionIndex: question.index,
        optionId: payload.optionId,
        typed: payload.typed,
        reveal: payload.reveal,
      });
    },
    [question, send]
  );

  const updateSettings = useCallback((patch: Partial<RoomSettings>) => send({ type: "UPDATE_SETTINGS", settings: patch }), [send]);

  if (!valid) return <RoomError title="קוד לא תקין" body="קוד חדר הוא שש ספרות." />;

  if (state.closedReason) {
    return <RoomError title="החדר נסגר" body={state.closedReason} />;
  }
  if (state.error?.code === "INVALID_ROOM") {
    return <RoomError title="החדר לא קיים" body="בדקו את הקוד ונסו שוב." />;
  }
  if (state.error?.code === "ROOM_EXPIRED") {
    return <RoomError title="החדר נסגר" body="אפשר לפתוח חדר חדש ולהזמין מחדש." />;
  }

  if (!room) {
    return (
      <div className="page mp-room">
        <ConnectionBadge status={state.status} stalled={state.stalled} onRetry={() => window.location.reload()} />
        <p className="mp-room-loading">מתחבר לחדר…</p>
      </div>
    );
  }

  const meta = modeMeta(room.settings.mode);
  const duel = isDuelMode(room.settings.mode);
  const teams = room.settings.mode === "TEAM_BATTLE";
  const submitted = you !== null && room.answered.includes(you);
  const myTurn = room.settings.mode !== "TURN_BASED" || room.currentTurnPlayerId === you;
  const myReveal = state.reveal?.results.find((r) => r.playerId === you) ?? null;

  // ------------------------------------------------------------- name gate

  if (!you) {
    const full = state.error?.code === "ROOM_FULL";
    const started = state.error?.code === "GAME_ALREADY_STARTED" || room.phase !== "LOBBY";

    return (
      <div className="page mp-room">
        <Announcer message={flash || state.announcement} />
        <ConnectionBadge status={state.status} stalled={state.stalled} onRetry={() => window.location.reload()} />

        <div className="mp-gate">
          {/* A random duel has no one to invite, so a code and a QR would be
              furniture nobody can use. */}
          {room.settings.mode !== "RANDOM_DUEL" && <RoomCodePanel code={room.code} compact />}

          {started || full ? (
            <div className="mp-gate-blocked">
              <p className="mp-gate-title">{full ? "החדר מלא" : "המשחק כבר התחיל"}</p>
              <p className="mp-gate-body">
                {full
                  ? `${meta.labelHe} מוגבל ל-${meta.maxPlayers} שחקנים.`
                  : "אפשר לחכות שהסיבוב ייגמר, או לפתוח חדר משלכם."}
              </p>
              <Link to="/multiplayer" className="btn btn-primary">
                לחדר חדש
              </Link>
            </div>
          ) : (
            <form
              className="mp-gate-form"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = nameDraft.trim();
                if (!trimmed) return;
                setJoining(true);
                sound.play("select");
                rememberPlayerName(trimmed);
                join(trimmed);
                window.setTimeout(() => setJoining(false), 1500);
              }}
            >
              <label className="mp-gate-label" htmlFor="mp-name">
                מה השם שלכם?
              </label>
              <input
                id="mp-name"
                className="input"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="nickname"
                enterKeyHint="go"
                dir="auto"
                autoFocus
              />
              <p className="tiny mp-gate-hint">
                {meta.labelHe} · {playerCountHe(room.players.length)} בחדר
              </p>
              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={joining || !nameDraft.trim()}>
                {joining ? "מצטרף…" : "הצטרפו"}
                {!joining && <Icon name="arrow" size={18} />}
              </button>
              {state.error && state.error.code === "INVALID_NAME" && (
                <p className="mp-room-error" role="alert">
                  {state.error.messageHe}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ room

  return (
    <div className="page mp-room" data-phase={phase}>
      <Announcer message={flash || state.announcement} />
      <ConnectionBadge status={state.status} stalled={state.stalled} onRetry={() => window.location.reload()} />
      <ReactionBurst reactions={state.reactions} />
      <MessageBubbles messages={state.messages} />
      <Callout text={callout.text} id={callout.id} />

      {phase === "LOBBY" && (
        <Lobby
          room={room}
          isHost={isHost}
          you={you}
          onStart={() => {
            sound.play("kickoff");
            send({ type: "START_GAME" });
          }}
          onSettings={updateSettings}
          onKick={(playerId) => send({ type: "KICK_PLAYER", playerId })}
          onAssign={(playerId, team) => send({ type: "SET_TEAM", playerId, team })}
          onBalance={() => send({ type: "AUTO_BALANCE" })}
          onLeave={() => {
            leave();
            navigate("/multiplayer");
          }}
          error={state.error?.messageHe ?? null}
        />
      )}

      {phase === "COUNTDOWN" && state.deadlineAt !== null && (
        <div className="mp-stage">
          <KickoffSequence
            deadlineAt={state.deadlineAt}
            duel={duel}
            names={[...room.players].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => p.name)}
          />
        </div>
      )}

      {(phase === "QUESTION" ||
        phase === "WAITING_FOR_ANSWERS" ||
        phase === "ANSWER_REVEAL" ||
        phase === "ROUND_RESULTS" ||
        phase === "NEXT_QUESTION") && (
        <>
          <header className="mp-hud">
            <span className="mp-hud-progress tiny">
              שאלה <b className="num">{(question?.index ?? room.questionIndex) + 1}</b> מתוך{" "}
              <b className="num">{question?.total ?? room.questionTotal}</b>
            </span>

            {room.settings.mode === "TURN_BASED" && room.currentTurnPlayerId && (
              <span className={`mp-turn ${room.currentTurnPlayerId === you ? "is-you" : ""}`}>
                <Icon name="whistle" size={15} />
                {room.currentTurnPlayerId === you
                  ? "התור שלכם"
                  : `התור של ${room.players.find((p) => p.id === room.currentTurnPlayerId)?.name ?? ""}`}
              </span>
            )}

            {(phase === "QUESTION" || phase === "WAITING_FOR_ANSWERS") && (
              <PhaseClock
                deadlineAt={state.deadlineAt}
                totalMs={room.settings.secondsPerQuestion * 1000}
                label="זמן לשאלה"
                onWarning={() => announce("נשארו 5 שניות")}
              />
            )}
            {phase === "ANSWER_REVEAL" && (
              <PhaseClock deadlineAt={state.deadlineAt} totalMs={REVEAL_MS} label="עד השאלה הבאה" />
            )}
            {phase === "ROUND_RESULTS" && (
              <PhaseClock deadlineAt={state.deadlineAt} totalMs={ROUND_RESULTS_MS} label="עד השאלה הבאה" />
            )}
          </header>

          {duel ? (
            <DuelScoreboard players={room.players} youId={you} roundWinnerIds={state.roundWinnerIds} />
          ) : teams && room.teamScores ? (
            <TeamScoreboard
              players={room.players}
              scores={room.teamScores}
              names={room.settings.teamNames}
              youId={you}
            />
          ) : (
            <LiveScoreboard players={room.players} youId={you} roundWinnerIds={state.roundWinnerIds} />
          )}

          {state.roundHeadline && phase === "ROUND_RESULTS" && (
            <RoundVerdict
              headline={state.roundHeadline}
              tone={
                state.roundWinnerIds.length === 0
                  ? "none"
                  : you && state.roundWinnerIds.includes(you)
                    ? state.roundWinnerIds.length > 1
                      ? "draw"
                      : "won"
                    : "lost"
              }
            />
          )}

          {/* The VAR beat: only for a typed answer that passed on tolerance, and
              only inside the reveal window the server already allotted. */}
          {phase === "ANSWER_REVEAL" && myReveal?.matchKind && (myReveal.matchKind === "fuzzy" || myReveal.matchKind === "token") && (
            <VarStamp approved={myReveal.correct} />
          )}

          {question && (
            <MpQuestion
              question={question}
              reveal={state.reveal}
              submitted={submitted}
              chosenOptionId={chosen?.optionId ?? null}
              chosenText={chosen?.text ?? null}
              canAnswer={myTurn}
              hints={state.hints}
              onAnswer={answer}
              onHint={() => send({ type: "REQUEST_HINT", questionIndex: question.index })}
            />
          )}

          {(phase === "QUESTION" || phase === "WAITING_FOR_ANSWERS") && (
            <AnswerStatus
              players={room.players}
              answeredIds={room.answered}
              turnPlayerId={room.settings.mode === "TURN_BASED" ? room.currentTurnPlayerId : null}
            />
          )}

          {/* Kept through the round-result beat as well as the reveal: the
              per-player breakdown is the thing people actually lean in to read,
              and having it vanish the moment the verdict appears means half the
              room never gets to it. */}
          {(phase === "ANSWER_REVEAL" || phase === "ROUND_RESULTS") && state.reveal && (
            <RoundResults reveal={state.reveal} players={room.players} youId={you} />
          )}

          {/* Reactions and trash talk sit together: both are social, neither
              affects the game. */}
          <div className="mp-social">
            <ReactionBar onSend={(emoji) => send({ type: "SEND_REACTION", emoji })} />
            <MessageComposer
              // Not while you still have to answer: the panel opens over the options.
              disabled={phase === "QUESTION" && myTurn && !submitted}
              onSend={({ presetId, text }) =>
                send({ type: "SEND_MESSAGE", presetId: presetId ?? null, text: text ?? null })
              }
            />
          </div>
        </>
      )}

      {phase === "LEADERBOARD" && state.standings && (
        <div className="mp-stage">
          <p className="mp-stage-label tiny">הטבלה</p>
          <StandingsTable standings={state.standings} youId={you} />
          <PhaseClock deadlineAt={state.deadlineAt} totalMs={LEADERBOARD_MS} label="עד הסיכום" />
        </div>
      )}

      {(phase === "FINISHED" || phase === "REMATCH_WAITING") && state.result && (
        <Finish
          result={state.result}
          youId={you}
          isHost={isHost}
          duel={duel}
          rematch={room.rematch}
          onRematch={() => {
            sound.play("select");
            send({ type: "REQUEST_REMATCH" });
          }}
          onLeave={() => {
            leave();
            navigate("/multiplayer");
          }}
          onNewOpponent={() => {
            leave();
            navigate("/multiplayer/duel");
          }}
        />
      )}

      {/* The countdown for a random duel's rematch has no host to trigger it; the
          room starts itself, so this is only a holding message. */}
      {phase === "LOBBY" && room.played && room.settings.mode === "RANDOM_DUEL" && (
        <p className="mp-room-wait" role="status">
          מתחילים סיבוב חדש…
        </p>
      )}

      {state.error && state.error.code !== "RATE_LIMITED" && (
        <p className="mp-room-error a-pop" role="alert">
          {state.error.messageHe}
        </p>
      )}

      {/* Report and block (App Store guideline 1.2): always reachable while
          anyone else is in the room, in every phase. */}
      {room.players.some((p) => p.id !== you) && (
        <button type="button" className="btn btn-quiet mp-report-open" onClick={() => setReporting(true)}>
          <Icon name="shield" size={16} />
          דיווח או חסימת שחקן
        </button>
      )}

      {reporting && (
        <ReportSheet
          players={room.players.filter((p) => p.id !== you)}
          roomCode={room.code}
          onClose={() => setReporting(false)}
          onLeave={() => {
            setReporting(false);
            leave();
            navigate("/multiplayer");
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- lobby

function Lobby({
  room,
  isHost,
  you,
  onStart,
  onSettings,
  onKick,
  onAssign,
  onBalance,
  onLeave,
  error,
}: {
  room: NonNullable<ReturnType<typeof useRoom>["state"]["room"]>;
  isHost: boolean;
  you: string;
  onStart: () => void;
  onSettings: (patch: Partial<RoomSettings>) => void;
  onKick: (playerId: string) => void;
  onAssign: (playerId: string, team: TeamId) => void;
  onBalance: () => void;
  onLeave: () => void;
  error: string | null;
}) {
  const meta = modeMeta(room.settings.mode);
  const connected = room.players.filter((p) => p.connected).length;
  const canStart = connected >= meta.minPlayers && connected <= meta.maxPlayers;
  const teams = room.settings.mode === "TEAM_BATTLE";
  const matchmade = room.settings.mode === "RANDOM_DUEL";

  return (
    <div className="mp-lobby">
      {!matchmade && <RoomCodePanel code={room.code} />}

      <section className="mp-lobby-sheet" aria-labelledby="mp-sheet-head">
        <header className="mp-lobby-sheet-head">
          <h2 id="mp-sheet-head" className="mp-lobby-h2">
            ההרכב
          </h2>
          <span className="tag">{playerCountHe(room.players.length)}</span>
        </header>

        <TeamSheet
          players={room.players}
          youId={you}
          teams={teams}
          teamNames={room.settings.teamNames}
          onKick={isHost ? onKick : undefined}
          onAssign={isHost && teams ? onAssign : undefined}
        />

        {isHost && teams && (
          <button type="button" className="btn btn-ghost btn-sm mp-lobby-balance" onClick={onBalance}>
            <Icon name="sliders" size={15} />
            אזן קבוצות
          </button>
        )}
      </section>

      {isHost && !matchmade ? (
        <section className="mp-lobby-config" aria-labelledby="mp-config-head">
          <h2 id="mp-config-head" className="mp-lobby-h2">
            הגדרות
          </h2>
          <RoomSettingsPanel settings={room.settings} playerCount={connected} onChange={onSettings} />
        </section>
      ) : (
        <section className="mp-lobby-config" aria-labelledby="mp-waiting-head">
          <h2 id="mp-waiting-head" className="mp-lobby-h2">
            {matchmade ? "דו־קרב אקראי" : "מחכים למארח"}
          </h2>
          <ul className="mp-lobby-facts">
            <li>
              <span className="tiny">סוג</span>
              <b>{meta.labelHe}</b>
            </li>
            <li>
              <span className="tiny">שאלות</span>
              <b className="num">{room.settings.questionCount}</b>
            </li>
            <li>
              <span className="tiny">זמן לשאלה</span>
              <b className="num">{room.settings.secondsPerQuestion}s</b>
            </li>
            <li>
              <span className="tiny">מענה</span>
              <b>{room.settings.answerMode === "FREE_TEXT" ? "תשובה חופשית" : "אמריקאי"}</b>
            </li>
          </ul>
        </section>
      )}

      <div className={`mp-lobby-actions ${isHost && !matchmade ? "is-sticky" : ""}`}>
        {isHost && !matchmade && (
          <button className="btn btn-primary btn-lg btn-block" onClick={onStart} disabled={!canStart}>
            {canStart ? "התחילו משחק" : `צריך ${meta.minPlayers} שחקנים`}
            {canStart && <Icon name="arrow" size={18} />}
          </button>
        )}
        {!isHost && !matchmade && (
          <p className="mp-lobby-wait" role="status">
            <span className="mp-lobby-pulse" aria-hidden="true" />
            מחכים שהמארח יתחיל…
          </p>
        )}
        {matchmade && (
          <p className="mp-lobby-wait" role="status">
            <span className="mp-lobby-pulse" aria-hidden="true" />
            {room.players.length < 2 ? "מחכים ליריב…" : "מתחילים…"}
          </p>
        )}
        <button className="btn btn-quiet btn-sm" onClick={onLeave}>
          יציאה מהחדר
        </button>
      </div>

      {error && (
        <p className="mp-room-error a-pop" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ finish

function Finish({
  result,
  youId,
  isHost,
  duel,
  rematch,
  onRematch,
  onLeave,
  onNewOpponent,
}: {
  result: NonNullable<ReturnType<typeof useRoom>["state"]["result"]>;
  youId: string;
  isHost: boolean;
  duel: boolean;
  rematch: { requested: string[]; needed: number } | null;
  onRematch: () => void;
  onLeave: () => void;
  onNewOpponent: () => void;
}) {
  const waiting = !!rematch && rematch.requested.includes(youId) && rematch.requested.length < rematch.needed;
  const podium = !duel && !result.teamResult && result.standings.length >= 3;

  return (
    <div className="mp-finish">
      {result.teamResult ? (
        <TeamWinCard result={result.teamResult} standings={result.standings} />
      ) : duel || result.standings.length < 3 ? (
        <WinnerCard
          standings={result.standings}
          winnerIds={result.winnerIds}
          forfeited={result.forfeitedBy !== null}
        />
      ) : null}

      {podium && <Podium standings={result.standings} />}

      <section className="mp-finish-table" aria-labelledby="mp-final-head">
        <h2 id="mp-final-head" className="mp-lobby-h2">
          טבלה מלאה
        </h2>
        <StandingsTable standings={result.standings} youId={youId} />
      </section>

      <div className="mp-finish-actions">
        {waiting ? (
          <p className="mp-lobby-wait" role="status">
            <span className="mp-lobby-pulse" aria-hidden="true" />
            מחכים לאישור של היריב…
          </p>
        ) : (
          (duel || isHost) && (
            <button className="btn btn-primary btn-lg" onClick={onRematch}>
              <Icon name="replay" size={17} />
              משחק חוזר
            </button>
          )
        )}

        {duel && (
          <button className="btn btn-ghost" onClick={onNewOpponent}>
            <Icon name="target" size={16} />
            חפשו יריב חדש
          </button>
        )}

        <button className="btn btn-quiet btn-sm" onClick={onLeave}>
          יציאה
        </button>
      </div>

      {rematch && rematch.needed > 1 && !duel && !isHost && (
        <p className="tiny mp-finish-note">רק המארח יכול להתחיל משחק נוסף.</p>
      )}
    </div>
  );
}

/**
 * Hebrew does not pluralise the way a naive `${n} שחקנים` assumes: one player is
 * "שחקן אחד" and two is "שני שחקנים", not "1 שחקנים" and "2 שחקנים". Getting this
 * wrong is the sort of thing that makes a product read as translated.
 */
export function playerCountHe(count: number): string {
  if (count === 0) return "אין שחקנים";
  if (count === 1) return "שחקן אחד";
  if (count === 2) return "שני שחקנים";
  return `${count} שחקנים`;
}

function RoomError({ title, body }: { title: string; body: string }) {
  return (
    <div className="page mp-room">
      <div className="mp-error-state">
        <span className="mp-error-mark" aria-hidden="true">
          <Icon name="whistle" size={30} />
        </span>
        <h1 className="mp-error-title">{title}</h1>
        <p className="mp-error-body">{body}</p>
        <div className="mp-error-actions">
          <Link to="/multiplayer" className="btn btn-primary">
            לרב משתתפים
          </Link>
          <Link to="/" className="btn btn-ghost">
            לעמוד הבית
          </Link>
        </div>
      </div>
    </div>
  );
}
