// Verifying a Sign in with Apple identity token.
//
// The app gets a JWT from Apple's native sheet and hands it to us. Nothing in it
// is believed until all of this holds:
//
//   * the signature verifies (RS256) against one of Apple's published keys,
//     chosen by the token's `kid`
//   * `iss` is Apple, `aud` is this app's bundle id, `exp` has not passed
//   * `nonce` equals SHA-256 of the nonce the client generated for this sign-in.
//     The client sends Apple the hash and sends us the raw value, so a token
//     lifted from another sign-in cannot be replayed here
//
// Only `sub` is used afterwards. No library: WebCrypto does RS256 natively in
// the Worker, and a JWT is three base64url segments.

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
/** Apple keys rotate rarely; an hour of caching costs nothing and saves a fetch per sign-in. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/** Clock skew tolerated on `exp` and `iat`, in seconds. */
const LEEWAY_SECONDS = 60;

export interface AppleJwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

export type AppleKeyFetcher = () => Promise<AppleJwk[]>;

export interface VerifyOptions {
  audience: string;
  rawNonce: string;
  /** Seconds since the epoch; injectable so tests do not depend on the clock. */
  now?: number;
  getKeys?: AppleKeyFetcher;
}

export type VerifyResult =
  | { ok: true; sub: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "bad_issuer" | "bad_audience" | "expired" | "bad_nonce" };

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;

/** Apple's JWKS, cached per isolate. */
export const fetchAppleKeys: AppleKeyFetcher = async () => {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS) return cachedKeys.keys;
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) throw new Error(`apple keys: ${response.status}`);
  const body = (await response.json()) as { keys?: AppleJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
};

function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyAppleIdentityToken(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }

  const keys = await (options.getKeys ?? fetchAppleKeys)();
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: "unknown_key" };

  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "bad_signature" };

  if (payload.iss !== APPLE_ISSUER) return { ok: false, reason: "bad_issuer" };

  const audience = payload.aud;
  const audienceOk = Array.isArray(audience) ? audience.includes(options.audience) : audience === options.audience;
  if (!audienceOk) return { ok: false, reason: "bad_audience" };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_SECONDS < now) return { ok: false, reason: "expired" };

  if (typeof options.rawNonce !== "string" || options.rawNonce.length === 0) return { ok: false, reason: "bad_nonce" };
  if (payload.nonce !== (await sha256Hex(options.rawNonce))) return { ok: false, reason: "bad_nonce" };

  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, sub: payload.sub };
}
