// Universal links, in the app.
//
// When a room invite, a challenge link or the daily-challenge link is tapped on
// a phone with the app installed, iOS opens the app instead of Safari and hands
// it the URL. Only the path matters: it is the same route the website would
// have shown, so the router takes it from there.

type AppModule = typeof import("@capacitor/app");

function isNativeApp(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/** The in-app route for an opened URL, or null for anything this app does not handle. */
export function routeForUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname;
  if (/^\/room\/\d{6}\/?$/.test(path) || /^\/challenge\/[A-Za-z0-9]{4,64}\/?$/.test(path) || path === "/daily") {
    return path.replace(/\/$/, "") + url.search;
  }
  return null;
}

export function listenForDeepLinks(navigate: (path: string) => void): () => void {
  if (!isNativeApp()) return () => {};
  let removed = false;
  let remove: (() => void) | null = null;
  void import("@capacitor/app").then(({ App }: AppModule) =>
    App.addListener("appUrlOpen", ({ url }) => {
      const route = routeForUrl(url);
      if (route) navigate(route);
    }).then((handle) => {
      if (removed) void handle.remove();
      else remove = () => void handle.remove();
    })
  );
  return () => {
    removed = true;
    remove?.();
  };
}
