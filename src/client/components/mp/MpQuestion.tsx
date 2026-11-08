// The question board for a multiplayer round.
//
// The single-player board answers immediately and shows you whether you were
// right. This one cannot: in a room, correctness is withheld until the round
// closes, so the board has three states rather than two —
//
//   open        you may answer
//   submitted   you have answered, and you are told NOTHING about it yet
//   revealed    the round closed and the correct answer is on screen
//
// Getting "submitted" right is the whole job. The chosen option is marked as
// chosen, never as right or wrong, and no colour that means correctness appears
// until the reveal arrives from the server.

import { useEffect, useRef, useState } from "react";
import type { LiveQuestion, RoundReveal } from "../../../shared/multiplayer/types";
import { sound } from "../../lib/sound";
import { Icon } from "../Icon";
// The multiplayer board deliberately wears the single-player board's clothes:
// `.sheet`, `.q`, `.options`, `.opt`, `.clues` and the free-text form are the
// same components a player already knows. Importing the stylesheets here rather
// than relying on some other route having loaded them keeps that dependency
// explicit — this file would otherwise render unstyled if the quiz page were
// ever code-split away.
import "../../pages/QuizPage.css";
import "../FreeTextAnswer.css";
import "./mp.css";
import { isolateLatin, hintText } from "../../lib/bidi";

const OPTION_KEYS = ["א", "ב", "ג", "ד", "ה", "ו"];

export interface MpQuestionProps {
  question: LiveQuestion;
  /** The round has closed; show the answer. */
  reveal: RoundReveal | null;
  /** This client has locked an answer in. */
  submitted: boolean;
  /** The option this client chose, for the "chosen" mark. */
  chosenOptionId: number | null;
  chosenText: string | null;
  /** False when this client is watching (not their turn, or a display screen). */
  canAnswer: boolean;
  hints: string[];
  onAnswer: (payload: { optionId: number | null; typed: string | null; reveal: boolean }) => void;
  onHint: () => void;
}

