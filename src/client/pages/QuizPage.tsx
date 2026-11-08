import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DIFFICULTY_LABELS } from "../../shared/constants";
import { computeScore } from "../../shared/scoring";
import type { AnswerRecord } from "../../shared/types";
import { submitAttempt } from "../lib/api";
import { clearActiveQuiz, loadActiveQuiz, saveResult } from "../lib/quizSession";
import { rememberQuestionIds } from "../lib/recentQuestions";
import { sound } from "../lib/sound";
import { FreeTextAnswer, type FreeTextResult } from "../components/FreeTextAnswer";
import { Hud } from "../components/Hud";
import { Kickoff } from "../components/Kickoff";
import { Icon } from "../components/Icon";
import {
  FAST_ANSWER_MS,
  Shout,
  isStreakMilestone,
  streakCall,
  type ShoutMessage,
} from "../components/Shout";
import "./QuizPage.css";
import { isolateLatin } from "../lib/bidi";
import { saveDailyRecord } from "../lib/dailyRecord";

// Four transition styles, rotated so consecutive questions never repeat one.
const TRANSITIONS = ["q-roll", "q-flip", "q-draw", "q-card"] as const;

const OPTION_KEYS = ["א", "ב", "ג", "ד", "ה", "ו"];

export function QuizPage() {
  const navigate = useNavigate();
  const session = useMemo(() => loadActiveQuiz(), []);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<number | null>(null);
  const [freeTextResult, setFreeTextResult] = useState<FreeTextResult | null>(null);
  const [questionStartedAt, setQuestionStartedAt] = useState(Date.now());
  const [finishing, setFinishing] = useState(false);
  const [shout, setShout] = useState<ShoutMessage | null>(null);
  const [scoreBumped, setScoreBumped] = useState(false);
  const [kickoffDone, setKickoffDone] = useState(false);
  const shoutId = useRef(0);

  const playable = !!session?.quiz?.questions?.length;

  useEffect(() => {
    if (!playable) navigate("/build", { replace: true });
  }, [playable, navigate]);

  useEffect(() => {
    setQuestionStartedAt(Date.now());
  }, [index]);

  useEffect(() => {
    if (session) rememberQuestionIds(session.quiz.questions.map((q) => q.id));
  }, [session]);

  // The opening whistle fires once the board is actually on screen.
  useEffect(() => {
    if (playable) sound.play("kickoff");
  }, [playable]);

  const question = playable ? session!.quiz.questions[index] : null;
  const isFreeText =
    !!question && session!.quiz.configuration.answerMode === "FREE_TEXT" && question.supportsFreeText;
  const answered = isFreeText ? freeTextResult !== null : selectedOptionId !== null;

  // Number keys pick an answer — faster for everyone, and a genuine
  // alternative for anyone who cannot use a pointer comfortably.
  useEffect(() => {
    if (!question || answered || isFreeText) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const position = Number(event.key);
      if (!Number.isInteger(position) || position < 1 || position > question.options.length) return;
      const option = question.options[position - 1];
      if (option) handleSelect(option.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleSelect is hoisted and always reads the current question.
  }, [question, answered, isFreeText]);

  if (!session || !playable || !question) return null;
  const activeSession = session;
  const { quiz } = activeSession;
  const total = quiz.questions.length;
  const isLast = index === total - 1;
  const liveScore = computeScore(answers);

  let currentStreak = 0;
  for (let i = answers.length - 1; i >= 0; i--) {
    if (answers[i].correct) currentStreak++;
    else break;
  }

  function callOut(text: string, tone: ShoutMessage["tone"]) {
    shoutId.current += 1;
    setShout({ id: shoutId.current, text, tone });
  }

  function registerAnswer(record: AnswerRecord) {
    const next = [...answers, record];
    setAnswers(next);

    let streak = 0;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].correct) streak++;
      else break;
    }

    if (record.correct) {
      setScoreBumped(true);
      window.setTimeout(() => setScoreBumped(false), 450);

      // One call-out at a time, most significant first: a streak name beats
      // "fast", which beats a plain goal.
      const milestone = isStreakMilestone(streak) ? streakCall(streak) : null;
      if (milestone) {
        sound.play("streak");
        callOut(milestone, "streak");
      } else if ((record.timeMs ?? Infinity) < FAST_ANSWER_MS) {
        callOut("מהיר!", "fast");
      } else {
        callOut("GOAL!", "goal");
      }
    }
  }

  function handleSelect(optionId: number) {
    if (selectedOptionId !== null) return;
    setSelectedOptionId(optionId);
    const opt = question!.options.find((o) => o.id === optionId);
    const correct = !!opt?.isCorrect;
    sound.play(correct ? "correct" : "wrong");
    registerAnswer({
      questionId: question!.id,
      selectedOptionId: optionId,
      correct,
      timeMs: Date.now() - questionStartedAt,
    });
  }

  function handleFreeText(result: FreeTextResult) {
    setFreeTextResult(result);
    registerAnswer({
      questionId: question!.id,
      selectedOptionId: null,
      typedAnswer: result.typed,
      correct: result.correct,
      revealed: result.revealed,
      hintsUsed: result.hintsUsed,
      timeMs: Date.now() - questionStartedAt,
    });
  }

  async function handleNext() {
    if (!isLast) {
      sound.play("next");
      setIndex((i) => i + 1);
      setSelectedOptionId(null);
      setFreeTextResult(null);
      return;
    }
    setFinishing(true);
    sound.play("complete");
    const durationSeconds = Math.round((Date.now() - activeSession.startedAt) / 1000);
    const finalScore = computeScore(answers);
    try {
      await submitAttempt({ answers, durationSeconds, challengePublicId: activeSession.challengePublicId });
    } catch {
      // Non-fatal — the player still sees their results even if logging fails.
    }
    if (activeSession.isDaily && activeSession.dailyDate) {
      saveDailyRecord({
        date: activeSession.dailyDate,
        correct: finalScore.correct,
        total: finalScore.total,
        points: finalScore.points,
      });
    }
    saveResult({
      quiz,
      answers,
      score: finalScore,
      durationSeconds,
      challengePublicId: activeSession.challengePublicId,
    });
    clearActiveQuiz();
    navigate("/results");
  }

  const clueMode = question.mode === "WHO_AM_I" || question.mode === "CAREER_PATH";
  const transition = TRANSITIONS[index % TRANSITIONS.length];
  const chosen = question.options.find((o) => o.id === selectedOptionId);

  const verdict = !answered
    ? ""
    : isFreeText
      ? freeTextResult!.correct
        ? "נכון."
        : `לא נכון. התשובה היא ${question.canonicalAnswer}.`
      : chosen?.isCorrect
        ? "נכון."
        : `לא נכון. התשובה היא ${question.options.find((o) => o.isCorrect)?.text}.`;

  return (
    <div className="page quiz">
      {!kickoffDone && <Kickoff onDone={() => setKickoffDone(true)} />}
      <Shout message={shout} />

      <Hud
        index={index}
        total={total}
        points={liveScore.points}
        streak={currentStreak}
        difficultyLabel={DIFFICULTY_LABELS[question.difficulty]}
        modeLabel={isFreeText ? "תשובה חופשית" : "אמריקאי"}
        scoreBumped={scoreBumped}
      />

      <article key={question.id} className={`sheet ${transition}`}>
        {clueMode && question.clues.length > 0 && (
          <ol className={`clues ${question.mode === "CAREER_PATH" ? "clues-path" : ""}`}>
            {question.clues
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((clue, i) => (
                <li key={i} className="clue" style={{ "--i": i } as React.CSSProperties}>
                  <span className="clue-dot" aria-hidden="true" />
                  <span>{isolateLatin(clue.text)}</span>
                </li>
              ))}
          </ol>
        )}

        <h1 className="q" id="q">
          {isolateLatin(question.questionHe)}
        </h1>

        {isFreeText ? (
          <FreeTextAnswer question={question} onResolved={handleFreeText} resolved={freeTextResult} />
        ) : (
          <div className="options" role="group" aria-labelledby="q">
            {question.options.map((opt, i) => {
              const state = !answered
                ? ""
                : opt.isCorrect
                  ? "is-correct"
                  : opt.id === selectedOptionId
                    ? "is-wrong"
                    : "is-out";
              const beat =
                answered && opt.isCorrect
                  ? "a-correct"
                  : answered && opt.id === selectedOptionId
                    ? "a-wrong"
                    : "";
              return (
                <button
                  key={opt.id}
                  className={`opt ${state} ${beat}`}
                  onClick={() => handleSelect(opt.id)}
                  disabled={answered}
                >
                  <span className="opt-key" aria-hidden="true">
                    {OPTION_KEYS[i] ?? i + 1}
                  </span>
                  <span className="opt-text">{isolateLatin(opt.text)}</span>
                  {answered && (opt.isCorrect || opt.id === selectedOptionId) && (
                    <span className="opt-mark" aria-hidden="true">
                      <Icon name={opt.isCorrect ? "check" : "cross"} size={17} strokeWidth={2.6} />
                    </span>
                  )}
                  {/* The net taking the ball — rings leaving the struck option. */}
                  {answered && opt.isCorrect && <span className="net" aria-hidden="true" />}
                  {answered && opt.isCorrect && <span className="sr-only">— התשובה הנכונה</span>}
                  {answered && !opt.isCorrect && opt.id === selectedOptionId && (
                    <span className="sr-only">— הבחירה שלכם, שגויה</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <p className="sr-only" role="status" aria-live="polite">
          {answered ? `${verdict} ${question.explanationHe ?? ""}` : ""}
        </p>

        {answered && question.explanationHe && (
          <p className="why a-fade-up">{isolateLatin(question.explanationHe)}</p>
        )}
      </article>

      {answered && (
        <div className="quiz-next a-fade-up">
          <button className="btn btn-primary btn-block btn-lg" onClick={handleNext} disabled={finishing} autoFocus>
            {finishing ? "מסכם…" : isLast ? "לתוצאות" : "הבא"}
            {!finishing && <Icon name="arrow" size={18} />}
          </button>
        </div>
      )}

      {!answered && !isFreeText && (
        <p className="quiz-tip">אפשר גם במקשים 1–{question.options.length}</p>
      )}
    </div>
  );
}
