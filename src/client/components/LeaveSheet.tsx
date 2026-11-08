import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import "./AccountSheet.css";

/**
 * "Leave this game?" — the one confirm between a player and a lost run.
 * Staying is the focused, safe default; Escape and the backdrop also stay.
 */
export function LeaveSheet({ inRoom, onStay, onLeave }: { inRoom: boolean; onStay: () => void; onLeave: () => void }) {
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stayRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onStay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStay]);

  // Portalled to <body>: the header's backdrop-filter would otherwise become the
  // containing block for this fixed sheet and trap it inside the bar.
  return createPortal(
    <div className="account-sheet-backdrop" onClick={onStay}>
      <div
        className="account-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-body"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="account-sheet-badge" aria-hidden="true">
          <Icon name="whistle" size={26} />
        </span>
        <h2 id="leave-title" className="account-sheet-title">
          {inRoom ? "לצאת מהחדר?" : "לצאת מהחידון?"}
        </h2>
        <p id="leave-body" className="account-sheet-sub">
          {inRoom ? "המשחק ימשיך בלעדיכם, והניקוד שלכם לא יישמר." : "ההתקדמות בחידון הזה לא תישמר."}
        </p>
        <button ref={stayRef} className="btn btn-primary btn-lg btn-block" onClick={onStay}>
          להמשיך לשחק
        </button>
        <button className="btn btn-quiet account-sheet-guest" onClick={onLeave}>
          כן, לצאת
        </button>
      </div>
    </div>,
    document.body
  );
}
