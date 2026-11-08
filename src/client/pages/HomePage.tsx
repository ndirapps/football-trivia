import { useEffect, useRef, useState } from "react";
import { countMount, countRender } from "../lib/liveness";
import { useNavigate } from "react-router-dom";
import { QUICK_PRESETS, type QuickPreset } from "../lib/presets";
import { startQuiz } from "../lib/startQuiz";
import { messageHeOf } from "../lib/api";
import type { AnswerMode } from "../../shared/types";
import { sound } from "../lib/sound";
import { motionAllowed } from "../lib/a11y";
import { Icon } from "../components/Icon";
import { BallMark } from "../components/BallMark";
import { safeLocal } from "../lib/safeStorage";
import { privacy } from "../lib/privacy";
import "./HomePage.css";

/** The answer mode the player last picked, so a quick tile can start in one tap. */
const MODE_KEY = "fiq_answer_mode";
// Kept in memory too, so it holds for the visit even without storage consent.
let modeThisVisit: AnswerMode | null = null;
function loadMode(): AnswerMode | null {
  if (modeThisVisit) return modeThisVisit;
  const v = privacy.allows("preferences") ? safeLocal.get(MODE_KEY) : null;
  return v === "FREE_TEXT" || v === "MULTIPLE_CHOICE" ? v : null;
}
function saveMode(mode: AnswerMode) {
  modeThisVisit = mode;
  if (privacy.allows("preferences")) safeLocal.set(MODE_KEY, mode);
}

/**
 * One screen, one decision: start.
 *
 * Headline, subtitle, a single call to action, and four one-tap starts under
 * it. There is deliberately nothing else here — no feature sections, no
 * explanation of how a quiz works. The quickest way to explain this product is
 * to let someone play it.
 */
