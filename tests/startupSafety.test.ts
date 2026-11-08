import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { contentSecurityPolicy, cachePolicy, cspNonce, securityHeaders } from "../src/worker/lib/security.ts";
import { generatePublicId } from "../src/worker/lib/id.ts";

/*
  WHAT THESE TESTS ARE FOR

  Two release blockers, both reproduced against production before anything was
  changed, both of which presented as a completely white page that stayed white:

  1. STALE DEPLOY. A browser holding a previous deployment's index.html asked for
     a bundle hash that no longer existed. The SPA fallback answered 200 OK with
     index.html, Content-Type text/html, and the browser refused it:

       "Failed to load module script: Expected a JavaScript-or-Wasm module script
        but the server responded with a MIME type of "text/html". Strict MIME
        type checking is enforced for module scripts per HTML spec."

     React never mounted and #root stayed empty. The stale stylesheet was missing
     too, so there was no background either — hence "completely white".

  2. PERSISTED STATE. Reads of sessionStorage were neither guarded nor validated.
     With storage access refused (Safari, "Block all cookies") the accessor threw
     inside render; with a stale or corrupt value, `JSON.parse(raw) as T` parsed
     fine and threw one property access later. React 19 unmounts the entire root
     when a render throws, so both ended in the same blank page. Seven of nine
     junk payloads took out /play or /results.

  The shape of the fix is tested here; the end-to-end behaviour is driven by
  scripts/reliability-qa.mjs against a real browser, and the HTTP surface by
  scripts/security-qa.mjs against a real deployment.
*/

// --------------------------------------------------------------- cache policy

describe("cache policy", () => {
  it("pins hashed assets immutably, because that is what content addressing buys", () => {
    const policy = cachePolicy("/assets/index-D885HoEn.js");
    assert.match(policy, /immutable/);
    assert.match(policy, /max-age=31536000/);
  });

  it("never caches the shell, because a stale shell is the blank-screen bug", () => {
    // The document that names the hashed bundles is the one file that must
    // always be current. Production served it `max-age=0, must-revalidate`,
    // which permits reuse in back/forward and tab-restore paths — exactly the
    // paths an iPhone takes.
    for (const path of ["/", "/index.html"]) {
      const policy = cachePolicy(path);
      assert.match(policy, /no-store/, `${path} must not be stored`);
    }
  });

  it("does not pin anything that is not content-addressed", () => {
    // A path without a hash in it can change without its URL changing, so an
    // immutable policy on one is unrecoverable without a new hostname.
    for (const path of ["/robots.txt", "/favicon.ico", "/manifest.webmanifest"]) {
      assert.ok(!cachePolicy(path).includes("immutable"), `${path} must not be immutable`);
    }
  });
});

// ------------------------------------------------------------------ the CSP

describe("content security policy", () => {
  const https = new URL("https://football-iq.naorl.workers.dev/");
  const http = new URL("http://localhost:5173/");

  it("allows the multiplayer socket on the host it is actually served from", () => {
    // connect-src is why the policy is built per request: the socket is
    // wss://<this host>, and that differs between production, a preview and a
    // dev server. A hard-coded host would break the game off production.
    assert.match(contentSecurityPolicy(https, null), /connect-src [^;]*wss:\/\/football-iq\.naorl\.workers\.dev/);
    assert.match(contentSecurityPolicy(http, null), /connect-src [^;]*ws:\/\/localhost:5173/);
  });

  it("permits no inline script without a nonce, and no eval ever", () => {
    const withNonce = contentSecurityPolicy(https, "abc123");
    const without = contentSecurityPolicy(https, null);

    assert.match(withNonce, /script-src 'self' 'nonce-abc123'/);
    assert.ok(!withNonce.includes("unsafe-inline') script") && !/script-src[^;]*unsafe-inline/.test(withNonce));
    for (const policy of [withNonce, without]) {
      assert.ok(!policy.includes("unsafe-eval"), "unsafe-eval must never appear");
    }
  });

  it("closes the directives that are pure downside here", () => {
    const policy = contentSecurityPolicy(https, null);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /base-uri 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /form-action 'self'/);
  });

  it("serves fonts from the app itself, with no third-party font host", () => {
    // Rubik and Assistant are bundled (@fontsource-variable), so the policy
    // allows fonts from 'self' only and names no Google host.
    const policy = contentSecurityPolicy(https, null);
    assert.match(policy, /font-src 'self'/);
    assert.doesNotMatch(policy, /fonts\.(googleapis|gstatic)\.com/);
  });

  it("uses no wildcard source anywhere", () => {
    const policy = contentSecurityPolicy(https, "n");
    // `*` as a whole source, or a scheme wildcard like https:. `data:` is
    // allowed deliberately, for the inline SVG favicon and the font fallback.
    assert.ok(!/ \*( |;|$)/.test(policy), `wildcard source in policy: ${policy}`);
    assert.ok(!/(^|[; ])https:(?!\/\/)/.test(policy), `scheme wildcard in policy: ${policy}`);
  });
});

