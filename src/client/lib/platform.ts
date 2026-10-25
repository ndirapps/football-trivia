// Where the bundle is running.
//
// The same SPA ships as the website and inside the Capacitor app. A few pieces
// of chrome belong to the website only — the accessibility menu and the footer
// links — and the app leaves them out. Everything else is identical.

import { Capacitor } from "@capacitor/core";

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
