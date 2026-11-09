// Players this device has blocked (App Store guideline 1.2).
//
// Stored in localStorage as ESSENTIAL: it exists only because the player asked
// for it, it never leaves the device except as the opaque keys and names sent to
// the matchmaker, and dropping it would put a blocked stranger back in front of
// them. Blocking does three things:
//   * the matchmaker never pairs this player with the blocked one again
//   * messages and reactions from the blocked player are not shown
//   * the blocked player's name is shown as "שחקן חסום"

import { nameBlockKey } from "../../../shared/multiplayer/moderation.ts";

const KEY = "fiq_blocked_players";
const MAX = 50;

export interface BlockedPlayer {
  key: string;
  name: string;
  at: number;
}

let cache: BlockedPlayer[] | null = null;
const listeners = new Set<() => void>();

function read(): BlockedPlayer[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(raw)
      ? raw.filter((e) => e && typeof e.key === "string" && typeof e.name === "string").slice(-MAX)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: BlockedPlayer[]): void {
  cache = next.slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* kept in memory for this session */
  }
  for (const listener of listeners) listener();
}

export function blockedPlayers(): BlockedPlayer[] {
  return read();
}

export function blockPlayer(key: string, name: string): void {
  write([...read().filter((e) => e.key !== key), { key, name, at: Date.now() }]);
}

export function unblockPlayer(key: string): void {
  write(read().filter((e) => e.key !== key));
}

export function isBlocked(key: string | undefined, name?: string): boolean {
  const list = read();
  if (key && list.some((e) => e.key === key)) return true;
  if (!name) return false;
  const n = nameBlockKey(name);
  return list.some((e) => nameBlockKey(e.name) === n);
}

export function subscribeBlocklist(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the matchmaker is told, so a blocked player is never matched again. */
export function blockedForMatchmaking(): { blocked: string[]; blockedNames: string[] } {
  const list = read();
  return { blocked: list.map((e) => e.key), blockedNames: list.map((e) => e.name) };
}
