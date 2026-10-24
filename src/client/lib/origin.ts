// Where the server is, as seen from the page.
//
// On the web the page and the API share one origin, so every URL is relative and
// `window.location` is the server. The native app (Capacitor) breaks that: the
// page is served from the bundle at capacitor://localhost (iOS) or
// https://localhost (Android), so a relative `/api/quiz` would ask the bundle,
// and a share link built from `window.location.origin` would point at a phone.
//
// The native build sets VITE_API_ORIGIN to the deployed Worker. The web build
// leaves it unset, and everything below collapses to exactly what it was before.

const API_ORIGIN: string = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");

/** Absolute in the app, relative on the web. */
export function apiUrl(path: string): string {
  return API_ORIGIN + path;
}

/** ws:// or wss:// on the server's host, whichever page this is. */
export function socketUrl(path: string): string {
  const base = API_ORIGIN || `${window.location.protocol}//${window.location.host}`;
  return base.replace(/^http/, "ws") + path;
}

/** The origin a link should carry when it leaves this device: always the public site. */
export function publicOrigin(): string {
  return API_ORIGIN || window.location.origin;
}
