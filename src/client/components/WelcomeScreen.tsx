import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { accountsAvailable, signInWithApple, useAccount } from "../lib/account";
import { messageHeOf } from "../lib/api";
import { isNativeApp } from "../lib/platform";
import { safeLocal } from "../lib/safeStorage";
import { sound } from "../lib/sound";
import { AppleLogo } from "./AccountSheet";
import { BallMark } from "./BallMark";
import { Icon } from "./Icon";
import "./WelcomeScreen.css";

export const WELCOME_SEEN_KEY = "fiq_welcome_seen";

/**
 * The app's first screen, once.
 *
 * Says what the game is, offers Sign in with Apple, and lets anyone straight in
 * as a guest — both choices close it for good. App only: the website opens on
 * the home page as it always has. It sits inside #root, so the boot watchdog
 * (index.html) reads it as the app being on screen, which it is.
 */
export function WelcomeScreen() {
  const account = useAccount();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [seen, setSeen] = useState(() => safeLocal.get(WELCOME_SEEN_KEY) === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isNativeApp() || seen || account.status !== "guest" || pathname === "/privacy") return null;

  function close() {
    safeLocal.set(WELCOME_SEEN_KEY, "1");
    setSeen(true);
  }

  async function signIn() {
    setError(null);
    setBusy(true);
    sound.play("click");
    try {
      const result = await signInWithApple();
      if (!result) return;
      sound.play("select");
      close();
      if (result.isNew) navigate("/profile?welcome=1");
    } catch (e) {
      setError(messageHeOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <span className="welcome-glow" aria-hidden="true" />

      <div className="welcome-hero">
        <div className="welcome-mark" aria-hidden="true">
          <svg className="welcome-lines" viewBox="0 0 220 120" fill="none">
            <path d="M14 96 C 60 74, 78 36, 112 28" stroke="var(--green)" strokeWidth="1.2" strokeDasharray="4 6" opacity="0.55" />
            <path d="M206 92 C 168 78, 152 44, 118 32" stroke="var(--blue)" strokeWidth="1.2" strokeDasharray="4 6" opacity="0.45" />
            <circle cx="14" cy="96" r="2.6" fill="var(--green)" opacity="0.8" />
            <circle cx="206" cy="92" r="2.6" fill="var(--blue)" opacity="0.7" />
          </svg>
          <BallMark size={104} spinning />
        </div>

        <h1 id="welcome-title" className="welcome-title">
          Football <span className="green">IQ</span>
        </h1>
        <p className="welcome-sub">
          חידוני כדורגל בעברית.
          <br />
          כמה אתם באמת יודעים?
        </p>

        <ul className="welcome-chips">
          <li>
            <Icon name="calendar" size={15} />
            אתגר יומי
          </li>
          <li>
            <Icon name="target" size={15} />
            דו־קרבות
          </li>
          <li>
            <Icon name="shirt" size={15} />
            משחק עם חברים
          </li>
        </ul>
      </div>

      <div className="welcome-actions">
        {accountsAvailable() && (
          <>
            <p className="welcome-hint">התחברו כדי לשמור את ההתקדמות בכל מכשיר</p>
            <button className="apple-btn welcome-apple" onClick={signIn} disabled={busy} aria-busy={busy}>
              <AppleLogo />
              {busy ? "מתחבר…" : "התחברות עם Apple"}
            </button>
            {error && (
              <p className="account-sheet-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <button
          className="btn btn-ghost btn-lg welcome-guest"
          onClick={() => {
            sound.play("click");
            close();
          }}
          disabled={busy}
        >
          המשך כאורח
        </button>
        <Link to="/privacy" className="account-sheet-privacy welcome-privacy">
          מדיניות פרטיות
        </Link>
      </div>
    </div>
  );
}
