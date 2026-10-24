// The account session token, and nothing else.
//
// Its own module so the API client can read it without importing the account
// store (which imports the API client). Essential storage: while you are signed
// in, losing it signs you out; signing out or deleting the account removes it.

import { safeLocal } from "./safeStorage";

export const ACCOUNT_TOKEN_KEY = "fiq_account_token";

export function readAccountToken(): string | null {
  return safeLocal.get(ACCOUNT_TOKEN_KEY);
}

export function writeAccountToken(token: string): void {
  safeLocal.set(ACCOUNT_TOKEN_KEY, token);
}

export function clearAccountToken(): void {
  safeLocal.remove(ACCOUNT_TOKEN_KEY);
}
