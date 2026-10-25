// What the app shows of room chat.
//
// App Store guideline 1.2 asks an app with free-text chat between strangers for
// reporting and blocking. The app takes the other route: no free text at all.
// Its composer offers presets only, and a free-text message sent from the
// website is not shown to an app player. A preset reaches every client as its
// exact Hebrew text, which is what this matches. The website is unchanged.

import { QUICK_MESSAGES } from "../../../shared/multiplayer/types.ts";

const PRESET_TEXTS: ReadonlySet<string> = new Set(QUICK_MESSAGES.map((m) => m.textHe));

export function shouldShowMessage(text: string, native: boolean): boolean {
  return !native || PRESET_TEXTS.has(text);
}
