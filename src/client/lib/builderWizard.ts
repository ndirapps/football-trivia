// The builder's model: one screen, five rows, and a rule about what may appear.
//
// THE THIRD SHAPE THIS HAS TAKEN, and the reason is worth stating once.
//
//   1. everything on one scrolling page — sixty tap targets, no idea what you
//      were deciding
//   2. an eight-step wizard — one decision per screen, which fixed the wall and
//      replaced it with a form you had to fill in before you could play
//   3. this: one compact screen, every default already valid, Start reachable
//      without touching anything
//
// Step 2 was not wrong about density; it was wrong about CEREMONY. A quiz
// builder is not a settings page, and a player who wants a game should not have
// to answer four questions to get one. So the steps collapse into rows of
// segmented controls, the defaults are a real game, and everything beyond that
// is optional.
//
// THE OTHER HALF IS WHAT IS NOT SHOWN. An option that cannot fill the quiz the
// player asked for is not offered at all — not greyed out, not annotated,
// absent. The previous build disabled such options and explained why, which is
// honest and still wrong: it turns the screen into a list of things you cannot
// have. Hiding them means every visible choice leads to a game, which is what
// makes a dead end impossible rather than merely unlikely.

import { COMPETITIONS, COUNTRIES, LEAGUE_BY_COUNTRY } from "../../shared/constants.ts";
import { MIXED_TYPE_KEY, QUESTION_TYPES, QUESTION_TYPE_BY_KEY } from "../../shared/questionTypes.ts";
import { PRESET_BY_KEY } from "../../shared/builderPresets.ts";
import type {
  AnswerMode,
  Category,
  Difficulty,
  GameMode,
  QuizConfiguration,
  Region,
} from "../../shared/types.ts";

export { PRESETS, PRESET_BY_KEY, type Preset } from "../../shared/builderPresets.ts";

/** The scope row. `ALL` plus the presets that answer most of what people want. */
export const SCOPE_ALL = "ALL";

export interface ScopeChoice {
  /** `ALL`, or a preset key from shared/builderPresets. */
  key: string;
  /** Short enough for a pill. The preset's own label is the long form. */
  labelHe: string;
}

/*
  Eight pills, in the order a Hebrew-speaking football audience would reach for
  them. "הכל" first because it is the default and the fastest route to a game;
  Israel high because this is a Hebrew-first product and its league is a core
  domain here rather than a long-tail one.

  Labels are deliberately shorter than the presets' own: "אלופות" rather than
  "ליגת האלופות", because this is a pill in a wrapped row and not a card.
*/
export const SCOPE_CHOICES: ScopeChoice[] = [
  { key: SCOPE_ALL, labelHe: "הכל" },
  { key: "top6", labelHe: "טופ 6" },
  { key: "ucl", labelHe: "אלופות" },
  { key: "wc", labelHe: "מונדיאל" },
  { key: "nations", labelHe: "נבחרות" },
  { key: "israel", labelHe: "ישראל" },
  { key: "europe", labelHe: "אירופה" },
  { key: "southamerica", labelHe: "דרום אמריקה" },
];

/**
 * Question types, split into the ones worth showing and the rest.
 *
 * Five on the main row, which is as many as fits without wrapping into a block.
 * The others are real and stay reachable behind "עוד" — a player who wants a
 * quiz of nothing but transfers can have one, but nobody has to read past
 * thirteen options to start a mixed game.
 */
export const MAIN_TYPE_KEYS = [MIXED_TYPE_KEY, "CLASSIC", "WHO_AM_I", "CAREER_PATH", "GUESS_THE_CLUB"];

export const MORE_TYPE_KEYS = QUESTION_TYPES.map((t) => t.key).filter(
  (key) => !MAIN_TYPE_KEYS.includes(key)
);

/** Short pill labels. The catalogue's own labels are the long form. */
const TYPE_SHORT_HE: Record<string, string> = {
  [MIXED_TYPE_KEY]: "מעורב",
  CLASSIC: "קלאסי",
  WHO_AM_I: "מי אני?",
  CAREER_PATH: "קריירה",
  GUESS_THE_CLUB: "נחש קבוצה",
  CLUB_CONNECTION: "חיבור",
  TRANSFERS: "העברות",
  PLAYERS: "שחקנים",
  COACHES: "מאמנים",
  TITLES: "תארים",
  UCL: "אלופות",
  NATIONAL: "נבחרות",
  CLUBS: "מועדונים",
};

export const typeLabel = (key: string): string =>
  TYPE_SHORT_HE[key] ?? QUESTION_TYPE_BY_KEY.get(key)?.labelHe ?? key;

/** Difficulties, in order, with the three most people want marked. */
export const DIFFICULTY_CHOICES: (Difficulty | "MIXED")[] = [
  "MIXED",
  "EASY",
  "NORMAL",
  "HARD",
  "EXPERT",
  "IMPOSSIBLE",
];

/**
 * The ones to emphasise visually.
 *
 * Expert and Impossible stay on the row — the full builder is where somebody
 * who wants them goes — but they are not where the eye lands first.
 */
