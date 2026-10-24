import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { quizRoutes } from "./routes/quiz";
import { challengeRoutes } from "./routes/challenges";
import { dailyRoutes } from "./routes/daily";
import { attemptRoutes } from "./routes/attempts";
import { multiplayerRoutes } from "./routes/multiplayer";
import { healthRoutes } from "./routes/health";
import { cspNonce, harden, HASHED_ASSET_PREFIX, securityHeaders } from "./lib/security";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------- every response

/**
 * Security headers on everything, including errors and 404s.
 *
 * A header that is only present on the happy path is not a security control. It
 * runs as middleware rather than per route so a route added later cannot forget.
 * The HTML shell is the exception and handles its own headers below, because it
 * is the only response that needs a CSP nonce.
 */
/**
 * A request id on every response, and one log line for anything slow or failed.
 *
 * WHY. "The page was blank at about nine o'clock" cannot be matched against
 * anything on the server, so a browser-side failure and a server-side failure
 * were indistinguishable after the fact. The id is returned as `X-Request-Id`,
 * the client keeps the last twenty-five of them (see lib/startup.ts), and the
 * Worker logs the same value — so a failure on a device can be looked up in the
 * Worker's own record of that exact request.
 *
 * WHAT IS LOGGED: the id, method, pathname, status and duration. Not the query
 * string, not headers, not bodies, not the client address — a diagnostic that
 * records what a visitor was doing is not one worth having. Only errors and slow
 * requests are logged; logging every asset hit would bury them.
 */
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  const started = Date.now();

  await next();

  // A 101 is a WebSocket handshake: its headers belong to the protocol upgrade
  // and the Response carries the live socket, so it is left exactly as the
  // Durable Object produced it. Nothing in this file protects a socket anyway —
  // that is the room engine's job, over the socket, per message.
  if (c.res.status === 101) return;

  const url = new URL(c.req.url);
  const duration = Date.now() - started;

  c.res.headers.set("X-Request-Id", requestId);
  if (!c.res.headers.has("Content-Security-Policy")) {
    for (const [key, value] of Object.entries(securityHeaders(url, null))) {
      c.res.headers.set(key, value);
    }
  }

  if (c.res.status >= 500 || duration > 2000) {
    console.error("slow-or-failed", {
      requestId,
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      ms: duration,
    });
  }
});

/**
 * API responses are never cached.
 *
 * A quiz is random, a room summary is live, and the daily challenge rolls over
 * at midnight Israel time. An intermediary caching any of them produces a bug
 * that only reproduces for whoever is behind that intermediary. Count responses
 * opt back in explicitly, inside the route, because those genuinely are stable.
 */
app.use("/api/*", async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  if (!c.res.headers.has("Cache-Control")) {
    c.res.headers.set("Cache-Control", "no-store");
  }
});

/**
 * The native app is the one cross-origin caller.
 *
 * Capacitor serves the bundle from capacitor://localhost on iOS and
 * https://localhost on Android, so every API call from the app is cross-origin
 * and the JSON POSTs are preflighted. Those two origins, and only those, are
 * allowed: the web app is same-origin and needs nothing here. No credentials
 * are involved: the API has no cookies, and the player token travels in the URL.
 * WebSockets are not subject to CORS and are unaffected.
 */
const NATIVE_APP_ORIGINS = ["capacitor://localhost", "https://localhost"];
app.use("/api/*", cors({ origin: NATIVE_APP_ORIGINS, allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 86400 }));

app.route("/api/quiz", quizRoutes);
app.route("/api/challenges", challengeRoutes);
app.route("/api/daily", dailyRoutes);
app.route("/api/attempts", attemptRoutes);
app.route("/api/mp", multiplayerRoutes);
app.route("/api/health", healthRoutes);

// --------------------------------------------------------------------- failures

/**
 * The one place an unhandled exception turns into a response.
 *
 * Hono's default error handler returns the thrown message in the body. For a
 * route that forgot a try/catch that means a D1 error string — table names,
 * column names, sometimes a fragment of SQL — is handed to whoever sent the
 * request. This replaces all of it with a fixed shape, and keeps the detail in
 * the Worker log where it belongs.
 */
