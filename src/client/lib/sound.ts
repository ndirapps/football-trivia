// Football IQ audio manager.
//
// Sounds are synthesised with the Web Audio API rather than shipped as files:
// zero extra bytes, nothing to preload, and every cue can be tuned in code.
// The palette is broadcast-like — a referee's whistle, a net ripple, a crowd
// swell — not arcade blips or casino chimes.
//
// WHAT WAS WRONG BEFORE
//
// `unlock()` bailed out on `if (this.unlocked) return`, and set `unlocked` even
// when the context came back suspended. Browsers create a SUSPENDED context
// whenever construction happens outside a user gesture — which is exactly what
// happened, because the first `play()` often ran after an `await`, by which
// point the gesture had expired. From then on `resume()` was never retried and
// the app was silent for the rest of the session, with no error anywhere.
//
// The fix has three parts:
//   1. creating the context and resuming it are separate steps; resume is
//      retried on every play and on every user gesture until it sticks
//   2. real gesture listeners arm the context on the first interaction,
//      whatever it is, rather than relying on a play() call landing inside one
//   3. the context is created lazily but resumed eagerly, so Safari and mobile
//      Chrome both get a running context from the first tap
//
// Overlap is bounded too: a compressor sits before the destination, voices are
// capped, and repeat plays of the same cue inside a short window are dropped —
// rapid clicking cannot turn into noise.

import { privacy } from "./privacy.ts";
import { haptic } from "./haptics.ts";

export type SoundName =
  | "click"
  | "select"
  | "kickoff"
  | "correct"
  | "wrong"
  | "next"
  | "streak"
  | "reveal"
  | "hint"
  | "complete"
  // ---- multiplayer ----
  // Same palette, same synthesis, same mute switch. Adding these here rather
  // than building a second audio layer for multiplayer means one place can go
  // quiet, one repeat guard, one voice cap.
  | "playerJoin"
  | "playerLeave"
  | "matchFound"
  | "countdownTick"
  | "turnStart"
  | "timeWarning"
  | "roundWin"
  | "roundLoss"
  | "leaderboardMove"
  | "teamWin"
  | "podium"
  | "duelVictory"
  | "duelDefeat"
  | "reaction";

const STORAGE_KEY = "fiq_sound_enabled";

/** Minimum gap between two plays of the same cue, in ms. */
const REPEAT_GUARD_MS = 70;

/** Hard ceiling on simultaneously scheduled voices. */
const MAX_VOICES = 14;

