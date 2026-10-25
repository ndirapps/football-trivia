// Talking to Apple on the server side: exchanging the authorization code for a
// refresh token at sign-in, and revoking it when the account is deleted.
//
// Both calls authenticate with a client secret: a short-lived ES256 JWT signed
// with the app's Sign in with Apple key (.p8). The key is a Worker secret and is
// read only here. With no key configured both calls are skipped and say so —
// sign-in still works; only the revoke-on-delete step needs it.

export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_AUDIENCE = "https://appleid.apple.com";
/** Apple allows up to six months; five minutes is all a single call needs. */
const CLIENT_SECRET_TTL_SECONDS = 300;

export interface AppleClientConfig {
  teamId: string;
  keyId: string;
  /** The .p8 file's contents, PEM. */
  privateKey: string;
  clientId: string;
}

export function appleClientConfig(
  env: { APPLE_TEAM_ID?: string; APPLE_KEY_ID?: string; APPLE_PRIVATE_KEY?: string },
  clientId: string
): AppleClientConfig | null {
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) return null;
  return { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY, clientId };
}

function base64Url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The ES256 client secret. WebCrypto's ECDSA output is already JWS's r||s form. */
export async function appleClientSecret(config: AppleClientConfig, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64Url(
    JSON.stringify({ iss: config.teamId, iat: now, exp: now + CLIENT_SECRET_TTL_SECONDS, aud: APPLE_AUDIENCE, sub: config.clientId })
  );
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(config.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

/** Authorization code -> refresh token. Null on any failure; sign-in never depends on it. */
export async function exchangeAppleCode(config: AppleClientConfig, code: string): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: await appleClientSecret(config),
    code,
    grant_type: "authorization_code",
  });
  const response = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    console.error("apple: code exchange failed", { status: response.status });
    return null;
  }
  const json = (await response.json().catch(() => null)) as { refresh_token?: unknown } | null;
  return typeof json?.refresh_token === "string" ? json.refresh_token : null;
}

/** Revokes the grant, so the app disappears from the user's Apple ID settings. */
export async function revokeAppleToken(config: AppleClientConfig, refreshToken: string): Promise<boolean> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: await appleClientSecret(config),
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  const response = await fetch(APPLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) console.error("apple: revoke failed", { status: response.status });
  return response.ok;
}
