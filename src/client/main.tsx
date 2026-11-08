// Startup.
//
// Short, and every line of it is about not failing. The old version was three
// statements with a non-null assertion on `getElementById`, which meant any
// throw between here and the first paint produced a blank page with nothing on
// it — see index.html for the two mechanisms that actually did that in
// production.
//
// The order below is load-bearing:
//
//   1. the error boundary is the OUTERMOST element, outside BrowserRouter and
//      outside App. A boundary inside the router cannot catch the router
//      throwing, and a bad history entry or a malformed URL is one of the things
//      worth catching.
//   2. the boot layer is told we mounted only after render() has returned, so
//      "mounted" means React genuinely put something on screen rather than
//      "the bundle evaluated".
//   3. nothing optional runs before render. Accessibility settings and the audio
//      context are armed from an effect inside App, so neither can keep the
//      first paint from happening.
//
// global.css must be imported BEFORE App.
//
// Vite emits CSS in module-graph order, so importing App first put every
// component stylesheet ahead of the base layer — and any rule that tied on
// specificity with a global one (`.stamp` vs `.fixture-tag`, say) silently lost
// to the global. Base first, components after, is the order everything else
// here assumes.
// Fonts ship inside the bundle: the app must render the same with no network.
import "@fontsource-variable/rubik/wght.css";
import "@fontsource-variable/assistant/wght.css";
import "./styles/global.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { markStage } from "./lib/startup";

function start() {
  const container = document.getElementById("root");

  // The container is in index.html, so its absence means the document itself is
  // not the one we built. Nothing to render into and nothing to be done about
  // it — but it must not be an unexplained blank page, and the boot layer's
  // failsafe is still armed and will say so.
  if (!container) {
    console.error("startup: #root is missing from the document");
    return;
  }

  markStage("JS_STARTED");

  // Recorded before render(), so a failure inside the first render is
  // distinguishable from a failure constructing the root at all.
  const root = ReactDOM.createRoot(container);
  markStage("REACT_CREATE_ROOT");

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );

  /*
    Dismisses the loading shell and cancels the nine-second failsafe.

    Deferred by one frame on purpose, so a synchronous throw out of the initial
    render is still caught by the failsafe rather than being hidden behind a
    shell we had already taken down.

    BUT NOT BY requestAnimationFrame ALONE, which is what this used to be and
    was a real bug: rAF does not fire while a page is not visible. A link opened
    in a background tab, an in-app browser that pre-warms the page off-screen, or
    a visitor who switches away during load all produce the same result — React
    renders fine, the callback never runs, and the opaque boot shell sits on top
    of a perfectly good app. Reproduced on both engines: "headline is COVERED,
    curtain z9999 rgb(13,21,34)", which is this shell, over a rendered page.

    So: whichever of the frame and the timer arrives first wins, and the timer
    does not care about visibility. `handed` makes it once-only. The boot layer
    also dismisses itself on seeing #root populated, so this handshake is now a
    convenience rather than the only way out.
  */
  let handed = false;
  const handOver = () => {
    if (handed) return;
    handed = true;
    try {
      markStage("REACT_MOUNTED");
      window.__FIQ_MOUNTED__?.();
    } catch {
      /* the shell is a fallback, not a dependency */
    }
  };

  if (typeof requestAnimationFrame === "function") requestAnimationFrame(handOver);
  setTimeout(handOver, 150);
}

try {
  start();
} catch (error) {
  // A throw out here is a module-evaluation or createRoot failure, which the
  // error boundary cannot see because it is not mounted yet. Leave the boot
  // layer's shell and failsafe in place to handle the screen, and make sure the
  // reason is recorded.
  console.error("startup failed", error);
  try {
    window.__FIQ_ERRORS__?.push({
      kind: "startup",
      stage: window.__FIQ_STAGE__ ?? null,
      route: window.location.pathname,
      message: String((error as Error)?.message ?? error).slice(0, 300),
      stack: String((error as Error)?.stack ?? "").split("\n").slice(0, 4).join(" | "),
      at: Date.now(),
    });
  } catch {
    /* nothing left to do */
  }
}
