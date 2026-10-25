import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { sha256Hex, verifyAppleIdentityToken, type AppleJwk } from "../src/worker/auth/appleToken.ts";
import { bearerToken, needsTouch, newSessionToken } from "../src/worker/auth/session.ts";
import { clampLocalStats, duelOutcome, longestCorrectStreak, toStats } from "../src/worker/db/users.ts";
import { appleClientSecret } from "../src/worker/auth/appleClient.ts";

/*
  What these guard: an identity token is believed only when Apple signed it, for
  this app, recently, and for this sign-in's nonce. Every other combination must
  read as a failure with a reason, never as a user.
*/

const AUDIENCE = "com.royasraf.footballiq";
const NOW = 1_800_000_000;
const RAW_NONCE = "raw-nonce-from-the-client";

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let jwks: AppleJwk[];

function b64url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return buffer.toString("base64url");
}

async function makeToken(
  claims: Record<string, unknown>,
  options: { kid?: string; key?: CryptoKey; alg?: string } = {}
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "test-kid" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

async function validClaims(): Promise<Record<string, unknown>> {
  return {
    iss: "https://appleid.apple.com",
    aud: AUDIENCE,
    exp: NOW + 600,
    iat: NOW,
    sub: "001234.abcdef.0001",
    nonce: await sha256Hex(RAW_NONCE),
  };
}

function verify(token: string, rawNonce = RAW_NONCE) {
  return verifyAppleIdentityToken(token, { audience: AUDIENCE, rawNonce, now: NOW, getKeys: async () => jwks });
}

before(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keyPair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeyPair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  jwks = [{ kty: "RSA", kid: "test-kid", use: "sig", alg: "RS256", n: jwk.n!, e: jwk.e! }];
});

describe("verifyAppleIdentityToken", () => {
  it("accepts a token Apple signed for this app and this nonce", async () => {
    const result = await verify(await makeToken(await validClaims()));
    assert.deepEqual(result, { ok: true, sub: "001234.abcdef.0001" });
  });

  it("accepts an audience given as a list that includes the app", async () => {
    const result = await verify(await makeToken({ ...(await validClaims()), aud: ["other.app", AUDIENCE] }));
    assert.equal(result.ok, true);
  });

  it("rejects a token signed by a key Apple did not publish under that kid", async () => {
    const result = await verify(await makeToken(await validClaims(), { key: otherKeyPair.privateKey }));
    assert.deepEqual(result, { ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown kid", async () => {
    const result = await verify(await makeToken(await validClaims(), { kid: "rotated-away" }));
    assert.deepEqual(result, { ok: false, reason: "unknown_key" });
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const [h, , s] = (await makeToken(await validClaims())).split(".");
    const forged = b64url(JSON.stringify({ ...(await validClaims()), sub: "someone-else" }));
    const result = await verify(`${h}.${forged}.${s}`);
    assert.deepEqual(result, { ok: false, reason: "bad_signature" });
  });

  it("rejects a token issued to another app", async () => {
    const result = await verify(await makeToken({ ...(await validClaims()), aud: "com.example.other" }));
    assert.deepEqual(result, { ok: false, reason: "bad_audience" });
  });

  it("rejects a token not issued by Apple", async () => {
    const result = await verify(await makeToken({ ...(await validClaims()), iss: "https://evil.example" }));
    assert.deepEqual(result, { ok: false, reason: "bad_issuer" });
  });

  it("rejects an expired token, beyond the clock-skew leeway", async () => {
    const result = await verify(await makeToken({ ...(await validClaims()), exp: NOW - 120 }));
    assert.deepEqual(result, { ok: false, reason: "expired" });
  });

  it("tolerates a token that expired within the leeway", async () => {
    const result = await verify(await makeToken({ ...(await validClaims()), exp: NOW - 30 }));
    assert.equal(result.ok, true);
  });

  it("rejects a nonce that does not match this sign-in", async () => {
    const result = await verify(await makeToken(await validClaims()), "a-different-nonce");
    assert.deepEqual(result, { ok: false, reason: "bad_nonce" });
  });

  it("rejects an empty nonce even when the token carries none", async () => {
    const claims = await validClaims();
    delete claims.nonce;
    const result = await verify(await makeToken(claims), "");
    assert.deepEqual(result, { ok: false, reason: "bad_nonce" });
  });

  it("rejects anything that is not three segments, or not RS256", async () => {
    assert.deepEqual(await verify("not-a-jwt"), { ok: false, reason: "malformed" });
    assert.deepEqual(await verify(await makeToken(await validClaims(), { alg: "none" })), { ok: false, reason: "malformed" });
  });
});

describe("sessions", () => {
  it("issues 32-byte base64url tokens that never repeat", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });

  it("reads only a well-formed, bounded bearer header", () => {
    const req = (value?: string) => new Request("https://x/api/me", { headers: value ? { Authorization: value } : {} });
    assert.equal(bearerToken(req("Bearer abc")), "abc");
    assert.equal(bearerToken(req()), null);
    assert.equal(bearerToken(req("Basic abc")), null);
    assert.equal(bearerToken(req("Bearer ")), null);
    assert.equal(bearerToken(req(`Bearer ${"x".repeat(500)}`)), null);
  });

  it("touches last_seen_at at most once per UTC day", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    assert.equal(needsTouch("2026-10-24 01:00:00", now), false);
    assert.equal(needsTouch("2026-10-23 23:59:59", now), true);
  });
});

