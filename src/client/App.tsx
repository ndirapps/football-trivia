import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { isNativeApp } from "./lib/platform";
import { privacy } from "./lib/privacy";

// In the app the consent bar is website furniture: everything it governs lives
// in the app's own sandbox on the phone, and the App Store privacy labels and
// /privacy disclose it. The app records the choice the bar would have offered
// as its default, once, so nothing downstream has to know about the platform.
if (isNativeApp() && !privacy.get().decided) privacy.acceptAll();
import { ScrollToTop } from "./components/ScrollToTop";
import { RouteAnnouncer } from "./components/RouteAnnouncer";
import { PrivacyGate } from "./components/PrivacyGate";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { FeatureBoundary } from "./components/FeatureBoundary";
import { HomePage } from "./pages/HomePage";
import { BuilderPage } from "./pages/BuilderPage";
import { QuizPage } from "./pages/QuizPage";
import { ResultsPage } from "./pages/ResultsPage";
import { ChallengePage } from "./pages/ChallengePage";
import { DailyPage } from "./pages/DailyPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { MultiplayerPage } from "./pages/MultiplayerPage";
import { DuelSearchPage } from "./pages/DuelSearchPage";
import { RoomPage } from "./pages/RoomPage";
import { RoomDisplayPage } from "./pages/RoomDisplayPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProfilePage } from "./pages/ProfilePage";
import { a11y } from "./lib/a11y";
import { sound } from "./lib/sound";
import { markRouteRendered, markStage } from "./lib/startup";
import { countMount, countRender } from "./lib/liveness";

export default function App() {
  const { pathname } = useLocation();

  /*
    Counted, because the one symptom never explained was titles "shaking".

    A tree that remounts in a loop is blank for part of every cycle, throws
    nothing, and logs nothing — so it looks exactly like an intermittent blank
    screen and none of the previous guards would have seen it. App mounts once
    per session; an unmount count above zero here is the bug.
  */
  countRender("App");
  useEffect(() => countMount("App"), []);

  // The shared screen is furniture in a room, not a page someone is browsing:
  // the site header, the footer and the skip link would all be dead weight on a
  // television nobody can click.
  const bare = /^\/room\/[^/]+\/display\/?$/.test(pathname);

  useEffect(() => {
    // Apply stored accessibility settings before first paint of the routes,
    // and arm the audio context on the first interaction of any kind.
    //
    // Both are wrapped. Neither is the game: a visitor who gets default text
    // sizing or silent audio has lost something small, and a throw here would
    // otherwise propagate out of a passive effect and cost them the whole page
    // — which is exactly how the privacy bar's layout measurement took the
    // product down (see FeatureBoundary).
    try {
      a11y.init();
    } catch (error) {
      console.warn("accessibility settings could not be applied", error);
    }
    try {
      sound.bindGestures();
    } catch (error) {
      console.warn("audio could not be armed", error);
    }

    // The router resolved a route and the first one painted. Both recorded,
    // neither awaited: nothing in the tree reads a stage to decide whether to
    // render, so this cannot gate the UI.
    markStage("ROUTER_READY");
    markRouteRendered();
  }, []);

  return (
    <>
      {!bare && (
        <a href="#main" className="skip-link">
          דלגו לתוכן הראשי
        </a>
      )}

      {/* Faint halfway line and centre circle, behind everything. */}
      <div className="pitch-bg" aria-hidden="true" />

      {/*
        THE CHROME IS OPTIONAL; THE ROUTE IS NOT.

        Everything outside <main> is furniture — scroll restoration, a live
        region for screen readers, the header, the footer, the consent bar. Each
        is wrapped on its own so that a failure in one costs exactly that one.
        Before this, any of them could throw from an effect after first paint
        and unmount the whole root, which is what produced a fully rendered page
        that emptied itself a second later.

        The <Routes> below are deliberately NOT wrapped like this. If the quiz
        board fails, rendering nothing would be the blank page this is all about;
        that belongs to the root ErrorBoundary in main.tsx, which says something
        and offers a way out.
      */}
      <FeatureBoundary feature="scroll-restoration">
        <ScrollToTop />
      </FeatureBoundary>

      <FeatureBoundary feature="route-announcer">
        <RouteAnnouncer />
      </FeatureBoundary>

      {!bare && (
        <FeatureBoundary feature="header">
          <Header />
        </FeatureBoundary>
      )}

      <main id="main" tabIndex={-1} className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/build" element={<BuilderPage />} />
          <Route path="/play" element={<QuizPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/challenge/:publicId" element={<ChallengePage />} />
          <Route path="/daily" element={<DailyPage />} />
          <Route path="/multiplayer" element={<MultiplayerPage />} />
          <Route path="/multiplayer/duel" element={<DuelSearchPage />} />
          <Route path="/room/:code" element={<RoomPage />} />
          <Route path="/room/:code/display" element={<RoomDisplayPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      {!bare && (
        <FeatureBoundary feature="footer">
          {/* Website only. In the app the privacy page is reached from the account sheet and the profile. */}
          {!isNativeApp() && <Footer />}
        </FeatureBoundary>
      )}

      {/* The one that actually did it. */}
      <FeatureBoundary feature="privacy-gate">
        {!isNativeApp() && <PrivacyGate />}
        <WelcomeScreen />
      </FeatureBoundary>
    </>
  );
}