export function MpQuestion(props: MpQuestionProps) {
  const { question, reveal, submitted, chosenOptionId, canAnswer, hints, onAnswer, onHint } = props;
  const freeText = question.answerMode === "FREE_TEXT";
  const locked = submitted || reveal !== null || !canAnswer;

  // Number keys, exactly as in the single-player board — the same muscle memory,
  // and a real alternative for anyone who cannot use a pointer comfortably.
  useEffect(() => {
    if (locked || freeText) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const position = Number(event.key);
      if (!Number.isInteger(position) || position < 1 || position > question.options.length) return;
      const option = question.options[position - 1];
      if (option) {
        sound.play("select");
        onAnswer({ optionId: option.id, typed: null, reveal: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, freeText, question.options, onAnswer]);

  return (
    <article className="mp-q sheet">
      {question.clues.length > 0 && (
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

      <h2 className="q" id="mp-q">
        {isolateLatin(question.questionHe)}
      </h2>

      {hints.length > 0 && (
        <ol className="ft-hints">
          {hints.map((hint, i) => (
            <li key={i} className="ft-hint a-fade-up">
              <Icon name="bulb" size={14} />
              <span>{isolateLatin(hintText(hint))}</span>
            </li>
          ))}
        </ol>
      )}

      {freeText ? (
        <FreeTextRound {...props} locked={locked} />
      ) : (
        <div className="options" role="group" aria-labelledby="mp-q">
          {question.options.map((option, i) => {
            const isChosen = option.id === chosenOptionId;
            const isCorrect = reveal !== null && reveal.correctOptionId === option.id;
            // Before the reveal a chosen option is only "chosen". `is-correct`
            // and `is-wrong` are never applied while the round is open.
            const state = reveal
              ? isCorrect
                ? "is-correct"
                : isChosen
                  ? "is-wrong"
                  : "is-out"
              : isChosen
                ? "is-chosen"
                : "";
            return (
              <button
                key={option.id}
                className={`opt ${state}`}
                disabled={locked}
                onClick={() => {
                  sound.play("select");
                  onAnswer({ optionId: option.id, typed: null, reveal: false });
                }}
              >
                <span className="opt-key" aria-hidden="true">
                  {OPTION_KEYS[i] ?? i + 1}
                </span>
                <span className="opt-text">{isolateLatin(option.text)}</span>
                {isChosen && !reveal && (
                  <>
                    <span className="opt-mark" aria-hidden="true">
                      <Icon name="lock" size={15} strokeWidth={2.2} />
                    </span>
                    <span className="sr-only"> — הבחירה שלכם, ננעלה</span>
                  </>
                )}
                {reveal && (isCorrect || isChosen) && (
                  <span className="opt-mark" aria-hidden="true">
                    <Icon name={isCorrect ? "check" : "cross"} size={16} strokeWidth={2.6} />
                  </span>
                )}
                {reveal && isCorrect && <span className="sr-only"> — התשובה הנכונה</span>}
              </button>
            );
          })}
        </div>
      )}

      {!locked && question.hintCount > hints.length && (
        <div className="mp-q-actions">
          <button type="button" className="btn btn-quiet btn-sm" onClick={onHint}>
            <Icon name="bulb" size={15} />
            רמז ({question.hintCount - hints.length}) — עולה נקודות
          </button>
        </div>
      )}

      {submitted && !reveal && (
        <p className="mp-q-locked" role="status">
          <Icon name="lock" size={15} />
          התשובה ננעלה. מחכים לשאר.
        </p>
      )}

      {!canAnswer && !submitted && !reveal && (
        <p className="mp-q-watching" role="status">
          <Icon name="eye" size={15} />
          אתם צופים בסיבוב הזה.
        </p>
      )}

      {reveal && (
        <div className="mp-q-answer a-fade-up">
          <p className="mp-q-answer-line">
            התשובה: <b><bdi>{reveal.correctAnswer}</bdi></b>
          </p>
          {reveal.explanationHe && <p className="why">{isolateLatin(reveal.explanationHe)}</p>}
        </div>
      )}
    </article>
  );
}

/** The typed-answer half: an input, a hint, and a give-up that costs the round. */
function FreeTextRound({
  locked,
  chosenText,
  reveal,
  onAnswer,
}: MpQuestionProps & { locked: boolean }) {
  const [value, setValue] = useState("");
  const [confirmingReveal, setConfirmingReveal] = useState(false);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue("");
    setConfirmingReveal(false);
    if (!locked && !window.matchMedia?.("(pointer: coarse)").matches) inputRef.current?.focus();
  }, [locked]);

  if (locked) {
    return chosenText ? (
      <p className="mp-ft-sent">
        שלחתם: <b dir="auto">{chosenText}</b>
      </p>
    ) : reveal ? null : (
      <p className="mp-ft-sent faint">לא נשלחה תשובה.</p>
    );
  }

  function submit() {
    const typed = value.trim();
    if (!typed) {
      setShake(true);
      window.setTimeout(() => setShake(false), 400);
      inputRef.current?.focus();
      return;
    }
    sound.play("select");
    onAnswer({ optionId: null, typed, reveal: false });
  }

  return (
    <div className="ft">
      <form
        className={`ft-form ${shake ? "a-wrong" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="sr-only" htmlFor="mp-ft-input">
          הקלידו את התשובה
        </label>
        <input
          id="mp-ft-input"
          ref={inputRef}
          className="input"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="שם השחקן, המועדון או הנבחרת…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          dir="auto"
        />
        <button className="btn btn-primary" type="submit">
          שליחה
        </button>
      </form>

      <div className="ft-actions">
        <button
          type="button"
          className={`btn btn-sm ${confirmingReveal ? "btn-amber" : "btn-quiet"}`}
          onClick={() => {
            if (!confirmingReveal) {
              setConfirmingReveal(true);
              return;
            }
            sound.play("reveal");
            onAnswer({ optionId: null, typed: null, reveal: true });
          }}
          onBlur={() => setConfirmingReveal(false)}
        >
          <Icon name="eye" size={15} />
          {confirmingReveal ? "בטוחים? הסיבוב אבוד" : "ויתור"}
        </button>
      </div>
    </div>
  );
}
