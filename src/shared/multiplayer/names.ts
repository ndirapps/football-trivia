// Player names.
//
// A name typed by one player is rendered on every other player's screen, so it
// is the one piece of attacker-controlled text in the whole multiplayer surface.
// React escapes it on output, but relying on that alone would mean the name is
// only safe as long as nobody ever puts it in a title attribute, an aria-label,
// a QR payload or a D1 row — so it is cleaned once, at the door, and stored
// clean.
//
// What gets removed, and why:
//   * C0/C1 control characters and zero-width marks — invisible, and a
//     zero-width joiner lets two different names render identically
//   * bidi overrides and isolates — in an RTL product these can reorder the text
//     around them, so a name could visually escape its own row and rewrite the
//     scoreboard next to it
//   * angle brackets and ampersands — defence in depth for any future sink that
//     is not JSX
//   * runs of whitespace, collapsed to one space
//
// What is deliberately KEPT: Hebrew geresh/gershayim, apostrophes and hyphens.
// They are ordinary parts of real names, and stripping them would make the
// product feel like it does not expect Hebrew speakers.

import { MAX_NAME_LENGTH, MIN_NAME_LENGTH } from "./constants.ts";
import { containsBlockedLanguage } from "./moderation.ts";

/**
 * Code points that are removed rather than rendered.
 *
 * Expressed as numeric ranges instead of a regex character class on purpose:
 * U+2028 and U+2029 are line terminators in JavaScript, so writing them into a
 * regex *literal* stops being valid syntax the moment any tool in the chain turns
 * an escape into the character it denotes. Numbers cannot be mangled that way,
 * and each range gets to say what it is for.
 */
const STRIPPED_RANGES: readonly [number, number, string][] = [
  [0x0000, 0x001f, "C0 controls"],
  [0x007f, 0x009f, "DEL and C1 controls"],
  [0x200b, 0x200f, "zero-width space/joiners, LRM and RLM"],
  [0x2028, 0x2029, "line and paragraph separators"],
  [0x202a, 0x202e, "bidi embedding and overrides"],
  [0x2060, 0x2069, "word joiner and bidi isolates"],
  [0xfeff, 0xfeff, "byte order mark"],
];

/** `<`, `>` and `&`. */
const MARKUP_CODE_POINTS = new Set([0x3c, 0x3e, 0x26]);

function isStripped(codePoint: number): boolean {
  if (MARKUP_CODE_POINTS.has(codePoint)) return true;
  for (const range of STRIPPED_RANGES) {
    if (codePoint >= range[0] && codePoint <= range[1]) return true;
  }
  return false;
}

/**
 * Applies the character policy above to any short piece of player-typed text.
 *
 * Shared by names and by trash-talk messages, so both get the same treatment and
 * there is one place where that policy lives. A message is as attacker-controlled
 * as a name and lands on the same screens.
 */
export function sanitizeShortText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;

  // Cap first, so an enormous string cannot make the server walk all of it.
  const capped = raw.slice(0, maxLength * 4);

  let kept = "";
  // for..of walks whole code points, so an astral character (an emoji in a name,
  // say) survives intact instead of losing half of a surrogate pair and turning
  // into a replacement character.
  for (const character of capped) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isStripped(codePoint)) kept += character;
  }

  const cleaned = kept.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Cleans a raw name. Returns null when nothing usable is left, which is what the
 * caller turns into an INVALID_NAME error.
 */
export function sanitizePlayerName(raw: unknown): string | null {
  const cleaned = sanitizeShortText(raw, MAX_NAME_LENGTH);
  if (cleaned === null || cleaned.length < MIN_NAME_LENGTH) return null;
  // A name is shown to strangers, so it gets the same abuse filter as a message
  // (App Store guideline 1.2).
  if (containsBlockedLanguage(cleaned)) return null;
  return cleaned;
}

/**
 * Makes a name unique within a room by suffixing a number: "נאור" becomes
 * "נאור 2" when it is taken.
 *
 * Comparison is case-insensitive and whitespace-normalized, so "Naor" and "naor"
 * are treated as the same name — two identically-reading rows in a scoreboard is
 * exactly the confusion this avoids.
 *
 * The suffix is appended inside the length limit: a 16-character name is trimmed
 * to make room rather than overflowing it.
 */
export function uniquePlayerName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map(nameKey));
  if (!used.has(nameKey(name))) return name;

  for (let n = 2; n <= 99; n++) {
    const suffix = ` ${n}`;
    const base = name.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trim();
    const candidate = `${base}${suffix}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }

  // Ninety-nine players called the same thing is past the room limit; fall back
  // to something certainly unique rather than looping forever.
  return `${name.slice(0, MAX_NAME_LENGTH - 5).trim()} ${Math.floor(Math.random() * 9000) + 1000}`;
}

/** The comparison key for "is this the same name". */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("he").replace(/\s+/g, " ").trim();
}