describe("stats", () => {
  it("reads a missing stats row as all zeros", () => {
    assert.deepEqual(toStats(null), {
      quizzesPlayed: 0, bestQuizScore: 0, averageQuizScore: 0, duelsPlayed: 0, duelsWon: 0, duelsLost: 0, bestStreak: 0,
    });
  });

  it("derives the average score without dividing by zero", () => {
    const row = { quizzes_played: 3, quiz_score_total: 250, best_quiz_score: 120, duels_played: 0, duels_won: 0, duels_lost: 0, best_streak: 4 };
    assert.equal(toStats(row).averageQuizScore, 83);
    assert.equal(toStats({ ...row, quizzes_played: 0, quiz_score_total: 0 }).averageQuizScore, 0);
  });
});

describe("recording", () => {
  it("measures the longest run of correct answers", () => {
    const answers = [true, true, false, true, true, true, false].map((correct) => ({ correct }));
    assert.equal(longestCorrectStreak(answers), 3);
    assert.equal(longestCorrectStreak([]), 0);
  });

  it("credits a duel: sole winner won, everyone else lost", () => {
    const game = { winnerIds: ["p1"] };
    assert.deepEqual(duelOutcome(game, "p1", true), { played: 1, won: 1, lost: 0 });
    assert.deepEqual(duelOutcome(game, "p2", true), { played: 1, won: 0, lost: 1 });
  });

  it("a tie for first is played, neither won nor lost", () => {
    assert.deepEqual(duelOutcome({ winnerIds: ["p1", "p2"] }, "p2", true), { played: 1, won: 0, lost: 0 });
  });

  it("a room that is not a duel adds nothing to the duel record", () => {
    assert.deepEqual(duelOutcome({ winnerIds: ["p1"] }, "p1", false), { played: 0, won: 0, lost: 0 });
  });
});

describe("the one-time device merge", () => {
  it("keeps the client's numbers whole, bounded and consistent", () => {
    assert.deepEqual(clampLocalStats({ played: 5, wins: 9, losses: 9, bestStreak: 4.7 }), { played: 5, wins: 5, losses: 0, bestStreak: 4 });
    assert.deepEqual(clampLocalStats({ played: -3, wins: "x" }), { played: 0, wins: 0, losses: 0, bestStreak: 0 });
    assert.equal(clampLocalStats({ played: 1e9 })?.played, 10_000);
    assert.equal(clampLocalStats(null), null);
  });
});

describe("the Apple client secret", () => {
  it("is an ES256 JWT for this team and app, verifiable with the key's public half", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;

    const jwt = await appleClientSecret(
      { teamId: "YG2T959QRY", keyId: "KEY123", privateKey: pem, clientId: "com.royasraf.footballiq" },
      NOW
    );
    const [h, p, sig] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
    assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), {
      iss: "YG2T959QRY",
      iat: NOW,
      exp: NOW + 300,
      aud: "https://appleid.apple.com",
      sub: "com.royasraf.footballiq",
    });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(`${h}.${p}`)
    );
    assert.equal(ok, true);
  });
});