export const DIFFICULTY_COMMON: (Difficulty | "MIXED")[] = ["MIXED", "NORMAL", "HARD"];

export const COUNT_CHOICES = [5, 10, 15, 20];

// --------------------------------------------------------------- the advanced
// picker, which exists so that geography is optional rather than compulsory.

export const SUPPORTED_CONTINENTS: { code: Region; labelHe: string }[] = [
  { code: "EUROPE", labelHe: "אירופה" },
  { code: "SOUTH_AMERICA", labelHe: "דרום אמריקה" },
  { code: "NORTH_AMERICA", labelHe: "צפון אמריקה" },
  { code: "ASIA", labelHe: "אסיה" },
  { code: "AFRICA", labelHe: "אפריקה" },
  { code: "OCEANIA", labelHe: "אוקיאניה" },
];

export const countriesIn = (continent: Region) =>
  COUNTRIES.filter((country) => country.continent === continent);

export const leagueOf = (countryCode: string): string | null =>
  LEAGUE_BY_COUNTRY[countryCode] ?? null;

/** Competitions offerable as a scope. Groups are presets, not competitions. */
export const SCOPE_COMPETITIONS = COMPETITIONS.filter((c) => c.type !== "GROUP");

export const CONTINENTAL_COMPETITIONS = COMPETITIONS.filter((c) => c.type === "CONTINENTAL");

/**
 * The competitions worth offering once a country is chosen.
 *
 * The domestic league plus the continental ones, because scope matching is AND
 * across dimensions: "Spain" + "Champions League" means Spanish clubs in
 * Europe, which is a real filter rather than a union of the two.
 */
export function competitionsForCountry(countryCode: string): string[] {
  const domestic = LEAGUE_BY_COUNTRY[countryCode];
  return [...(domestic ? [domestic] : []), ...CONTINENTAL_COMPETITIONS.map((c) => c.code)];
}

// ------------------------------------------------------------------- the state

export interface BuilderState {
  questionType: string;
  answerMode: AnswerMode;
  difficulty: Difficulty | "MIXED";
  questionCount: number;
  /** `ALL`, a preset key, or a competition code chosen in the advanced picker. */
  scope: string;
  /** Set only by the advanced picker, and only to label the pill. */
  scopeCountry: string | null;
}

/**
 * Defaults that are a real game.
 *
 * This is the one-tap requirement, as data: multiple choice because it is the
 * easiest way in for a new player, mixed on both axes because that is the broadest pool and
 * the most varied quiz, ten questions, everywhere. 14,194 questions match, so
 * Start works the moment the screen opens and nothing has to be touched.
 */
export const INITIAL_STATE: BuilderState = {
  questionType: MIXED_TYPE_KEY,
  answerMode: "MULTIPLE_CHOICE",
  difficulty: "MIXED",
  questionCount: 10,
  scope: SCOPE_ALL,
  scopeCountry: null,
};

/** Counts per option key, as the availability endpoint returns them. */
export interface Availability {
  total: number;
  types?: Record<string, number>;
  presets?: Record<string, number>;
  competitions?: Record<string, number>;
  countries?: Record<string, number>;
  continents?: Record<string, number>;
}

/**
 * Whether an option may be shown.
 *
 * THE RULE THAT PREVENTS A DEAD END. An option is offered when it can fill the
 * quiz that is currently being asked for — not when it has any questions at
 * all. Eight questions is a real pool and a useless one if ten were requested,
 * so it is absent rather than disabled.
 *
 * An UNKNOWN count is permitted, deliberately. Availability arrives a moment
 * after the screen does and can fail outright; hiding everything we have not
 * measured yet would make the builder flicker on open and empty itself if the
 * endpoint were down. Unknown means "shown", and the Start button's own count
 * is the backstop.
 */
export function isOfferable(count: number | undefined, wanted: number): boolean {
  return count === undefined || count >= wanted;
}

/**
 * The same rule, for a list whose counts have definitely arrived.
 *
 * WHY THE TWO DIFFER. A count GROUP BY only returns rows for options that have
 * questions, so an option with NONE is absent from the response rather than
 * present as a zero. On the main screen "absent" has to mean "shown", because
 * availability lands a moment after the screen does and hiding everything
 * unmeasured would make it flicker. Inside the picker the opposite is true: the
 * level is rendered only once its counts are in hand, so a missing key is not
 * "not yet", it is "none" — and the Conference League, which has no questions at
 * all, was being offered on exactly that technicality.
 */
export function isOfferableStrict(
  counts: Record<string, number> | undefined,
  key: string,
  wanted: number
): boolean {
  if (!counts) return true;
  return (counts[key] ?? 0) >= wanted;
}

/** Question types to render, in row order, given what the pool can serve. */
export function offerableTypes(
  availability: Availability | null,
  wanted: number,
  showMore: boolean
): string[] {
  const keys = showMore ? [...MAIN_TYPE_KEYS, ...MORE_TYPE_KEYS] : MAIN_TYPE_KEYS;
  return keys.filter((key) => isOfferable(availability?.types?.[key], wanted));
}

