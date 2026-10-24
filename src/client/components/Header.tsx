import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { countMount, countRender } from "../lib/liveness";
import { BallMark } from "./BallMark";
import { SoundToggle } from "./SoundToggle";
import { A11yMenu } from "./A11yMenu";
import { AccountButton } from "./AccountButton";
import { Icon } from "./Icon";
import "./Header.css";

/**
 * A thin, quiet bar: the mark, and the two controls a player might reach for
 * mid-game. Everything else lives on the pages themselves — a trivia game does
 * not need navigation.
 */
export function Header() {
  countRender("Header");
  useEffect(() => countMount("Header"), []);

  const { pathname } = useLocation();
  // A multiplayer room counts too: walking out of a live room costs other people
  // their game, so the links out are not on offer while one is open.
  const playing = pathname === "/play" || pathname.startsWith("/room/");

  return (
    <header className="topbar">
      <div className="page-wide page topbar-inner">
        <Link to="/" className="mark" aria-label="Football IQ — לעמוד הבית">
          <BallMark size={26} />
          <span className="mark-text">
            Football <span className="green">IQ</span>
          </span>
        </Link>

        <div className="row g2">
          {/* Hidden mid-quiz: these are trap doors out of a run. */}
          {/* One destination, not two.
              Multiplayer was a second link competing with this one and reaching
              the same place the homepage already offers; the daily challenge is
              the thing worth coming back for, and it is the only one here now so
              it can actually be seen. */}
          {!playing && (
            <Link to="/daily" className="topbar-daily" aria-label="האתגר היומי — שאלה חדשה כל יום">
              <Icon name="trophy" size={16} />
              <span>האתגר היומי</span>
              <span className="topbar-daily-dot" aria-hidden="true" />
            </Link>
          )}
          <SoundToggle />
          <A11yMenu />
          {!playing && <AccountButton />}
        </div>
      </div>
    </header>
  );
}
