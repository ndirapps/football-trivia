// Local-data consent.
//
// Football IQ sets no cookies and runs no analytics, so this is not a cookie
// banner in the usual sense — it is an honest switchboard for the browser
// storage the game uses. That distinction matters: a banner that claims to
// manage tracking we do not do would be theatre.
//
// Three categories:
//   essential    — the quiz you are mid-way through (sessionStorage). Cannot be
//                  switched off: without it a refresh loses the game. Cleared
//                  by the browser when the tab closes.
//   preferences  — sound on/off and this consent record itself (localStorage).
//   history      — ids of questions you have seen, so the next quiz avoids
//                  repeats (localStorage).
//
// The gating is real. `allows()` is consulted at every write site, and turning
// a category off purges its keys immediately rather than only stopping future
// writes.

export type ConsentCategory = "essential" | "preferences" | "history";

export interface ConsentState {
  /** Whether the visitor has answered the banner yet. */
  decided: boolean;
  preferences: boolean;
  history: boolean;
}

export const CONSENT_STORAGE_KEY = "fiq_privacy_v1";

/** Every localStorage/sessionStorage key the app owns, by category. */
export const KEYS_BY_CATEGORY: Record<ConsentCategory, { local: string[]; session: string[] }> = {
  // `fiq_mp_token` is the multiplayer reconnect secret. It is essential for the
  // same reason `fiq_active_quiz` is — without it, a refresh mid-game costs you
  // your seat and your score — and it lives in sessionStorage, so it is gone when
  // the tab is.
  // `fiq_account_token` is the signed-in session. Essential while it exists —
  // without it you are signed out — and it is only ever written by signing in.
  // `fiq_welcome_seen` keeps the app's first screen from coming back.
  essential: { local: ["fiq_account_token", "fiq_welcome_seen"], session: ["fiq_active_quiz", "fiq_last_result", "fiq_mp_token"] },
  preferences: { local: ["fiq_sound_enabled", "fiq_a11y_v1", "fiq_mp_name"], session: [] },
  history: { local: ["fiq_recent_questions", "fiq_mp_stats"], session: [] },
};

export const DEFAULT_CONSENT: ConsentState = { decided: false, preferences: false, history: false };

/**
 * Turns whatever is in storage into a trustworthy ConsentState.
 *
 * Anything unparseable, or from a future/foreign shape, collapses to "not yet
 * decided with nothing granted" — the safe direction. Pure, so it is unit
 * tested without a browser.
 */
export function parseConsent(raw: string | null): ConsentState {
  if (!raw) return DEFAULT_CONSENT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CONSENT;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONSENT;
  const obj = parsed as Record<string, unknown>;
  return {
    decided: obj.decided === true,
    preferences: obj.preferences === true,
    history: obj.history === true,
  };
}

/** Categories a state grants. `essential` is always present. */
export function grantedCategories(state: ConsentState): ConsentCategory[] {
  const granted: ConsentCategory[] = ["essential"];
  if (state.preferences) granted.push("preferences");
  if (state.history) granted.push("history");
  return granted;
}

/** Keys that must be purged for a transition from `before` to `after`. */
export function keysToPurge(before: ConsentState, after: ConsentState): { local: string[]; session: string[] } {
  const local: string[] = [];
  const session: string[] = [];
  for (const category of ["preferences", "history"] as const) {
    if (before[category] && !after[category]) {
      local.push(...KEYS_BY_CATEGORY[category].local);
      session.push(...KEYS_BY_CATEGORY[category].session);
    }
  }
  return { local, session };
}

/** Minimal shape we need from Storage, so the store is testable. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const noopStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** Private mode and blocked-storage browsers must not throw on access. */
function safeStorage(pick: () => StorageLike | undefined): StorageLike {
  try {
    const store = pick();
    if (!store) return noopStorage;
    // Probe: Safari in private mode throws on setItem, not on access.
    const probe = "__fiq_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return noopStorage;
  }
}

export class ConsentStore {
  private state: ConsentState;
  private listeners = new Set<(state: ConsentState) => void>();
  private local: StorageLike;
  private session: StorageLike;

  // Fields are assigned explicitly rather than declared as constructor
  // parameter properties: this module is imported directly by the Node test
  // runner, whose type-stripping loader rejects that syntax.
  constructor(local: StorageLike, session: StorageLike) {
    this.local = local;
    this.session = session;
    this.state = parseConsent(this.local.getItem(CONSENT_STORAGE_KEY));
  }

  get(): ConsentState {
    return this.state;
  }

  /** The gate every write site calls. */
  allows(category: ConsentCategory): boolean {
    if (category === "essential") return true;
    return this.state[category];
  }

  subscribe(listener: (state: ConsentState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(next: Partial<Omit<ConsentState, "decided">>) {
    const before = this.state;
    const after: ConsentState = { ...before, ...next, decided: true };

    // Withdrawing consent deletes what was stored under it, now.
    const purge = keysToPurge(before, after);
    for (const key of purge.local) this.local.removeItem(key);
    for (const key of purge.session) this.session.removeItem(key);

    this.state = after;
    // The consent record is itself strictly necessary: without it we would
    // have to re-ask on every page load, which is worse for the visitor.
    try {
      this.local.setItem(CONSENT_STORAGE_KEY, JSON.stringify(after));
    } catch {
      // Session-only consent is still honoured in memory.
    }
    this.listeners.forEach((listener) => listener(after));
  }

  acceptAll() {
    this.set({ preferences: true, history: true });
  }

  rejectOptional() {
    this.set({ preferences: false, history: false });
  }

  /** "Delete everything you hold about me" — including the consent record. */
  clearAllData() {
    for (const category of Object.values(KEYS_BY_CATEGORY)) {
      for (const key of category.local) this.local.removeItem(key);
      for (const key of category.session) this.session.removeItem(key);
    }
    this.local.removeItem(CONSENT_STORAGE_KEY);
    this.state = DEFAULT_CONSENT;
    this.listeners.forEach((listener) => listener(this.state));
  }
}

export const privacy = new ConsentStore(
  safeStorage(() => (typeof localStorage === "undefined" ? undefined : localStorage)),
  safeStorage(() => (typeof sessionStorage === "undefined" ? undefined : sessionStorage))
);
