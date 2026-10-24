import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithApple } from "../lib/account";
import { messageHeOf } from "../lib/api";
import { sound } from "../lib/sound";
import { Icon } from "./Icon";
import "./AccountSheet.css";

/**
 * The guest's invitation to an account.
 *
 * Says what an account gives, and that it asks for nothing — then one button.
 * "המשך כאורח" is as large a target as anything else here: signing in is an
 * offer, never a gate. A brand-new account lands on the profile to pick a name.
 */
export function AccountSheet({ onDismiss }: { onDismiss: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  async function start() {
    setError(null);
    setBusy(true);
    sound.play("click");
    try {
      const result = await signInWithApple();
      if (!result) return;
      sound.play("select");
      onDismiss();
      navigate(result.isNew ? "/profile?welcome=1" : "/profile");
    } catch (e) {
      setError(messageHeOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-sheet-backdrop" onClick={onDismiss}>
      <div
        className="account-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="account-sheet-badge" aria-hidden="true">
          <Icon name="user" size={28} />
        </span>
        <h2 id="account-sheet-title" className="account-sheet-title">
          שמרו את ההתקדמות
        </h2>
        <p className="account-sheet-sub">חשבון אחד, וכל מה ששיחקתם הולך איתכם.</p>

        <ul className="account-sheet-points">
          <li>
            <Icon name="shirt" size={18} />
            השם והסטטיסטיקה שלכם בכל מכשיר
          </li>
          <li>
            <Icon name="lock" size={18} />
            בלי אימייל ובלי סיסמה
          </li>
          <li>
            <Icon name="check" size={18} />
            אפשר למחוק את החשבון בכל רגע
          </li>
        </ul>

        <button ref={firstRef} className="apple-btn" onClick={start} disabled={busy} aria-busy={busy}>
          <AppleLogo />
          {busy ? "מתחבר…" : "התחברות עם Apple"}
        </button>

        {error && (
          <p className="account-sheet-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-quiet account-sheet-guest" onClick={onDismiss}>
          המשך כאורח
        </button>
      </div>
    </div>
  );
}

export function AppleLogo({ color = "#000000", size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={(size * 20) / 17} viewBox="0 0 17 20" aria-hidden="true">
      <path
        fill={color}
        d="M14.2 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9C3.6 4.8 2 5.8 1.1 7.4c-1.9 3.2-.5 8 1.3 10.6.9 1.3 2 2.7 3.4 2.6 1.3-.1 1.9-.9 3.5-.9s2.1.9 3.5.8c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.9-1-3.2-4.3zM11.7 3c.7-.9 1.2-2.1 1.1-3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.1 1.1.1 2.3-.6 3-1.7z"
      />
    </svg>
  );
}