describe("csp nonce", () => {
  it("is never reused", () => {
    // A nonce an injected script can predict is not a control. 128 bits from the
    // CSRNG, fresh per response.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(cspNonce());
    assert.equal(seen.size, 500);
  });

  it("is long enough to be unguessable", () => {
    assert.ok(cspNonce().length >= 22, "a nonce shorter than 128 bits is decoration");
  });
});

// -------------------------------------------------------------- the headers

describe("security headers", () => {
  it("sends the whole set, not a subset", () => {
    const headers = securityHeaders(new URL("https://football-iq.naorl.workers.dev/"), null);
    for (const name of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "X-Frame-Options",
      "Strict-Transport-Security",
    ]) {
      assert.ok(headers[name], `${name} missing — production shipped with none of these`);
    }
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
  });

  it("withholds HSTS from plaintext, so a dev machine is not pinned to https for a year", () => {
    const headers = securityHeaders(new URL("http://localhost:5173/"), null);
    assert.ok(!("Strict-Transport-Security" in headers));
  });
});

// ------------------------------------------------------------ public ids

describe("public id generation", () => {
  // A challenge's public id is the only thing between its URL and whoever
  // guesses it, so the digits have to be uniform. `byte % 57` was not: 256 is
  // not a multiple of 57, so the first 28 characters of the alphabet came up
  // about 1.3 times as often as the rest.
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  it("emits only characters from its alphabet", () => {
    for (let i = 0; i < 200; i++) {
      for (const character of generatePublicId()) {
        assert.ok(ALPHABET.includes(character), `unexpected character ${character}`);
      }
    }
  });

  it("honours the requested length", () => {
    for (const length of [6, 8, 12, 24]) {
      assert.equal(generatePublicId(length).length, length);
    }
  });

  it("is close to uniform across the alphabet", () => {
    const counts = new Map<string, number>();
    const draws = 60_000;
    for (let i = 0; i < draws / 8; i++) {
      for (const character of generatePublicId(8)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const expected = draws / ALPHABET.length;
    for (const character of ALPHABET) {
      const seen = counts.get(character) ?? 0;
      // Generous bound: this is a bias test, not a randomness test. The old
      // modulo version skewed by ~30%, which this catches comfortably, while a
      // fair generator's sampling noise at this sample size stays well inside.
      assert.ok(
        seen > expected * 0.75 && seen < expected * 1.25,
        `${character} appeared ${seen} times, expected about ${expected} — looks biased`
      );
    }
  });

  it("does not collide in a realistic number of challenges", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generatePublicId());
    assert.equal(seen.size, 20_000);
  });
});

// ------------------------------------------------- persisted state validation

/*
  quizSession reads through safeStorage, which reads the storage globals through
  a getter so that a throwing accessor is caught rather than propagated. The
  tests below install a stand-in for that global before importing, which is why
  the import is dynamic and the module registry is re-primed per case.
*/

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function installSession(store: FakeStorage | (() => never)) {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: typeof store === "function" ? (store as () => never) : () => store,
  });
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** A minimally valid quiz — what the pages actually touch. */
const VALID_QUIZ = {
  configuration: { gameMode: "CLASSIC", questionCount: 10 },
  questions: [{ id: 1, questionHe: "שאלה", options: [] }],
  requestedCount: 10,
  availableCount: 10,
};

