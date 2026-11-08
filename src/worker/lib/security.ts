// Response headers and the Content-Security-Policy.
//
// WHY THIS IS A WORKER CONCERN AND NOT A STATIC FILE. Cloudflare's assets
// binding serves files with no security headers and no say in their cache
// policy, so the only place that can set either is Worker code sitting in front
// of it. That is also why `run_worker_first` is on: an asset that bypasses the
// Worker bypasses everything in this file.
//
// THE CSP IS BUILT PER REQUEST, for one reason: `connect-src`. The multiplayer
// socket is `wss://<this host>/api/mp/...`, and the host differs between
// football-iq.naorl.workers.dev, a preview deployment and localhost. Hard-coding
// it would either break the socket off the production hostname or force a
// wildcard. Deriving it from the request costs a string concat and keeps the
// directive exact.
//
// WHAT IS DELIBERATELY NOT LOCKED DOWN, and why, so the next person does not
// "fix" it:
//
//   style-src 'unsafe-inline'   React writes inline style attributes (eighteen
//                               components use `style={{…}}`, and the
//                               accessibility text-scale is a custom property
//                               set on <html>). Blocking those means blocking
//                               the product. An inline style attribute is not a
//                               script execution path, and with no HTML sink
//                               anywhere in the app (see SECURITY.md) it is not
//                               a route to one either.
//
// Fonts (Rubik, Assistant) are bundled with the app, so no font host is allowed.
//
// Everything else is closed: no 'unsafe-eval', no wildcards, no inline script
// except the one bootstrap block, which carries a per-response nonce.

/** Paths whose contents are content-addressed by Vite and therefore immutable. */
export const HASHED_ASSET_PREFIX = "/assets/";

/**
 * A fresh nonce for the one inline script in index.html.
 *
 * 128 bits from the CSRNG, base64'd. Regenerated per response — a nonce that
 * repeats is a nonce an injected script can guess and reuse.
 */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function contentSecurityPolicy(url: URL, nonce: string | null): string {
  const socket = `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}`;
  const script = nonce ? `'self' 'nonce-${nonce}'` : "'self'";

  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src 'self' ${socket}`,
    // The game synthesises its audio with the Web Audio API and loads no media
    // files at all, so there is nothing for these to allow.
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    // Nothing embeds this app, and a trivia game inside a hostile iframe is a
    // clickjacking target with no upside.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    /*
      HTTPS ONLY, and this one bites.

      `upgrade-insecure-requests` asks the browser to rewrite this document's
      http subresource requests to https. On a secure page that is exactly
      right. On an http origin it is meaningless at best — and in WebKit it is
      actively destructive: served over `http://127.0.0.1`, WebKit upgraded the
      bundle requests to https, which no dev server answers, and executed no
      script at all. The page loaded, no request was reported as failed, and
      nothing rendered. Verified by stripping this one directive from the
      response:

        CSP as served                        stage undefined, #root empty
        CSP without upgrade-insecure-requests  stage APP_READY, #root populated

      Production is https and was never affected, but this silently made local
      WebKit testing impossible — which is the environment the iOS bugs live in,
      so it cost more than it looks like.
    */
    ...(url.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The headers every response gets, whatever produced it.
 *
 * `nonce` is null for anything that is not the HTML shell: an API response or a
 * JS bundle has no inline script to authorise, and handing out a nonce that
 * nothing uses only widens script-src.
 */
export function securityHeaders(url: URL, nonce: string | null): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(url, nonce),
    "X-Content-Type-Options": "nosniff",
    // frame-ancestors above is the real control; this is for the older browsers
    // that only understand this one.
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // The product uses none of these. Saying so explicitly means a future
    // dependency cannot quietly start using one.
    "Permissions-Policy": [
      "accelerometer=()", "camera=()", "display-capture=()", "geolocation=()",
      "gyroscope=()", "magnetometer=()", "microphone=()", "midi=()",
      "payment=()", "usb=()", "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Only meaningful over TLS, and only ever sent there: handing an HSTS policy
    // to a plaintext localhost dev server would pin the developer's own machine
    // to https for a year.
    ...(url.protocol === "https:"
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

/**
 * Cache policy, which is half of the blank-screen fix.
 *
 * The failure it prevents: a browser holding a previous deployment's index.html
 * asks for a bundle hash that no longer exists. Serving the shell long-lived
 * guarantees that; serving it `no-store` guarantees the opposite. Hashed bundles
 * get the year-long immutable cache they have earned by being content-addressed
 * — which is also what stops the browser revalidating 425KB on every load.
 */
export function cachePolicy(pathname: string): string {
  if (pathname.startsWith(HASHED_ASSET_PREFIX)) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname === "/" || pathname.endsWith(".html")) {
    return "no-store, must-revalidate";
  }
  // The favicon, robots.txt and friends: worth caching, not worth pinning.
  return "public, max-age=3600, must-revalidate";
}

/** Copies a response and applies our headers to it. */
export function harden(
  response: Response,
  url: URL,
  options: { nonce?: string | null; cache?: boolean } = {}
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders(url, options.nonce ?? null))) {
    headers.set(key, value);
  }
  if (options.cache !== false) headers.set("Cache-Control", cachePolicy(url.pathname));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
