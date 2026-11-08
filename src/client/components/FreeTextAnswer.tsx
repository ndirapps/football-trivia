import { useEffect, useRef, useState } from "react";
import type { Question } from "../../shared/types";
import { matchAnswer } from "../../shared/answerMatching";
import { sound } from "../lib/sound";
import { motionAllowed } from "../lib/a11y";
import { Icon } from "./Icon";
import "./FreeTextAnswer.css";
import { isolateLatin, hintText } from "../lib/bidi";

export interface FreeTextResult {
  correct: boolean;
  revealed: boolean;
  typed: string;
  hintsUsed: number;
}

interface Props {
  question: Question;
  onResolved: (result: FreeTextResult) => void;
  resolved: FreeTextResult | null;
}

/** How long the VAR card is held before the answer resolves. */
const VAR_MS = 850;

/** Two tries per question: a typo should not cost the whole question. */
const ATTEMPTS = 2;

/**
 * Once the player has opened the keyboard on a touch device, keep it coming
 * back on each new question instead of costing a tap every time.
 */
let keyboardWarm = false;

export function FreeTextAnswer({ question, onResolved, resolved }: Props) {
  const [value, setValue] = useState("");
  const [hintsShown, setHintsShown] = useState(0);
  const [confirmingReveal, setConfirmingReveal] = useState(false);
  const [shake, setShake] = useState(false);
  const [varCheck, setVarCheck] = useState<"checking" | "approved" | null>(null);
  const [missed, setMissed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue("");
    setHintsShown(0);
    setConfirmingReveal(false);
    setVarCheck(null);
    setMissed(null);
    if (keyboardWarm || !window.matchMedia?.("(pointer: coarse)").matches) inputRef.current?.focus();
  }, [question.id]);

  function submit() {
    if (resolved || varCheck) return;
    const typed = value.trim();
    if (!typed) {
      setShake(true);
      window.setTimeout(() => setShake(false), 400);
      inputRef.current?.focus();
      return;
    }

    const result = matchAnswer(typed, {
      canonical: question.canonicalAnswer ?? "",
      aliases: question.aliases,
    });

    // A spelling that only got through on tolerance gets a VAR check: it tells
    // the player their answer was borderline and was given, without ever
    // showing them an edit distance. Exact and alias hits skip it — there is
    // nothing to review.
    const borderline = result.correct && (result.kind === "fuzzy" || result.kind === "token");

    // First miss: say so and let them try again. A second-try hit counts like
    // one hint, so it still scores below a clean first answer.
    if (!result.correct && missed === null && ATTEMPTS > 1) {
      sound.play("wrong");
      setMissed(typed);
      setValue("");
      setShake(true);
      window.setTimeout(() => setShake(false), 400);
      inputRef.current?.focus();
      return;
    }
    const usedHints = hintsShown + (missed !== null ? 1 : 0);

    if (borderline && motionAllowed()) {
      setVarCheck("checking");
      window.setTimeout(() => setVarCheck("approved"), VAR_MS * 0.62);
      window.setTimeout(() => {
        sound.play("correct");
        onResolved({ correct: true, revealed: false, typed, hintsUsed: usedHints });
      }, VAR_MS);
      return;
    }

    sound.play(result.correct ? "correct" : "wrong");
    onResolved({ correct: result.correct, revealed: false, typed, hintsUsed: usedHints });
  }

  function reveal() {
    if (resolved) return;
    if (!confirmingReveal) {
      setConfirmingReveal(true);
      return;
    }
    sound.play("reveal");
    onResolved({ correct: false, revealed: true, typed: value.trim(), hintsUsed: hintsShown });
  }

  function showNextHint() {
    if (hintsShown >= question.hints.length) return;
    sound.play("hint");
    setHintsShown((n) => n + 1);
  }

  const hintsLeft = question.hints.length - hintsShown;

  return (
    <div className="ft">
      {hintsShown > 0 && (
        <ol className="ft-hints">
          {question.hints.slice(0, hintsShown).map((hint, i) => (
            <li key={i} className="ft-hint a-fade-up">
              <Icon name="bulb" size={14} />
              <span>{isolateLatin(hintText(hint))}</span>
            </li>
          ))}
        </ol>
      )}

      {varCheck && (
        <div className={`var-card ${varCheck === "approved" ? "is-approved" : ""}`} role="status">
          <span className="var-scan" aria-hidden="true" />
          {varCheck === "checking" ? (
            <span className="var-text">בדיקת VAR…</span>
          ) : (
            <span className="var-text var-stamp">מאושר!</span>
          )}
        </div>
      )}

      {!resolved && !varCheck && (
        <>
          {missed !== null && (
            <p className="ft-retry a-fade-up" role="status">
              לא בדיוק{missed ? <> (<bdi>{missed}</bdi>)</> : null}. נשאר עוד ניסיון אחד.
            </p>
          )}
          <form
            className={`ft-form ${shake ? "a-wrong" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="sr-only" htmlFor="ft-input">
              הקלידו את התשובה
            </label>
            <input
              id="ft-input"
              ref={inputRef}
              className="input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={() => {
                keyboardWarm = true;
              }}
              placeholder="התשובה שלכם…"
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
            <button type="button" className="btn btn-quiet btn-sm" onClick={showNextHint} disabled={hintsLeft === 0}>
              <Icon name="bulb" size={15} />
              {hintsLeft === 0 ? "אין רמזים" : `רמז (${hintsLeft})`}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${confirmingReveal ? "btn-amber" : "btn-quiet"}`}
              onClick={reveal}
              onBlur={() => setConfirmingReveal(false)}
            >
              <Icon name="eye" size={15} />
              {confirmingReveal ? "בטוחים?" : "גלה תשובה"}
            </button>
          </div>
        </>
      )}

      {resolved && (
        <div
          className={`ft-out a-pop ${
            resolved.correct ? "is-correct" : resolved.revealed ? "is-revealed" : "is-wrong"
          }`}
        >
          <p className="ft-out-head">
            <Icon
              name={resolved.correct ? "check" : resolved.revealed ? "eye" : "cross"}
              size={19}
              strokeWidth={2.6}
            />
            {resolved.correct ? "נכון" : resolved.revealed ? "נחשף" : "לא נכון"}
          </p>
          {!resolved.correct && resolved.typed && (
            <p className="ft-out-line faint">כתבתם: <bdi>{resolved.typed}</bdi></p>
          )}
          <p className="ft-out-line">
            התשובה: <b><bdi>{question.canonicalAnswer}</bdi></b>
          </p>
        </div>
      )}
    </div>
  );
}
