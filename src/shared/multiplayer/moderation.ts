// Moderation primitives shared by names, messages and blocking.
//
// App Store guideline 1.2: an app that shows one stranger's text to another needs
// a filter for objectionable content, a way to report it, and a way to block the
// person. Names are that kind of text (a random duel puts a stranger's chosen
// name on your screen), so the filter here guards names as well as messages, and
// `blockKeyOf` gives a client something stable to block. The reconnect token it is
// derived from lives for one app session, so a block also remembers the name, and
// the matchmaker refuses to pair a player with either.

/**
 * Obvious abuse, blocked outright.
 *
 * Deliberately short. This is not moderation — a determined person routes around
 * any word list. It catches the lazy case, which is most of it, and the length
 * limit does the rest. Matching is on a normalized, space-stripped form so
 * "f u c k" and "ffuucckk" do not slip through the gap a plain substring test
 * leaves.
 */
const BLOCKED_FRAGMENTS = [
  "fuck", "shit", "bitch", "cunt", "nigg", "faggot", "retard", "rape", "whore",
  "hitler",
  "מפגר", "זונה", "שרמוטה", "בן זונה", "תמות", "מזדיין", "כוסאמק", "כוס אמק", "היטלר",
];

/** Lowercased, de-spaced, de-duplicated-runs form used only for the block test. */
function abuseKey(text: string): string {
  const squashed = text
    .toLocaleLowerCase("he")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  // Collapse a character repeated three or more times, so "shiiiit" reads as
  // "shit" without also mangling ordinary doubled letters.
  return squashed.replace(/(.)\1{2,}/gu, "$1");
}

export function containsBlockedLanguage(text: string): boolean {
  const key = abuseKey(text);
  const deduped = key.replace(/(.)\1+/gu, "$1");
  return BLOCKED_FRAGMENTS.some((word) => {
    const needle = abuseKey(word);
    return key.includes(needle) || deduped.includes(needle.replace(/(.)\1+/gu, "$1"));
  });
}

/** How many blocked players a client may send with a matchmaking request. */
export const MAX_BLOCKED_KEYS = 50;

/**
 * A stable, public handle for a player, derived from their private reconnect
 * token, so another player can block them without ever seeing the token.
 *
 * Two independent 32-bit FNV-1a passes give 64 bits: far too short to say
 * anything useful about a random token, and long enough that two players in the
 * same queue never share one by accident. It is synchronous on purpose — the
 * room engine that publishes it is synchronous.
 */
export function blockKeyOf(token: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Accepts only well-formed keys, deduplicated and capped. */
export function parseBlockKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && /^[0-9a-f]{16}$/.test(item)) keys.add(item);
    if (keys.size >= MAX_BLOCKED_KEYS) break;
  }
  return [...keys];
}

/** The form names are compared in when blocking by name. */
export function nameBlockKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("he").replace(/\s+/g, " ").trim();
}

/** Blocked names sent with a matchmaking request: strings only, normalized, capped. */
export function parseBlockedNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && item.length <= 40) names.add(nameBlockKey(item));
    if (names.size >= MAX_BLOCKED_KEYS) break;
  }
  return [...names];
}
