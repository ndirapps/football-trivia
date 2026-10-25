// Taps you feel, in the app.
//
// Driven from the same cue names as the sound layer, so every place that plays
// "correct" or "wrong" also buzzes, without a second set of call sites. Unlike
// sound, haptics ignore the mute switch: a muted phone is exactly when a tap is
// worth having. The website never loads the plugin; the app loads it lazily on
// the first cue that has a pattern.

type Pattern = "success" | "error" | "warning" | "medium" | "light" | "selection";

const PATTERNS: Partial<Record<string, Pattern>> = {
  correct: "success",
  wrong: "error",
  timeWarning: "warning",
  streak: "medium",
  matchFound: "medium",
  roundWin: "medium",
  duelVictory: "success",
  duelDefeat: "error",
  teamWin: "success",
  podium: "medium",
  select: "selection",
};

type HapticsModule = typeof import("@capacitor/haptics");
let loaded: Promise<HapticsModule> | null = null;

function isNativeApp(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

export function haptic(cue: string): void {
  const pattern = PATTERNS[cue];
  if (!pattern || !isNativeApp()) return;
  loaded ??= import("@capacitor/haptics");
  void loaded
    .then(({ Haptics, ImpactStyle, NotificationType }) => {
      switch (pattern) {
        case "success":
          return Haptics.notification({ type: NotificationType.Success });
        case "error":
          return Haptics.notification({ type: NotificationType.Error });
        case "warning":
          return Haptics.notification({ type: NotificationType.Warning });
        case "medium":
          return Haptics.impact({ style: ImpactStyle.Medium });
        case "light":
          return Haptics.impact({ style: ImpactStyle.Light });
        case "selection":
          return Haptics.selectionChanged();
      }
    })
    .catch(() => {
      /* a missing tap is never worth an error */
    });
}
