import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicPlayer } from "../../../shared/multiplayer/types";
import { blockPlayer, isBlocked } from "../../lib/mp/blocklist";
import { BLOCKED_NAME } from "../../lib/mp/blockMask";
import { reportPlayerRequest, type ReportReason } from "../../lib/api";
import { Icon } from "../Icon";
import "../AccountSheet.css";
import "./ReportSheet.css";

const REASONS: { id: ReportReason; label: string }[] = [
  { id: "offensive_name", label: "שם פוגעני" },
  { id: "offensive_message", label: "הודעה פוגענית" },
  { id: "cheating", label: "רמאות" },
  { id: "other", label: "אחר" },
];

/**
 * Report and block another player — App Store guideline 1.2.
 *
 * Reporting sends what this player saw to the developer; blocking hides the other
 * player's messages and name on this device and stops the matchmaker from ever
 * pairing the two again. Both are available to guests.
 */
export function ReportSheet({
  players,
  roomCode,
  onClose,
  onLeave,
}: {
  players: PublicPlayer[];
  roomCode: string | null;
  onClose: () => void;
  onLeave: () => void;
}) {
  const [target, setTarget] = useState<PublicPlayer | null>(players.length === 1 ? players[0] : null);
  const [reason, setReason] = useState<ReportReason>("offensive_name");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"reported" | "blocked" | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(report: boolean) {
    if (!target) return;
    setError("");
    if (report) {
      setBusy(true);
      try {
        await reportPlayerRequest({ roomCode, blockKey: target.blockKey, name: target.name, reason });
      } catch {
        setBusy(false);
        setError("לא הצלחנו לשלוח את הדיווח. השחקן נחסם בכל זאת — נסו לדווח שוב מאוחר יותר.");
        blockPlayer(target.blockKey, target.name);
        return;
      }
      setBusy(false);
    }
    blockPlayer(target.blockKey, target.name);
    setDone(report ? "reported" : "blocked");
  }

  return createPortal(
    <div className="account-sheet-backdrop" onClick={onClose}>
      <div
        className="account-sheet report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="account-sheet-badge" aria-hidden="true">
          <Icon name="shield" size={26} />
        </span>

        {done ? (
          <>
            <h2 id="report-title" className="account-sheet-title">
              {done === "reported" ? "תודה, הדיווח התקבל" : "השחקן נחסם"}
            </h2>
            <p className="account-sheet-sub report-done-body">
              {done === "reported" ? "נבדוק את הדיווח תוך 24 שעות. " : ""}
              לא תשמעו ממנו יותר: ההודעות שלו מוסתרות, והוא לא יוגרל מולכם שוב בדו־קרב.
            </p>
            <button ref={closeRef} className="btn btn-primary btn-lg btn-block" onClick={onLeave}>
              לצאת מהחדר
            </button>
            <button className="btn btn-quiet account-sheet-guest" onClick={onClose}>
              להישאר במשחק
            </button>
          </>
        ) : (
          <>
            <h2 id="report-title" className="account-sheet-title">
              דיווח או חסימה
            </h2>
            <p className="account-sheet-sub">על מי מדובר?</p>

            <div className="report-players" role="radiogroup" aria-label="שחקן">
              {players.map((p) => {
                const already = isBlocked(p.blockKey, p.name);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={target?.id === p.id}
                    className={`report-chip${target?.id === p.id ? " is-on" : ""}`}
                    onClick={() => setTarget(p)}
                    disabled={already}
                  >
                    {already ? `${BLOCKED_NAME}` : p.name}
                  </button>
                );
              })}
            </div>

            <p className="account-sheet-sub">מה קרה?</p>
            <div className="report-players" role="radiogroup" aria-label="סיבה">
              {REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={reason === r.id}
                  className={`report-chip${reason === r.id ? " is-on" : ""}`}
                  onClick={() => setReason(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {error && (
              <p className="report-error" role="alert">
                {error}
              </p>
            )}

            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={!target || busy}
              onClick={() => void submit(true)}
            >
              {busy ? "שולחים…" : "לדווח ולחסום"}
            </button>
            <button className="btn btn-quiet account-sheet-guest" disabled={!target || busy} onClick={() => void submit(false)}>
              לחסום בלי לדווח
            </button>
            <button ref={closeRef} className="btn btn-quiet account-sheet-guest" onClick={onClose}>
              ביטול
            </button>
          </>
        )}
      </div>
    </div>,
    document.getElementById("root") ?? document.body
  );
}