describe("persisted quiz state is treated as untrusted", () => {
  let session: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    session = memoryStorage();
    installSession(session);
  });

  it("round-trips a valid session", async () => {
    const { saveActiveQuiz, loadActiveQuiz } = await import("../src/client/lib/quizSession.ts");
    saveActiveQuiz({ quiz: VALID_QUIZ as never, startedAt: 1 });
    const loaded = loadActiveQuiz();
    assert.ok(loaded, "a valid session must survive the round trip");
    assert.equal(loaded.startedAt, 1);
  });

  it("treats every shape that used to crash /play and /results as absent", async () => {
    const { loadActiveQuiz, loadResult } = await import("../src/client/lib/quizSession.ts");

    // Each of these parses as JSON and then threw on the next property access.
    // The errors they produced in the browser, in order: "Cannot read properties
    // of undefined (reading 'questions')", "Cannot read properties of null
    // (reading 'questions')", "Cannot read properties of null (reading 'map')",
    // "t.answers is not iterable".
    const hostile = [
      "{",
      "null",
      "[]",
      "{}",
      "9e999",
      '"a string"',
      "undefined",
      '{"decided":"yes"}',
      '{"quiz":null}',
      '{"quiz":{}}',
      '{"quiz":{"questions":null}}',
      '{"quiz":{"questions":[null]}}',
      '{"quiz":{"questions":[{}]}}',
      '{"quiz":{"questions":[{"id":"x","options":[]}]}}',
      '{"quiz":{"questions":[],"configuration":{}},"startedAt":1}',
      JSON.stringify({ quiz: VALID_QUIZ }),
      JSON.stringify({ quiz: VALID_QUIZ, startedAt: "soon" }),
    ];

    for (const raw of hostile) {
      session.map.set("fiq_active_quiz", raw);
      session.map.set("fiq_last_result", raw);
      assert.equal(loadActiveQuiz(), null, `active quiz accepted ${raw}`);
      assert.equal(loadResult(), null, `result accepted ${raw}`);
    }
  });

  it("drops the bad value so the next load does not pay for it again", async () => {
    const { loadActiveQuiz } = await import("../src/client/lib/quizSession.ts");
    session.map.set("fiq_active_quiz", "[]");
    loadActiveQuiz();
    assert.ok(!session.map.has("fiq_active_quiz"), "a rejected value should be cleared");
  });

  it("requires answers to be iterable before the results page spreads them", async () => {
    const { loadResult } = await import("../src/client/lib/quizSession.ts");
    session.map.set(
      "fiq_last_result",
      JSON.stringify({ quiz: VALID_QUIZ, answers: "not an array", score: { total: 1 }, durationSeconds: 1 })
    );
    assert.equal(loadResult(), null);
  });

  it("returns null instead of throwing when storage access is refused", async () => {
    // Safari with "Block all cookies" throws SecurityError from the ACCESSOR,
    // before any method is called. This was the exact production failure: the
    // throw landed inside render, React unmounted the root, and /play went
    // blank with no message at all.
    installSession(() => {
      throw new Error("The operation is insecure.");
    });

    const { loadActiveQuiz, loadResult, saveActiveQuiz, clearActiveQuiz } = await import(
      "../src/client/lib/quizSession.ts"
    );

    assert.equal(loadActiveQuiz(), null);
    assert.equal(loadResult(), null);
    // Writes must be just as quiet: a browser that refuses storage still plays
    // the quiz, it just cannot survive a refresh.
    assert.doesNotThrow(() => saveActiveQuiz({ quiz: VALID_QUIZ as never, startedAt: 1 }));
    assert.doesNotThrow(() => clearActiveQuiz());
  });

  it("survives storage that reads but refuses to write, which is iOS private mode", async () => {
    installSession({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });

    const { saveActiveQuiz, loadActiveQuiz } = await import("../src/client/lib/quizSession.ts");
    assert.doesNotThrow(() => saveActiveQuiz({ quiz: VALID_QUIZ as never, startedAt: 1 }));
    assert.equal(loadActiveQuiz(), null);
  });
});