/** Scope pills to render, given what the pool can serve. */
export function offerableScopes(availability: Availability | null, wanted: number): ScopeChoice[] {
  return SCOPE_CHOICES.filter((choice) =>
    choice.key === SCOPE_ALL
      ? isOfferable(availability?.total, wanted)
      : isOfferable(availability?.presets?.[choice.key], wanted)
  );
}

/**
 * Repairs a selection that the latest counts have made unservable.
 *
 * Choices interact: asking for twenty questions can empty a type that was fine
 * at five, and picking Israel can empty a type that was fine worldwide. Without
 * this the screen would keep a selection it no longer offers — the state would
 * disagree with the UI, and Start would produce the "no questions" dead end
 * this whole pass exists to remove.
 *
 * Falls back to the mixed option on each axis, which is the widest pool there
 * is and therefore the one most likely to be servable.
 */
export function repair(state: BuilderState, availability: Availability | null): BuilderState {
  if (!availability) return state;
  let next = state;

  const typeCount = availability.types?.[state.questionType];
  if (!isOfferable(typeCount, state.questionCount) && state.questionType !== MIXED_TYPE_KEY) {
    next = { ...next, questionType: MIXED_TYPE_KEY };
  }

  if (state.scope !== SCOPE_ALL) {
    const scopeCount = PRESET_BY_KEY.has(state.scope)
      ? availability.presets?.[state.scope]
      : availability.competitions?.[state.scope];
    if (!isOfferable(scopeCount, state.questionCount)) {
      next = { ...next, scope: SCOPE_ALL, scopeCountry: null };
    }
  }

  return next;
}

/**
 * What the scope pill reads once the advanced picker has been used.
 *
 * A league chosen through the picker names its COUNTRY too — "ספרד · לה ליגה"
 * rather than "לה ליגה". The country is the thing the player drilled through to
 * get there, and a bare league name beside the quick-scope pills does not say
 * that a narrower choice was made at all.
 */
export function scopeLabel(state: BuilderState): string {
  if (state.scope === SCOPE_ALL) return "הכל";
  const preset = PRESET_BY_KEY.get(state.scope);
  if (preset) return SCOPE_CHOICES.find((c) => c.key === state.scope)?.labelHe ?? preset.labelHe;
  const competition = COMPETITIONS.find((c) => c.code === state.scope);
  const league = competition?.nameHe ?? state.scope;
  const country = state.scopeCountry
    ? COUNTRIES.find((c) => c.code === state.scopeCountry)?.nameHe
    : null;
  return country ? `${country} · ${league}` : league;
}

/** True when the scope came from the picker rather than a quick pill. */
export function isPickedLeague(state: BuilderState): boolean {
  return state.scope !== SCOPE_ALL && !PRESET_BY_KEY.has(state.scope);
}

/**
 * Turns the builder's state into the quiz query.
 *
 * The contract between the UI and the engine, and the function the Playwright
 * flows assert against — "verify the query, not just the screen" is only
 * possible because the mapping lives in one place with no React around it.
 *
 * `region` stays WORLD even for a continent, and the continent travels as its
 * COUNTRIES instead: there are only three REGION scope values in the bank, so
 * `region: "ASIA"` matched nothing and Israel was unreachable that way.
 *
 * Note what is NOT set: `preset`. A player who chose "מומחה" here asked for
 * Expert and gets it. Only the home page's one-tap games carry QUICK_START, and
 * only those get the accessible difficulty bands.
 */
export function toConfiguration(state: BuilderState): QuizConfiguration {
  const spec = state.questionType === MIXED_TYPE_KEY ? null : QUESTION_TYPE_BY_KEY.get(state.questionType);

  const base = {
    region: "WORLD" as Region,
    countries: [] as string[],
    competitions: ["ALL"] as string[],
    categories: (spec?.categories ?? []) as Category[],
    gameMode: (spec?.mode ?? "CLASSIC") as GameMode,
  };

  const preset = PRESET_BY_KEY.get(state.scope);
  if (preset) {
    if (preset.region) base.region = preset.region;
    if (preset.countries) base.countries = preset.countries;
    if (preset.competitions) base.competitions = preset.competitions;
    // A preset's categories replace the type's: somebody who picked "נבחרות"
    // after "העברות" meant national-team questions.
    if (preset.categories) base.categories = preset.categories;
  } else if (state.scope !== SCOPE_ALL) {
    // A competition from the advanced picker, optionally inside a country.
    base.competitions = [state.scope];
    if (state.scopeCountry) base.countries = [state.scopeCountry];
  }

  return {
    region: base.region,
    countries: base.countries,
    competitions: base.competitions,
    categories: base.categories,
    difficulty: state.difficulty,
    questionCount: state.questionCount as QuizConfiguration["questionCount"],
    gameMode: base.gameMode,
    answerMode: state.answerMode,
    questionType: state.questionType,
  };
}

/** The configuration the advanced picker's counts should be measured against. */
export function pickerConfiguration(state: BuilderState, country: string | null): QuizConfiguration {
  return toConfiguration({ ...state, scope: SCOPE_ALL, scopeCountry: country });
}
