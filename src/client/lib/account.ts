// The signed-in account, from the client's side.
//
// One small store that the header, the account sheet and the profile page all
// read. Accounts exist only in the iOS app for now (Sign in with Apple's native
// sheet); everywhere else `accountsAvailable()` is false, nothing here runs, and
// the product is exactly what it was.
//
// THE NONCE. A fresh random value per sign-in. Apple is given its SHA-256 and
// puts that in the identity token; the server is given the raw value and checks
// the hash, so a token captured from some other sign-in cannot be replayed.

import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { SignInWithApple } from "@capacitor-community/apple-sign-in";
import {
  ApiError,
  deleteAccountRequest,
  fetchMe,
  mergeLocalStatsRequest,
  signInWithAppleRequest,
  signOutRequest,
  updateMe,
  type AccountStats,
  type AccountUser,
} from "./api";
import { clearAccountToken, readAccountToken, writeAccountToken } from "./accountToken";
import { readLocalStats, savedPlayerName } from "./mp/identity";

const APP_BUNDLE_ID = "com.royasraf.footballiq";
/** Apple's code for "the user closed the sheet" — not an error worth showing. */
const APPLE_CANCELED_CODES = ["1001", "ERR_CANCELED"];

export type AccountState =
  | { status: "guest" }
  | { status: "loading" }
  | { status: "signed-in"; user: AccountUser; stats: AccountStats | null };

export function accountsAvailable(): boolean {
  return Capacitor.getPlatform() === "ios";
}

let state: AccountState = readAccountToken() ? { status: "loading" } : { status: "guest" };
const listeners = new Set<() => void>();

function setState(next: AccountState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isCancel(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as Error)?.message ?? "");
  return APPLE_CANCELED_CODES.includes(code) || message.includes("1001");
}

/**
 * Runs Apple's sheet and signs in. Resolves to null when the player cancels,
 * to `{ isNew }` on success; throws an ApiError the caller can show otherwise.
 */
export async function signInWithApple(): Promise<{ isNew: boolean } | null> {
  const rawNonce = randomNonce();
  let identityToken: string;
  let authorizationCode: string;
  try {
    const { response } = await SignInWithApple.authorize({
      clientId: APP_BUNDLE_ID,
      redirectURI: "https://football-iq.invalid/auth/apple",
      nonce: await sha256Hex(rawNonce),
    });
    identityToken = response.identityToken;
    authorizationCode = response.authorizationCode;
  } catch (error) {
    if (isCancel(error)) return null;
    throw new ApiError("rejected", "ההתחברות עם Apple לא הצליחה. נסו שוב.");
  }

  const result = await signInWithAppleRequest({
    identityToken,
    authorizationCode,
    nonce: rawNonce,
    displayName: savedPlayerName(),
  });
  writeAccountToken(result.token);
  setState({ status: "signed-in", user: { displayName: result.user.displayName }, stats: result.stats });

  // The device's own duel record, offered once. The server accepts it once per
  // account, ever, so offering it on every sign-in is safe.
  const local = readLocalStats();
  if (local.played > 0) {
    try {
      const { stats } = await mergeLocalStatsRequest(local);
      if (state.status === "signed-in") setState({ ...state, stats });
    } catch {
      /* the merge is a bonus; the sign-in already succeeded */
    }
  }
  return { isNew: result.user.isNew };
}

/**
 * Loads the account behind a stored token. A 401 means the session is gone
 * (signed out elsewhere, or the account deleted), so the token goes too.
 * Any other failure keeps the token: being offline is not being signed out.
 */
export async function refreshAccount(): Promise<void> {
  if (!readAccountToken()) {
    setState({ status: "guest" });
    return;
  }
  try {
    const { user, stats } = await fetchMe();
    setState({ status: "signed-in", user, stats });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearAccountToken();
      setState({ status: "guest" });
    } else if (state.status === "loading") {
      setState({ status: "signed-in", user: { displayName: "" }, stats: null });
    }
  }
}

export async function renameAccount(displayName: string): Promise<void> {
  const { user } = await updateMe(displayName);
  if (state.status === "signed-in") setState({ ...state, user });
}

/** Ends this device's session. The local token goes even if the server cannot be reached. */
export async function signOut(): Promise<void> {
  try {
    await signOutRequest();
  } catch {
    /* the token is dropped below regardless */
  }
  clearAccountToken();
  setState({ status: "guest" });
}

/**
 * Deletes the account on the server, then forgets it here. Unlike sign-out this
 * must reach the server: the token is kept on failure so the player can retry.
 */
export async function deleteAccount(): Promise<void> {
  await deleteAccountRequest();
  clearAccountToken();
  setState({ status: "guest" });
}

if (accountsAvailable() && readAccountToken()) void refreshAccount();