app.onError((err, c) => {
  const url = new URL(c.req.url);
  console.error("unhandled", {
    requestId: c.res?.headers?.get("X-Request-Id") ?? null,
    path: url.pathname,
    method: c.req.method,
    name: err?.name,
    message: err?.message,
  });

  if (url.pathname.startsWith("/api/")) {
    return c.json({ error: "Internal error", messageHe: "משהו השתבש אצלנו. נסו שוב." }, 500);
  }

  /**
   * A FAILURE ON AN ASSET MUST NOT BE A BLANK PAGE.
   *
   * This branch is new, and it closes a hole that routing assets through the
   * Worker opened. Before `run_worker_first`, a request for the JS bundle was
   * answered by the asset layer and could not be affected by Worker code at
   * all; now every asset request runs this file first, so a bug or a resource
   * limit in here becomes a failed bundle — which is a blank page, the exact
   * failure this whole effort is about. Trading a header policy for a new way
   * to lose the app would be a bad bargain.
   *
   * So: if the Worker itself fails while serving the shell, answer with a
   * standalone document that says so and offers a reload. It depends on no
   * bundle, no stylesheet and no JavaScript, and it carries the same background
   * colour as the app, so the worst case is a dark page with a sentence on it
   * rather than a white one with nothing.
   *
   * A hashed asset still gets a plain error: a stylesheet or a script cannot
   * usefully be replaced with prose, and index.html's boot layer is watching for
   * a script that fails to load.
   */
  if (url.pathname.startsWith(HASHED_ASSET_PREFIX)) {
    return new Response("Asset unavailable", {
      status: 503,
      headers: { ...securityHeaders(url, null), "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }

  return new Response(FALLBACK_DOCUMENT, {
    status: 503,
    headers: {
      ...securityHeaders(url, null),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
});

/**
 * The last-resort document. No bundle, no stylesheet, no script.
 *
 * Deliberately not a React route and deliberately not dependent on anything: it
 * is what gets served when the code that would normally serve the app is the
 * thing that failed. The reload is a plain link rather than a script, so it
 * works with JavaScript off and under any CSP.
 */
const FALLBACK_DOCUMENT = `<!doctype html>
<html lang="he" dir="rtl"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Football IQ</title>
<style>
html,body{margin:0;background:#0d1522;color:#f1f0ea;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
main{min-height:100vh;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:16px;padding:24px;text-align:center}
h1{margin:0;font-size:20px}p{margin:0;max-width:30ch;line-height:1.6;color:#9aa6b8;font-size:14px}
a{display:inline-block;margin-top:4px;padding:11px 22px;border-radius:999px;
background:#26c463;color:#07140b;text-decoration:none;font-weight:600}
</style></head><body><main>
<h1>לא הצלחנו לטעון את Football IQ</h1>
<p>יש תקלה זמנית אצלנו. אפשר לנסות שוב בעוד רגע.</p>
<a href="/">נסו שוב</a>
</main></body></html>`;

// ----------------------------------------------------------------------- assets

/**
 * Static assets, served by the Worker rather than past it.
 *
 * THIS FUNCTION IS THE BLANK-SCREEN FIX. The mechanism it closes, which was
 * reproduced against production before it was written:
 *
 *   1. a visitor holds index.html from deployment N (a restored iOS tab, a
 *      back/forward entry, an edge or browser cache that had not revalidated)
 *   2. that HTML asks for /assets/index-<hash N>.js
 *   3. deployment N+1 deleted that file, because the hash changed
 *   4. `not_found_handling: single-page-application` answered the missing file
 *      with 200 OK and index.html, Content-Type text/html
 *   5. the browser refuses it — "Expected a JavaScript-or-Wasm module script but
 *      the server responded with a MIME type of text/html. Strict MIME type
 *      checking is enforced for module scripts per HTML spec."
 *   6. React never mounts. #root stays empty. The stale CSS is missing too, so
 *      the page is not merely empty, it is white.
 *
 * Nothing in that chain produces an error the app can catch, which is why it
 * sat there indefinitely until the visitor happened to reload.
 *
 * So: a request under /assets/ that does not match a file gets a real 404. The
 * browser then fires an `error` event on the script element, which index.html's
 * bootstrap listens for and turns into a one-shot reload onto the current
 * shell — the recovery that used to require the visitor to think of it.
 *
 * SPA fallback still exists, for its actual purpose: /daily and /room/482731 are
 * client-side routes with no file behind them and must return the shell.
 */
async function serveAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);

  if (url.pathname.startsWith(HASHED_ASSET_PREFIX)) {
    // A missing hashed asset is a stale client, not a route. Say 404 and mean it.
    if (asset.status === 404) {
      return new Response("Not found", {
        status: 404,
        headers: { ...securityHeaders(url, null), "Cache-Control": "no-store", "Content-Type": "text/plain" },
      });
    }
    return harden(asset, url);
  }

  if (asset.status === 404) return shell(env, url);
  // A real file: index.html itself arrives here too, and needs its nonce.
  const type = asset.headers.get("Content-Type") ?? "";
  if (type.includes("text/html")) return shell(env, url);
  return harden(asset, url);
}

/**
 * The app shell, with a nonce stitched into it.
 *
 * index.html carries one inline bootstrap script — the loading shell, the
 * startup-stage tracker and the failsafe — and that script is what lets a
 * failed startup say something instead of showing a white page. Under a CSP
 * strict enough to be worth having, inline script needs a nonce, and a nonce
 * must differ per response, so the placeholder is substituted here. The file is
 * about two kilobytes; reading it as text costs nothing worth measuring.
 */
async function shell(env: Env, url: URL): Promise<Response> {
  const indexUrl = new URL("/index.html", url.origin);
  const response = await env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));

  if (!response.ok) {
    // There is no shell. Nothing the client can do with this, but it must not be
    // a white page either.
    return new Response("Application unavailable", {
      status: 503,
      headers: { ...securityHeaders(url, null), "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }

  const nonce = cspNonce();
  const html = (await response.text()).replaceAll("__CSP_NONCE__", nonce);

  return new Response(html, {
    status: 200,
    headers: {
      ...securityHeaders(url, nonce),
      "Content-Type": "text/html; charset=utf-8",
      // Never cached, anywhere. This is the document that points at the hashed
      // bundles, so a stale copy of it is the one thing that breaks startup.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}

/**
 * Anything that is not an API route is the client's business.
 *
 * API 404s stay JSON so the client's one error path keeps working; everything
 * else is a client-side route and gets the shell.
 */
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return serveAsset(c.req.raw, c.env, url);
});

export default app;

// Durable Object classes have to be exported from the Worker's entry module for
// the runtime to be able to construct them; the bindings in wrangler.jsonc refer
// to these class names.
export { RoomDurableObject } from "./durable/RoomDurableObject";
export { MatchmakerDurableObject } from "./durable/MatchmakerDurableObject";