function readPreference(): boolean {
  if (!privacy.allows("preferences")) return true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

type Ctor = typeof AudioContext;

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = readPreference();
  private volume = 0.3;
  private listeners = new Set<(enabled: boolean) => void>();
  private lastPlayedAt = new Map<SoundName, number>();
  private voices = 0;
  private gestureBound = false;

  // ---------------------------------------------------------------- state

  isEnabled(): boolean {
    return this.enabled;
  }

  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (privacy.allows("preferences")) {
      try {
        localStorage.setItem(STORAGE_KEY, String(enabled));
      } catch {
        // Private mode — the session still honours the toggle.
      }
    }
    this.listeners.forEach((l) => l(enabled));
    if (enabled) this.arm();
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  /** 0..1. Applied immediately if the context is already up. */
  setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /** Diagnostics — used by the browser QA pass to prove audio is really live. */
  state(): { created: boolean; contextState: string | null; enabled: boolean; voices: number } {
    return {
      created: this.ctx !== null,
      contextState: this.ctx?.state ?? null,
      enabled: this.enabled,
      voices: this.voices,
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Attaches one-time gesture listeners. Safe to call repeatedly and before
   * the user has done anything.
   */
  bindGestures() {
    if (this.gestureBound || typeof window === "undefined") return;
    this.gestureBound = true;
    const arm = () => this.arm();
    // `pointerdown` covers mouse, pen and touch; `touchstart` is the belt and
    // braces for older iOS; `keydown` covers keyboard-only players.
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("touchstart", arm, { passive: true });
    window.addEventListener("keydown", arm);
  }

  /**
   * Creates the context if needed and resumes it if it is suspended.
   *
   * Both halves run on every call. That is the whole point: a context created
   * outside a gesture comes back suspended, and the only way to revive it is to
   * call resume() from inside a later one.
   *
   * `allowCreate` is false for calls that are not user-initiated. Constructing
   * a context outside a gesture yields a suspended one AND logs a console
   * warning in Chrome, so cues fired from an effect (the kickoff whistle on
   * mount) wait for the context the first gesture will make instead.
   */
  arm(allowCreate = true): void {
    if (typeof window === "undefined") return;

    if (!this.ctx) {
      if (!allowCreate) return;
      try {
        const Ctor: Ctor | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
        if (!Ctor) return;

        const ctx = new Ctor();
        const master = ctx.createGain();
        master.gain.value = this.volume;

        // Keeps overlapping cues from clipping, which is what makes layered
        // synth audio sound cheap.
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.knee.value = 22;
        compressor.ratio.value = 9;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.2;

        master.connect(compressor);
        compressor.connect(ctx.destination);

        this.ctx = ctx;
        this.master = master;
      } catch {
        this.ctx = null;
        this.master = null;
        return;
      }
    }

    if (this.ctx.state !== "running") {
      void this.ctx.resume().catch(() => {});
    }
  }

  // ------------------------------------------------------------ primitives

  private track(stopAt: number) {
    this.voices++;
    const ms = Math.max(0, (stopAt - (this.ctx?.currentTime ?? 0)) * 1000) + 60;
    window.setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
    }, ms);
  }

  private tone(opts: {
    freq: number;
    type?: OscillatorType;
    start?: number;
    duration?: number;
    gain?: number;
    sweepTo?: number;
  }) {
    if (!this.ctx || !this.master || this.voices >= MAX_VOICES) return;
    const { freq, type = "sine", start = 0, duration = 0.18, gain = 0.6, sweepTo } = opts;
    const t0 = this.ctx.currentTime + start;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + duration);

    // Short attack, exponential release — a soft mallet rather than a beep.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    this.track(t0 + duration);
  }

  /** Filtered noise — a crowd swell, a net ripple, or the air in a whistle. */
  private noise(opts: {
    start?: number;
    duration?: number;
    gain?: number;
    freq?: number;
    q?: number;
    type?: BiquadFilterType;
  }) {
    if (!this.ctx || !this.master || this.voices >= MAX_VOICES) return;
    const { start = 0, duration = 0.5, gain = 0.25, freq = 900, q = 0.9, type = "bandpass" } = opts;
    const t0 = this.ctx.currentTime + start;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + duration * 0.3);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
    this.track(t0 + duration);
  }

  /**
   * A referee's whistle: two detuned high tones warbling against each other,
   * over a band of air. That beat between the tones is what makes a whistle
   * sound like a whistle rather than a tone generator.
   */
  private whistle(opts: { start?: number; duration?: number; gain?: number } = {}) {
    const { start = 0, duration = 0.34, gain = 0.3 } = opts;
    this.tone({ freq: 2350, type: "sine", start, duration, gain });
    this.tone({ freq: 2480, type: "sine", start, duration, gain: gain * 0.8 });
    this.noise({ start, duration: duration * 0.9, gain: gain * 0.28, freq: 2400, q: 6 });
  }

  // ----------------------------------------------------------------- play

  play(name: SoundName) {
    // Before the mute check on purpose: a tap is felt even on a silent phone.
    haptic(name);
    if (!this.enabled) return;

    // Drop a repeat of the same cue fired within the guard window, so a burst
    // of clicks is one sound rather than a pile-up.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const last = this.lastPlayedAt.get(name) ?? -Infinity;
    if (now - last < REPEAT_GUARD_MS) return;
    this.lastPlayedAt.set(name, now);

    // Never constructs a context: only a gesture may do that. If one already
    // exists but has been suspended, this revives it.
    this.arm(false);
    if (!this.ctx || this.ctx.state !== "running") return;

    try {
      switch (name) {
        case "click":
          this.tone({ freq: 520, type: "triangle", duration: 0.055, gain: 0.2 });
          break;

        case "select":
          // A touch brighter than click, so choosing feels different from tapping.
          this.tone({ freq: 660, type: "triangle", duration: 0.06, gain: 0.22 });
          this.tone({ freq: 990, type: "sine", start: 0.04, duration: 0.07, gain: 0.12 });
          break;

        case "kickoff":
          // Whistle, then the thud of the first touch.
          this.whistle({ duration: 0.4, gain: 0.32 });
          this.tone({ freq: 150, type: "sine", start: 0.4, duration: 0.16, gain: 0.5, sweepTo: 70 });
          this.noise({ start: 0.4, duration: 0.26, gain: 0.14, freq: 320, q: 0.7 });
          break;

        case "correct":
          // Rising third, then the net taking the ball.
          this.tone({ freq: 523.25, type: "triangle", duration: 0.15, gain: 0.46 });
          this.tone({ freq: 659.25, type: "triangle", start: 0.085, duration: 0.19, gain: 0.42 });
          this.tone({ freq: 783.99, type: "sine", start: 0.16, duration: 0.28, gain: 0.32 });
          this.noise({ start: 0.05, duration: 0.5, gain: 0.09, freq: 1500, q: 0.6 });
          break;

        case "wrong":
          // Low, short, unpunishing — a miss, not a buzzer.
          this.tone({ freq: 220, type: "sine", duration: 0.2, gain: 0.36, sweepTo: 150 });
          this.tone({ freq: 164, type: "sine", start: 0.055, duration: 0.24, gain: 0.26 });
          break;

        case "next":
          this.tone({ freq: 380, type: "sine", duration: 0.09, gain: 0.22, sweepTo: 520 });
          break;

        case "reveal":
          this.tone({ freq: 440, type: "sine", duration: 0.13, gain: 0.26, sweepTo: 330 });
          break;

        case "hint":
          this.tone({ freq: 880, type: "sine", duration: 0.09, gain: 0.2 });
          break;

        case "streak":
          [659.25, 783.99, 987.77].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: i * 0.065, duration: 0.17, gain: 0.36 })
          );
          this.noise({ start: 0.04, duration: 0.38, gain: 0.07, freq: 2000, q: 0.5 });
          break;

        case "complete":
          // Full time: the long whistle, then a short fanfare over the crowd.
          this.whistle({ duration: 0.6, gain: 0.3 });
          [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: 0.55 + i * 0.095, duration: 0.28, gain: 0.36 })
          );
          this.noise({ start: 0.5, duration: 1.1, gain: 0.11, freq: 1100, q: 0.4 });
          break;

        // ----------------------------------------------------- multiplayer

        case "playerJoin":
          // A stud landing on the turf, then a small upward note: somebody is in.
          this.tone({ freq: 180, type: "sine", duration: 0.09, gain: 0.3, sweepTo: 120 });
          this.tone({ freq: 587.33, type: "triangle", start: 0.06, duration: 0.13, gain: 0.2 });
          break;

        case "playerLeave":
          this.tone({ freq: 392, type: "sine", duration: 0.14, gain: 0.2, sweepTo: 262 });
          break;

        case "matchFound":
          // Two studs meeting: a low impact under a bright rising pair.
          this.tone({ freq: 140, type: "sine", duration: 0.18, gain: 0.44, sweepTo: 70 });
          this.noise({ duration: 0.3, gain: 0.16, freq: 420, q: 0.6 });
          [659.25, 987.77].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: 0.1 + i * 0.09, duration: 0.22, gain: 0.34 })
          );
          break;

        case "countdownTick":
          // Deliberately dry and unpitched-sounding, so three of them read as a
          // count rather than as a tune.
          this.tone({ freq: 740, type: "square", duration: 0.05, gain: 0.16 });
          break;

        case "turnStart":
          // The referee pointing: a short whistle, no thud after it.
          this.whistle({ duration: 0.2, gain: 0.24 });
          break;

        case "timeWarning":
          // Two urgent beats. Warm rather than alarming — a nudge, not a siren.
          [0, 0.17].forEach((start) =>
            this.tone({ freq: 880, type: "triangle", start, duration: 0.1, gain: 0.24 })
          );
          break;

        case "roundWin":
          this.tone({ freq: 659.25, type: "triangle", duration: 0.14, gain: 0.34 });
          this.tone({ freq: 880, type: "triangle", start: 0.09, duration: 0.2, gain: 0.3 });
          this.noise({ start: 0.05, duration: 0.42, gain: 0.08, freq: 1600, q: 0.5 });
          break;

        case "roundLoss":
          // The crossbar: a hard, short ring that goes nowhere.
          this.tone({ freq: 330, type: "square", duration: 0.07, gain: 0.2 });
          this.tone({ freq: 247, type: "sine", start: 0.05, duration: 0.2, gain: 0.2, sweepTo: 180 });
          break;

        case "leaderboardMove":
          // A single sliding note — a row changing places.
          this.tone({ freq: 440, type: "sine", duration: 0.13, gain: 0.16, sweepTo: 660 });
          break;

        case "teamWin":
          // A crowd behind a broad, held chord.
          [392, 493.88, 587.33].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: i * 0.05, duration: 0.5, gain: 0.3 })
          );
          this.noise({ start: 0.05, duration: 1.2, gain: 0.13, freq: 900, q: 0.4 });
          break;

        case "podium":
          // A rising arpeggio under a long crowd swell: third, second, first.
          [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: i * 0.13, duration: 0.34, gain: 0.32 })
          );
          this.noise({ duration: 1.6, gain: 0.12, freq: 1000, q: 0.35 });
          break;

        case "duelVictory":
          this.whistle({ duration: 0.45, gain: 0.28 });
          [523.25, 659.25, 1046.5].forEach((f, i) =>
            this.tone({ freq: f, type: "triangle", start: 0.4 + i * 0.11, duration: 0.3, gain: 0.36 })
          );
          this.noise({ start: 0.4, duration: 0.9, gain: 0.1, freq: 1200, q: 0.4 });
          break;

        case "duelDefeat":
          // Falling, brief, and not miserable about it.
          [523.25, 415.3, 329.63].forEach((f, i) =>
            this.tone({ freq: f, type: "sine", start: i * 0.11, duration: 0.26, gain: 0.24 })
          );
          break;

        case "reaction":
          this.tone({ freq: 1046.5, type: "sine", duration: 0.06, gain: 0.14 });
          break;
      }
    } catch {
      // Audio is decorative; never let it surface as an error.
    }
  }
}

export const sound = new AudioManager();
