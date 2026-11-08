import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

// A single-page app changes the view without a page load, so a screen reader
// gets no announcement on navigation. This speaks the new view's name into a
// polite live region and keeps the document title in step.
const TITLES: Record<string, string> = {
  "/": "דף הבית",
  "/build": "בניית חידון",
  "/play": "חידון פעיל",
  "/results": "תוצאות",
  "/daily": "אתגר יומי",
  "/multiplayer": "משחק עם חברים",
  "/multiplayer/duel": "דו־קרב אקראי",
  "/privacy": "מדיניות פרטיות",
};

function nameFor(pathname: string): string {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith("/challenge/")) return "אתגר משותף";
  // The room code is part of the name on purpose: it is what a player reads out
  // to the person next to them, and it is the one thing that identifies which
  // room this tab is in when several are open.
  const room = /^\/room\/(\d{6})(\/display)?\/?$/.exec(pathname);
  if (room) return room[2] ? `מסך משותף · חדר ${room[1]}` : `חדר ${room[1]}`;
  return "הדף לא נמצא";
}

export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const [message, setMessage] = useState("");

  useEffect(() => {
    const name = nameFor(pathname);
    document.title = `${name} · Football IQ`;
    // A tick's delay makes assistive tech treat it as a fresh change rather
    // than part of the initial render.
    const timer = window.setTimeout(() => setMessage(name), 120);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return (
    <p className="sr-only" role="status" aria-live="polite">
      {message}
    </p>
  );
}