export function HomePage() {
  countRender("Home");
  useEffect(() => countMount("Home"), []);

  const navigate = useNavigate();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * A quick tile no longer starts the quiz on its own.
   *
   * It used to, and that made the single most consequential choice in the
   * product — typing the answer versus picking one of four — invisible: every
   * quick start was multiple choice because that is what the preset happened to
   * say. One tap to pick the topic, one tap to pick how you answer, then play.
   * No builder, no modal to dismiss, nothing to confirm.
   */
  const [pending, setPending] = useState<QuickPreset | null>(null);
  // Asked once, then remembered and shown as a switch above the tiles.
  const [mode, setMode] = useState<AnswerMode | null>(loadMode);
  const [lastTry, setLastTry] = useState<{ preset: QuickPreset; mode: AnswerMode } | null>(null);

  function pickMode(next: AnswerMode) {
    setMode(next);
    saveMode(next);
  }

  async function start(preset: QuickPreset, answerMode: AnswerMode) {
    setError(null);
    setPending(null);
    setLastTry({ preset, mode: answerMode });
    setLoadingKey(preset.key);
    sound.play("select");
    try {
      await startQuiz(navigate, { ...preset.config, answerMode });
    } catch (e) {
      // messageHeOf, not e.message: a server error's `.message` is an English
      // internal string and must not reach the screen.
      setError(messageHeOf(e));
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <div className="page home">
      <Hero />

      <h1 className="home-title a-fade-up">
        מה ה-<span className="green">Football&nbsp;IQ</span> שלכם?
      </h1>
      <p className="home-sub a-fade-up" style={{ animationDelay: "70ms" }}>
        בנו חידון ותגלו.
      </p>

      <div className="home-ctas a-fade-up" style={{ animationDelay: "140ms" }}>
        <button
          className="btn btn-primary btn-lg home-cta"
          disabled={loadingKey !== null}
          onClick={() => {
            sound.play("click");
            navigate("/build");
          }}
        >
          בנו חידון
          <Icon name="arrow" size={19} />
        </button>

        {/* The three ways into a game, all on the surface. Matchmaking in
            particular is not tucked inside the multiplayer menu: "find me
            somebody to play against right now" is its own intent, and burying it
            one level down is the difference between it being used and not.

            Its label says what it does rather than what it is. "משחק אקראי"
            described the mechanism — a random game — and left the player to guess
            whether that meant random questions, a random room, or a stranger.
            Naming the outcome instead, an opponent and a duel, is what makes it
            obvious there is a real person on the other end. */}
        <button
          className="btn btn-ghost btn-lg home-cta-mp"
          onClick={() => {
            sound.play("click");
            navigate("/multiplayer");
          }}
        >
          <Icon name="shirt" size={18} />
          משחק עם חברים
        </button>

        <button
          className="btn btn-ghost btn-lg home-cta-mp"
          onClick={() => {
            sound.play("click");
            navigate("/multiplayer/duel");
          }}
        >
          <Icon name="target" size={18} />
          מצאו יריב לדו־קרב
        </button>
      </div>

      {mode && (
        <div className="quick-mode" role="radiogroup" aria-label="איך עונים בהתחלה מהירה">
          <span className="quick-mode-label">עונים:</span>
          {(
            [
              ["FREE_TEXT", "בהקלדה", "keyboard"],
              ["MULTIPLE_CHOICE", "אמריקאי", "list"],
            ] as const
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={`quick-mode-opt ${mode === value ? "is-on" : ""}`}
              onClick={() => {
                sound.play("click");
                pickMode(value);
              }}
            >
              <Icon name={icon} size={15} />
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="quick a-stagger" role="group" aria-label="התחלה מהירה">
        {QUICK_PRESETS.map((preset, i) => (
          <button
            key={preset.key}
            className="quick-btn"
            style={{ "--i": i + 3 } as React.CSSProperties}
            disabled={loadingKey !== null}
            aria-busy={loadingKey === preset.key}
            aria-haspopup={mode ? undefined : "dialog"}
            onClick={() => {
              sound.play("click");
              if (mode) void start(preset, mode);
              else setPending(preset);
            }}
          >
            <Icon name={preset.icon} size={17} />
            <span>{loadingKey === preset.key ? "טוען…" : preset.titleHe}</span>
          </button>
        ))}
      </div>

      {pending && (
        <AnswerModeSheet
          preset={pending}
          onPick={(picked) => {
            pickMode(picked);
            void start(pending, picked);
          }}
          onDismiss={() => setPending(null)}
        />
      )}

      {error && (
        <div className="home-error a-pop" role="alert">
          <p>{error}</p>
          {lastTry && (
            <button className="btn btn-ghost btn-sm" onClick={() => start(lastTry.preset, lastTry.mode)}>
              <Icon name="replay" size={15} />
              נסו שוב
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one tap between choosing a topic and playing it.
 *
 * A bottom sheet rather than a modal: it is a choice, not a warning, so it rises
 * from the thumb rather than landing in the middle of the screen. Free text is
 * marked as the recommendation because it is the mode the product is actually
 * built around — the smart matcher, the aliases, the hints all exist for it —
 * but it is still a choice, not a default that happens silently.
 *
 * Keyboard and screen readers get a real dialog: focus moves in, Escape leaves,
 * and the two options are the only things to tab between.
 */
function AnswerModeSheet({
  preset,
  onPick,
  onDismiss,
}: {
  preset: QuickPreset;
  onPick: (mode: AnswerMode) => void;
  onDismiss: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="mode-sheet-backdrop" onClick={onDismiss}>
      <div
        className="mode-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mode-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="mode-sheet-topic">{preset.titleHe}</p>
        <h2 id="mode-sheet-title" className="mode-sheet-title">
          איך משחקים?
        </h2>

        <div className="mode-sheet-options">
          <button
            ref={firstRef}
            className="mode-opt is-primary"
            onClick={() => onPick("FREE_TEXT")}
          >
            <Icon name="keyboard" size={20} />
            <span className="mode-opt-label">תשובה חופשית</span>
            <span className="mode-opt-note">מקלידים את התשובה</span>
          </button>

          <button className="mode-opt" onClick={() => onPick("MULTIPLE_CHOICE")}>
            <Icon name="list" size={20} />
            <span className="mode-opt-label">אמריקאי</span>
            <span className="mode-opt-note">בוחרים מתוך ארבע</span>
          </button>
        </div>

        <button className="btn btn-quiet btn-sm mode-sheet-cancel" onClick={onDismiss}>
          ביטול
        </button>
      </div>
    </div>
  );
}

/**
 * The hero: a slowly turning ball with a few tactical lines behind it, and a
 * floodlight wash that drifts. Pointer parallax is applied to a wrapper via a
 * CSS variable so it costs one transform, and it is skipped entirely on coarse
 * pointers and under reduced motion.
 */
function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const [parallax, setParallax] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!motionAllowed()) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { innerWidth, innerHeight } = window;
        setParallax({
          x: (event.clientX / innerWidth - 0.5) * 14,
          y: (event.clientY / innerHeight - 0.5) * 10,
        });
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div
      className="hero"
      ref={ref}
      aria-hidden="true"
      style={{ "--px": `${parallax.x}px`, "--py": `${parallax.y}px` } as React.CSSProperties}
    >
      <span className="hero-light" data-ambient />
      <svg className="hero-lines" viewBox="0 0 220 120" fill="none">
        <path d="M14 96 C 60 74, 78 36, 112 28" stroke="var(--green)" strokeWidth="1.2" strokeDasharray="4 6" opacity="0.5" />
        <path d="M206 92 C 168 78, 152 44, 118 32" stroke="var(--blue)" strokeWidth="1.2" strokeDasharray="4 6" opacity="0.4" />
        <circle cx="14" cy="96" r="2.6" fill="var(--green)" opacity="0.7" />
        <circle cx="206" cy="92" r="2.6" fill="var(--blue)" opacity="0.6" />
      </svg>
      <span className="hero-ball">
        <BallMark size={78} spinning />
      </span>
    </div>
  );
}
