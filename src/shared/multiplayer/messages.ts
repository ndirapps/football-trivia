// Trash-talk messages.
//
// A short, deliberately limited channel: a jibe between opponents, not a chat.
// Everything here is ephemeral — nothing is written to D1, nothing is replayed on
// reconnect, and nothing touches a score.
//
// The threat model is the same as for player names, plus one addition. A name is
// chosen once at the door and then shown as a label; a message is typed during a
// game, repeatedly, aimed at a specific opponent. So on top of the shared
// character policy there is a rate limit, a per-question ceiling, and a blocked
// list for the handful of words whose only purpose is abuse.

import { MESSAGE_MAX_LENGTH } from "./constants.ts";
import { sanitizeShortText } from "./names.ts";
import { containsBlockedLanguage } from "./moderation.ts";
import { QUICK_MESSAGE_TEXT, type QuickMessageId } from "./types.ts";

export { containsBlockedLanguage };

export type MessageRejection = "EMPTY" | "TOO_LONG" | "BLOCKED";

export interface MessageOutcome {
  text: string | null;
  rejection: MessageRejection | null;
}

/**
 * Resolves what a client asked to send into the text that may be broadcast.
 *
 * A preset is resolved from its id on the server, so the sentence on other
 * players' screens is one of ours whatever the client sent. Custom text is
 * sanitized and length-checked. Over-long text is refused rather than truncated:
 * silently cutting someone's sentence in half is worse than telling them it was
 * too long.
 */
export function resolveOutgoingMessage(input: {
  presetId?: string | null;
  text?: string | null;
}): MessageOutcome {
  if (input.presetId) {
    const preset = QUICK_MESSAGE_TEXT[input.presetId as QuickMessageId];
    return preset ? { text: preset, rejection: null } : { text: null, rejection: "EMPTY" };
  }

  if (typeof input.text !== "string") return { text: null, rejection: "EMPTY" };
  // Measured in code points, so an emoji counts as one character rather than two.
  if ([...input.text.trim()].length > MESSAGE_MAX_LENGTH) {
    return { text: null, rejection: "TOO_LONG" };
  }

  const cleaned = sanitizeShortText(input.text, MESSAGE_MAX_LENGTH);
  if (!cleaned) return { text: null, rejection: "EMPTY" };
  if (containsBlockedLanguage(cleaned)) return { text: null, rejection: "BLOCKED" };
  return { text: cleaned, rejection: null };
}
