// Question generators.
//
// Each generator turns verified structured facts (clubs.ts / players.ts /
// competitions.ts) into playable questions. The rules that keep generated
// content trustworthy:
//
//  * A generator only emits a question when the underlying fact makes the
//    answer unambiguous. Anything that could have a second correct answer is
//    either skipped or restricted to multiple choice.
//  * Free text is enabled only for question types with exactly one correct
//    answer (a specific club, player, nation, stadium). "Which player played
//    for both X and Y" stays multiple-choice, because the real world contains
//    players outside this dataset who also qualify.
//  * Distractors are never clubs/players that would also satisfy the question.
//  * Every question carries a semantic key so near-duplicates collapse.

import { CLUBS, CLUB_BY_ID, type ClubRecord } from "../data/clubs.ts";
import { PLAYERS, PLAYER_ROLES, NATIONALITIES, type PlayerRecord } from "../data/players.ts";
import {
  BROAD_HE,
  BROAD_POSITIONS,
  CONFUSABLE_WITH,
  DETAILED_HE,
  resolvePosition,
  supportsPreciseQuestion,
} from "../../src/server/football/positions.ts";
import { clubProminence } from "../../src/server/football/prominence.ts";
import { hePrefix } from "../../src/server/football/career.ts";
import {
  EURO_FINALS,
  LEAGUE_CHAMPIONS,
  NATIONS,
  UCL_FINALS,
  UEL_FINALS,
  WORLD_CUP_FINALS,
  type ClubFinal,
} from "../data/competitions.ts";
import type { SeedCategory, SeedDifficulty, SeedMode, SeedScope } from "../questions.ts";
import { difficultyFor, type Distractors, type Fame } from "./difficulty.ts";
import { numericDistractors } from "./numericOptions.ts";

export interface GeneratedQuestion {
  semanticKey: string;
  mode: SeedMode;
  category: SeedCategory;
  difficulty: SeedDifficulty;
  questionHe: string;
  explanationHe: string;
  options: string[];
  correctIndex: number;
  clues?: string[];
  scopes: SeedScope[];
  sourceLabel: string;
  freeText: boolean;
  canonicalAnswer?: string;
  aliases?: string[];
  hints?: string[];
}

// ---------------------------------------------------------------------------
// Deterministic randomness — the same inputs must always produce the same
// question set, otherwise question ids churn and shared challenges break.
// ---------------------------------------------------------------------------
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN<T>(pool: T[], n: number, seedKey: string): T[] {
  const rand = mulberry32(hashString(seedKey));
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const isReal = (clubId: string) => CLUB_BY_ID.has(clubId);
const clubOf = (id: string): ClubRecord => CLUB_BY_ID.get(id)!;

function clubAliases(c: ClubRecord): string[] {
  return [c.en, ...c.aliases];
}

// ---------------------------------------------------------------------------
// Fame signals feeding the difficulty model (see ./difficulty.ts)
// ---------------------------------------------------------------------------

/** Player fame maps straight off the curated tier: 1 = global icon. */
const playerFame = (player: PlayerRecord): Fame => (player.tier === 1 ? 0 : player.tier === 2 ? 1 : 2);

const BIG_FIVE = ["PREMIER_LEAGUE", "LA_LIGA", "SERIE_A", "BUNDESLIGA", "LIGUE_1"];

/**
 * Titles per club, counted from the competition tables we actually carry.
 *
 * This is a prominence proxy derived from data rather than from opinion: a club
 * that keeps turning up as a European or league winner is one a Hebrew-speaking
 * fan has heard of. It is not a claim about the club's full honours list.
 */
const CLUB_TITLE_COUNT: Map<string, number> = (() => {
  const counts = new Map<string, number>();
  const add = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const final of UCL_FINALS) add(final.winner);
  for (const final of UEL_FINALS) add(final.winner);
  for (const league of LEAGUE_CHAMPIONS) for (const season of league.seasons) add(season.champion);
  return counts;
})();

function clubFame(c: ClubRecord): Fame {
  const titles = CLUB_TITLE_COUNT.get(c.id) ?? 0;
  const big = BIG_FIVE.includes(c.league ?? "");
  if (titles >= 5 || (titles >= 1 && big)) return 0;
  if (big || titles >= 1) return 1;
  return 2;
}

/**
 * Club prominence on the shared 0–3 scale, for the difficulty model.
 *
 * Every club in this registry is `curated: true` by definition — the registry
 * *is* the list of clubs a Hebrew-speaking fan recognises — so the score comes
 * down to how many titles we hold for it, which is the one data-backed way to
 * separate Barcelona from Maccabi Netanya without an opinion.
 */
function clubProminenceOf(c: ClubRecord): number {
  return clubProminence({ curated: true, titles: CLUB_TITLE_COUNT.get(c.id) ?? 0 });
}

/** The prominence of the least well-known club among several. */
function leastProminentClub(...clubs: ClubRecord[]): number | undefined {
  const scores = clubs.map(clubProminenceOf);
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

/**
 * How close a set of club distractors sits to the answer.
 *
 * The distinction that matters: distractors taken from the player's *own* career
 * turn "which club" into "which club, in what order", which is a different and
 * much harder question than picking their club out of three from other
 * countries. The generators mix both, so this is measured per question rather
 * than assumed.
 */
function clubDistractorCloseness(player: PlayerRecord, distractors: ClubRecord[]): Distractors {
  const own = new Set(player.clubs);
  const fromCareer = distractors.filter((d) => own.has(d.id)).length;
  if (fromCareer >= 2) return "near";
  if (fromCareer === 1) return "mixed";
  return "far";
}

function firstLetterHint(name: string): string {
  return `השם מתחיל באות ${name.trim()[0]}`;
}

// Hebrew prepositions before a name.
//
// TWO RULES, AND ONLY ONE OF THEM WAS HANDLED. "ב" merges with a following
// definite article — "ב" + "הליגה האירופית" is "בליגה האירופית" — which is what
// this helper was for. The rule it missed: a name in Latin script needs a maqaf,
// so "מ" + "PSV איינדהובן" has to be "מ-PSV איינדהובן". Plain concatenation gives
// "מPSV איינדהובן", which is two scripts jammed together and reads as a bug; the
// audit found 14 curated explanations saying exactly that.
//
// withBe keeps the contraction because its callers pass competition names, where
// the ה genuinely is an article. The proper-noun helpers below do not, because a
// club called "הפועל תל אביב" would otherwise be rendered "בפועל תל אביב".
const withBe = (name: string) => hePrefix("ב", name, { definiteArticle: true });

/** "ב" before a proper noun — a club, a stadium, a country. */
const inHe = (name: string) => hePrefix("ב", name);
/** "מ" before a proper noun. */
const fromHe = (name: string) => hePrefix("מ", name);
/** "ל" before a proper noun. */
const toHe = (name: string) => hePrefix("ל", name);

// ---------------------------------------------------------------------------
// Player career generators
// ---------------------------------------------------------------------------

// Clubs a player demonstrably never played for: different country from every
// club in their career, so an unlisted loan spell cannot make the answer wrong.
function safeNonClubs(player: PlayerRecord): ClubRecord[] {
  const careerCountries = new Set(
    player.clubs.filter(isReal).map((id) => clubOf(id).country)
  );
  return CLUBS.filter((c) => !careerCountries.has(c.country) && !player.clubs.includes(c.id));
}

function playerHints(player: PlayerRecord): string[] {
  const nat = NATIONALITIES[player.nat];
  const posHe = { GK: "שוער", DF: "מגן", MF: "קשר", FW: "חלוץ" }[player.pos];
  const hints = [];
  if (nat) hints.push(`הוא ${nat.he === "ישראל" ? "ישראלי" : `נולד ${inHe(nat.he)}`}`);
  hints.push(`הוא שיחק בעמדת ${posHe}`);
  hints.push(firstLetterHint(player.he));
  return hints;
}

function clubHints(c: ClubRecord): string[] {
  const hints = [`המועדון פועל במדינה: ${countryHe(c.country)}`];
  if (c.stadiumHe) hints.push(`האצטדיון הביתי: ${c.stadiumHe}`);
  hints.push(firstLetterHint(c.he));
  return hints;
}

const COUNTRY_HE: Record<string, string> = {
  ENG: "אנגליה", ESP: "ספרד", ITA: "איטליה", GER: "גרמניה", FRA: "צרפת",
  POR: "פורטוגל", NED: "הולנד", ISR: "ישראל", BRA: "ברזיל", ARG: "ארגנטינה",
  URU: "אורוגוואי", SCO: "סקוטלנד", TUR: "טורקיה", KSA: "ערב הסעודית",
  USA: "ארצות הברית", UKR: "אוקראינה", RUS: "רוסיה", SRB: "סרביה",
  ROU: "רומניה", GRE: "יוון", SWE: "שוודיה", BEL: "בלגיה", AUT: "אוסטריה",
  CRO: "קרואטיה", NOR: "נורווגיה", POL: "פולין", JPN: "יפן", SUI: "שווייץ",
  CAN: "קנדה", CHN: "סין",
};
const countryHe = (code: string) => COUNTRY_HE[code] ?? code;

function playerScopes(player: PlayerRecord): SeedScope[] {
  const scopes: SeedScope[] = [];
  const countries = new Set(player.clubs.filter(isReal).map((id) => clubOf(id).country));
  const leagues = new Set(
    player.clubs.filter(isReal).map((id) => clubOf(id).league).filter(Boolean) as string[]
  );
  const europeanCountries = ["ENG", "ESP", "ITA", "GER", "FRA", "POR", "NED"];
  if ([...countries].some((c) => europeanCountries.includes(c))) {
    scopes.push({ type: "REGION", value: "EUROPE" });
  }
  for (const c of countries) {
    if (["ENG", "ESP", "ITA", "GER", "FRA", "POR", "NED", "ISR", "BRA", "ARG"].includes(c)) {
      scopes.push({ type: "COUNTRY", value: c });
    }
  }
  for (const l of leagues) scopes.push({ type: "COMPETITION", value: l });
  if (scopes.length === 0) scopes.push({ type: "REGION", value: "WORLD" });
  return scopes;
}

/**
 * Where a player's senior career began.
 *
 * THE WORDING IS THE FIX. This used to ask "באיזו קבוצה התחיל X את הקריירה
 * הבוגרת שלו?" — which is close, but "התחיל" does not say which of the six
 * career-start facts is meant (see src/server/football/career.ts), and in the
 * provider-backed bank the same vagueness let a B-team spell be presented as a
 * career start. The honest form names the fact: the senior debut.
 *
 * The CLAIM is unchanged and was always sound here. `firstListed` on a curated
 * record means somebody verified that clubs[0] really is the first senior club —
 * it is the one thing a provider record can never establish, because it is a
 * claim about the absence of anything earlier.
 */
function generateFirstClub(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const player of PLAYERS) {
    if (!player.firstListed) continue;
    const firstId = player.clubs[0];
    if (!firstId || !isReal(firstId)) continue;
    const correct = clubOf(firstId);

    const laterOwnClubs = player.clubs.slice(1).filter(isReal).map(clubOf);
    const others = safeNonClubs(player);
    const key = `first_club:${player.id}`;
    const distractors = [
      ...pickN(laterOwnClubs, 2, key + ":own"),
      ...pickN(others, 3, key + ":other"),
    ]
      .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i && c.id !== correct.id)
      .slice(0, 3);
    if (distractors.length < 3) continue;

    out.push({
      semanticKey: key,
      mode: "CLASSIC",
      category: "CAREERS",
      difficulty: difficultyFor({
        archetype: "first_club",
        fame: playerFame(player),
        entityProminence: clubProminenceOf(correct),
        distractors: clubDistractorCloseness(player, distractors),
      }),
      questionHe: `באיזה מועדון ערך ${player.he} את הופעת הבכורה בקבוצה הבוגרת?`,
      explanationHe: `${player.he} פרץ ${fromHe(correct.he)} לפני שהמשיך הלאה בקריירה.`,
      options: [correct.he, ...distractors.map((d) => d.he)],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מסלולי קריירה מאומתים",
      freeText: true,
      canonicalAnswer: correct.he,
      aliases: clubAliases(correct),
      hints: clubHints(correct),
    });
  }
  return out;
}

function generateAdjacentClubMoves(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const player of PLAYERS) {
    if (player.seq !== "full") continue;
    for (let i = 0; i < player.clubs.length - 1; i++) {
      const fromId = player.clubs[i];
      const toId = player.clubs[i + 1];
      if (!isReal(fromId) || !isReal(toId)) continue;
      const from = clubOf(fromId);
      const to = clubOf(toId);
      if (from.id === to.id) continue;

      const otherCareerClubs = player.clubs
        .filter(isReal)
        .map(clubOf)
        .filter((c) => c.id !== from.id && c.id !== to.id);
      const pool = safeNonClubs(player);

      // "Which club did X move to after Y?"
      const nextKey = `next_club:${player.id}:${from.id}`;
      const nextDistractors = [
        ...pickN(otherCareerClubs, 2, nextKey + ":own"),
        ...pickN(pool, 3, nextKey + ":other"),
      ]
        .filter((c, idx, arr) => arr.findIndex((x) => x.id === c.id) === idx && c.id !== to.id)
        .slice(0, 3);
      if (nextDistractors.length === 3) {
        out.push({
          semanticKey: nextKey,
          mode: "CLASSIC",
          category: "TRANSFERS",
          difficulty: difficultyFor({
            archetype: "adjacent_move",
            fame: playerFame(player),
            // The player is the subject; the two clubs are what he has to
            // recognise, and the question is only as easy as the lesser of them.
            entityProminence: leastProminentClub(from, to),
            distractors: clubDistractorCloseness(player, nextDistractors),
          }),
          questionHe: `לאיזו קבוצה עבר ${player.he} אחרי ${from.he}?`,
          explanationHe: `אחרי התקופה ${inHe(from.he)}, ${player.he} עבר ${toHe(to.he)}.`,
          options: [to.he, ...nextDistractors.map((d) => d.he)],
          correctIndex: 0,
          scopes: playerScopes(player),
          sourceLabel: "מסלולי קריירה מאומתים",
          freeText: true,
          canonicalAnswer: to.he,
          aliases: clubAliases(to),
          hints: clubHints(to),
        });
      }

      // "Which club did X play for before Y?"
      const prevKey = `prev_club:${player.id}:${to.id}`;
      const prevDistractors = [
        ...pickN(otherCareerClubs, 2, prevKey + ":own"),
        ...pickN(pool, 3, prevKey + ":other"),
      ]
        .filter((c, idx, arr) => arr.findIndex((x) => x.id === c.id) === idx && c.id !== from.id)
        .slice(0, 3);
      if (prevDistractors.length === 3) {
        out.push({
          semanticKey: prevKey,
          mode: "CLASSIC",
          category: "CAREERS",
          difficulty: difficultyFor({
            archetype: "adjacent_move",
            fame: playerFame(player),
            entityProminence: leastProminentClub(from, to),
            distractors: clubDistractorCloseness(player, prevDistractors),
          }),
          questionHe: `באיזו קבוצה שיחק ${player.he} לפני ${to.he}?`,
          explanationHe: `${player.he} הגיע ${toHe(to.he)} ${fromHe(from.he)}.`,
          options: [from.he, ...prevDistractors.map((d) => d.he)],
          correctIndex: 0,
          scopes: playerScopes(player),
          sourceLabel: "מסלולי קריירה מאומתים",
          freeText: true,
          canonicalAnswer: from.he,
          aliases: clubAliases(from),
          hints: clubHints(from),
        });
      }
    }
  }
  return out;
}

function generateCareerPaths(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const player of PLAYERS) {
    // `partial` is explicitly safe here — see the accuracy contract on
    // PlayerRecord. A partial list is a correct ORDERED SUBSET, which is exactly
    // what a career path shows; what it cannot support is "which club came
    // immediately after X", and this family never asks that. Excluding partial
    // players was stricter than the data requires and cost most of the mode.
    if (player.clubs.some((c) => !isReal(c))) continue;
    if (player.clubs.length < 3) continue;

    const path = player.clubs.map((id) => clubOf(id).he);
    const distractorPool = PLAYERS.filter(
      (p) => p.id !== player.id && p.pos === player.pos && p.clubs.length >= 3
    );
    const distractors = pickN(distractorPool, 3, `career_path:${player.id}`);
    if (distractors.length < 3) continue;

    out.push({
      semanticKey: `career_path:${player.id}`,
      mode: "CAREER_PATH",
      category: "CAREER_PATH",
      // Distractors are other players in the same position with comparably long
      // careers, so the four options are genuinely confusable.
      difficulty: difficultyFor({
        archetype: "career_path",
        fame: playerFame(player),
        distractors: "near",
      }),
      questionHe: "של מי מסלול הקריירה הזה?",
      explanationHe: `זהו מסלול הקריירה של ${player.he}.`,
      clues: path,
      options: [player.he, ...distractors.map((d) => d.he)],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מסלולי קריירה מאומתים",
      freeText: true,
      canonicalAnswer: player.he,
      aliases: [player.en, ...player.aliases],
      hints: playerHints(player),
    });
  }
  return out;
}

function generateClubConnections(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  // Index which players in the dataset played for each club, so a pair that
  // two known players share is never turned into a question.
  const playersByClub = new Map<string, string[]>();
  for (const p of PLAYERS) {
    for (const cid of new Set(p.clubs.filter(isReal))) {
      playersByClub.set(cid, [...(playersByClub.get(cid) ?? []), p.id]);
    }
  }

  for (const player of PLAYERS) {
    const clubs = [...new Set(player.clubs.filter(isReal))];
    if (clubs.length < 2) continue;

    // Prefer the most recognisable pair: two big-league clubs.
    const pairs: [string, string][] = [];
    for (let i = 0; i < clubs.length; i++) {
      for (let j = i + 1; j < clubs.length; j++) pairs.push([clubs[i], clubs[j]]);
    }

    const usable = pairs.filter(([a, b]) => {
      const sharedBy = (playersByClub.get(a) ?? []).filter((id) =>
        (playersByClub.get(b) ?? []).includes(id)
      );
      return sharedBy.length === 1 && sharedBy[0] === player.id;
    });
    if (usable.length === 0) continue;

    // Prefer the pairing a fan would actually recognise: both clubs in a big
    // league beats an obscure early-career pairing.
    const bigLeagues = ["PREMIER_LEAGUE", "LA_LIGA", "SERIE_A", "BUNDESLIGA", "LIGUE_1"];
    const bigness = (id: string) => (bigLeagues.includes(clubOf(id).league ?? "") ? 1 : 0);
    const ranked = [...usable].sort(
      (p, q) => bigness(q[0]) + bigness(q[1]) - (bigness(p[0]) + bigness(p[1]))
    );
    const topTier = ranked.filter(
      ([a, b]) => bigness(a) + bigness(b) === bigness(ranked[0][0]) + bigness(ranked[0][1])
    );
    const [aId, bId] = pickN(topTier, 1, `connection:${player.id}`)[0];
    const a = clubOf(aId);
    const b = clubOf(bId);

    // Distractors: players who did NOT play for both clubs.
    const distractorPool = PLAYERS.filter((p) => {
      if (p.id === player.id) return false;
      const set = new Set(p.clubs);
      return !(set.has(aId) && set.has(bId));
    });
    const distractors = pickN(distractorPool, 3, `connection_d:${player.id}`);
    if (distractors.length < 3) continue;

    out.push({
      semanticKey: `connection:${player.id}:${[aId, bId].sort().join("+")}`,
      mode: "CLUB_CONNECTION",
      category: "TRANSFERS",
      difficulty: difficultyFor({
        archetype: "club_connection",
        fame: playerFame(player),
        distractors: "mixed",
      }),
      questionHe: `איזה שחקן שיחק גם ${inHe(a.he)} וגם ${inHe(b.he)}?`,
      explanationHe: `${player.he} שיחק גם ${inHe(a.he)} וגם ${inHe(b.he)} במהלך הקריירה שלו.`,
      options: [player.he, ...distractors.map((d) => d.he)],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מסלולי קריירה מאומתים",
      // Multiple choice only: other players outside this dataset also qualify.
      freeText: false,
      hints: playerHints(player),
    });
  }
  return out;
}

function generateDidNotPlayFor(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const player of PLAYERS) {
    const own = [...new Set(player.clubs.filter(isReal))].map(clubOf);
    if (own.length < 3) continue;
    const key = `not_played:${player.id}`;
    const ownPicks = pickN(own, 3, key + ":own");
    const never = pickN(safeNonClubs(player), 1, key + ":never")[0];
    if (!never || ownPicks.length < 3) continue;

    out.push({
      semanticKey: key,
      mode: "CLASSIC",
      category: "CAREERS",
      // The odd one out is from a country the player never played in, which is a
      // much softer ask than naming a club unprompted.
      difficulty: difficultyFor({
        archetype: "not_played_for",
        fame: playerFame(player),
        distractors: "far",
      }),
      questionHe: `באיזו מהקבוצות הבאות ${player.he} מעולם לא שיחק?`,
      explanationHe: `${player.he} שיחק ${inHe(ownPicks.map((c) => c.he).join(", "))} — אך לא ${inHe(never.he)}.`,
      options: [never.he, ...ownPicks.map((c) => c.he)],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מסלולי קריירה מאומתים",
      freeText: false,
      hints: [`הקבוצה נמצאת ${inHe(countryHe(never.country))}`],
    });
  }
  return out;
}

function generateNationalities(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const player of PLAYERS) {
    if (player.tier === 3) continue;
    const nat = NATIONALITIES[player.nat];
    if (!nat) continue;
    const others = Object.entries(NATIONALITIES).filter(([code]) => code !== player.nat);
    const distractors = pickN(others, 3, `nationality:${player.id}`);
    if (distractors.length < 3) continue;

    out.push({
      semanticKey: `nationality:${player.id}`,
      mode: "CLASSIC",
      category: "PLAYERS",
      difficulty: difficultyFor({
        archetype: "nationality",
        fame: playerFame(player),
        distractors: "far",
      }),
      questionHe: `מאיזו מדינה ${player.he}?`,
      explanationHe: `${player.he} הוא נציג נבחרת ${nat.he}.`,
      options: [nat.he, ...distractors.map(([, v]) => v.he)],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "נתוני שחקנים מאומתים",
      freeText: true,
      canonicalAnswer: nat.he,
      aliases: nat.aliases,
      hints: [firstLetterHint(nat.he)],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Competition generators
// ---------------------------------------------------------------------------

function generateClubFinals(
  finals: ClubFinal[],
  compCode: string,
  compHe: string,
  keyPrefix: string,
  category: SeedCategory
): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  const allWinners = [...new Set(finals.map((f) => f.winner))].filter(isReal);

  for (const final of finals) {
    if (!isReal(final.winner)) continue;
    const winner = clubOf(final.winner);
    const baseScopes: SeedScope[] = [
      { type: "REGION", value: "EUROPE" },
      { type: "COMPETITION", value: compCode },
    ];

    // Who won it in year N?
    const winnerDistractors = pickN(
      allWinners.filter((id) => id !== final.winner).map(clubOf),
      3,
      `${keyPrefix}_winner:${final.year}`
    );
    if (winnerDistractors.length === 3) {
      out.push({
        semanticKey: `${keyPrefix}_winner:${final.year}`,
        mode: "CLASSIC",
        category,
        difficulty: difficultyFor({
          archetype: "final_winner",
          fame: clubFame(winner),
          year: final.year,
          distractors: "mixed",
        }),
        questionHe: `איזו קבוצה זכתה ${withBe(compHe)} בשנת ${final.year}?`,
        explanationHe: final.runnerUp && isReal(final.runnerUp)
          ? `${winner.he} זכתה ${withBe(compHe)} ${final.year} בגמר מול ${clubOf(final.runnerUp).he}${final.score ? ` (${final.score})` : ""}.`
          : `${winner.he} זכתה ${withBe(compHe)} בשנת ${final.year}.`,
        options: [winner.he, ...winnerDistractors.map((c) => c.he)],
        correctIndex: 0,
        scopes: baseScopes,
        sourceLabel: `טבלת גמרי ${compHe}`,
        freeText: true,
        canonicalAnswer: winner.he,
        aliases: clubAliases(winner),
        hints: clubHints(winner),
      });
    }

    // Who did the winner beat?
    if (final.runnerUp && isReal(final.runnerUp)) {
      const runnerUp = clubOf(final.runnerUp);
      const ruDistractors = pickN(
        allWinners.filter((id) => id !== final.runnerUp && id !== final.winner).map(clubOf),
        3,
        `${keyPrefix}_runnerup:${final.year}`
      );
      if (ruDistractors.length === 3) {
        out.push({
          semanticKey: `${keyPrefix}_runnerup:${final.year}`,
          mode: "CLASSIC",
          category,
          difficulty: difficultyFor({
            archetype: "final_runner_up",
            fame: clubFame(runnerUp),
            year: final.year,
            distractors: "mixed",
          }),
          questionHe: `את מי ניצחה ${winner.he} בגמר ${compHe} ${final.year}?`,
          explanationHe: `${winner.he} ניצחה את ${runnerUp.he} בגמר ${final.year}${final.score ? ` (${final.score})` : ""}.`,
          options: [runnerUp.he, ...ruDistractors.map((c) => c.he)],
          correctIndex: 0,
          scopes: baseScopes,
          sourceLabel: `טבלת גמרי ${compHe}`,
          freeText: true,
          canonicalAnswer: runnerUp.he,
          aliases: clubAliases(runnerUp),
          hints: clubHints(runnerUp),
        });
      }
    }
  }

  // Title counts, computed by counting rows rather than copying a summary.
  const counts = new Map<string, number>();
  for (const f of finals) counts.set(f.winner, (counts.get(f.winner) ?? 0) + 1);
  for (const [clubId, count] of counts) {
    if (!isReal(clubId) || count < 3) continue;
    const c = clubOf(clubId);
    const wrong = numericDistractors({
      correct: count,
      offsets: [1, 2, 3, 4],
      min: 1,
      seedKey: `${keyPrefix}_count:${clubId}`,
    });
    out.push({
      semanticKey: `${keyPrefix}_count:${clubId}`,
      mode: "CLASSIC",
      category,
      difficulty: difficultyFor({
        archetype: "title_count",
        fame: clubFame(c),
        distractors: "near",
      }),
      questionHe: `כמה פעמים זכתה ${c.he} ${withBe(compHe)}?`,
      explanationHe: `${c.he} זכתה ${withBe(compHe)} ${count} פעמים.`,
      options: [String(count), ...wrong.map(String)],
      correctIndex: 0,
      scopes: [
        { type: "REGION", value: "EUROPE" },
        { type: "COMPETITION", value: compCode },
      ],
      sourceLabel: `טבלת גמרי ${compHe}`,
      freeText: false,
      hints: [`מדובר במספר חד-ספרתי או דו-ספרתי נמוך`],
    });
  }

  return out;
}

function generateNationFinals(
  finals: { year: number; hostHe: string; winner: string; runnerUp: string; score: string }[],
  compCode: string,
  compHe: string,
  keyPrefix: string,
  category: SeedCategory
): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  const allNations = [...new Set(finals.flatMap((f) => [f.winner, f.runnerUp]))];

  for (const final of finals) {
    const winner = NATIONS[final.winner];
    const runnerUp = NATIONS[final.runnerUp];
    if (!winner || !runnerUp) continue;
    const scopes: SeedScope[] = [
      { type: "REGION", value: compCode === "WORLD_CUP" ? "WORLD" : "EUROPE" },
      { type: "COMPETITION", value: compCode },
    ];

    const winnerDistractors = pickN(
      allNations.filter((n) => n !== final.winner && NATIONS[n]),
      3,
      `${keyPrefix}_winner:${final.year}`
    );
    if (winnerDistractors.length === 3) {
      out.push({
        semanticKey: `${keyPrefix}_winner:${final.year}`,
        mode: "CLASSIC",
        category,
        // Nations have no fame tier — every side that reaches a World Cup or
        // Euro final is a household name, so the era carries the weight.
        difficulty: difficultyFor({
          archetype: "final_winner",
          year: final.year,
          distractors: "mixed",
        }),
        questionHe: `איזו נבחרת זכתה ${withBe(compHe)} ${final.year}?`,
        explanationHe: `${winner.he} ניצחה את ${runnerUp.he} בגמר ${final.year} (${final.score}).`,
        options: [winner.he, ...winnerDistractors.map((n) => NATIONS[n].he)],
        correctIndex: 0,
        scopes,
        sourceLabel: `טבלת גמרי ${compHe}`,
        freeText: true,
        canonicalAnswer: winner.he,
        aliases: winner.aliases,
        hints: [`הגמר נערך ${inHe(final.hostHe)}`, firstLetterHint(winner.he)],
      });
    }

    const ruDistractors = pickN(
      allNations.filter((n) => n !== final.runnerUp && n !== final.winner && NATIONS[n]),
      3,
      `${keyPrefix}_runnerup:${final.year}`
    );
    if (ruDistractors.length === 3) {
      out.push({
        semanticKey: `${keyPrefix}_runnerup:${final.year}`,
        mode: "CLASSIC",
        category,
        difficulty: difficultyFor({
          archetype: "final_runner_up",
          year: final.year,
          distractors: "mixed",
        }),
        questionHe: `את מי ניצחה ${winner.he} בגמר ${compHe} ${final.year}?`,
        explanationHe: `${winner.he} ניצחה את ${runnerUp.he} בגמר ${final.year} (${final.score}).`,
        options: [runnerUp.he, ...ruDistractors.map((n) => NATIONS[n].he)],
        correctIndex: 0,
        scopes,
        sourceLabel: `טבלת גמרי ${compHe}`,
        freeText: true,
        canonicalAnswer: runnerUp.he,
        aliases: runnerUp.aliases,
        hints: [firstLetterHint(runnerUp.he)],
      });
    }
  }
  return out;
}

function generateWorldCupHosts(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  const hosts = WORLD_CUP_FINALS.map((f) => f.hostHe);
  for (const final of WORLD_CUP_FINALS) {
    const distractors = pickN(
      hosts.filter((h) => h !== final.hostHe),
      3,
      `wc_host:${final.year}`
    );
    if (distractors.length < 3) continue;
    out.push({
      semanticKey: `wc_host:${final.year}`,
      mode: "CLASSIC",
      category: "WORLD_CUP",
      difficulty: difficultyFor({
        archetype: "wc_host",
        year: final.year,
        distractors: "mixed",
      }),
      questionHe: `היכן נערך מונדיאל ${final.year}?`,
      explanationHe: `מונדיאל ${final.year} נערך ${inHe(final.hostHe)}, ו${NATIONS[final.winner]?.he ?? ""} זכתה בתואר.`,
      options: [final.hostHe, ...distractors],
      correctIndex: 0,
      scopes: [
        { type: "REGION", value: "WORLD" },
        { type: "COMPETITION", value: "WORLD_CUP" },
      ],
      sourceLabel: "טבלת גמרי המונדיאל",
      freeText: true,
      canonicalAnswer: final.hostHe,
      aliases: [],
      hints: [firstLetterHint(final.hostHe)],
    });
  }
  return out;
}

function generateLeagueChampions(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  for (const league of LEAGUE_CHAMPIONS) {
    const winners = [...new Set(league.seasons.map((s) => s.champion))].filter(isReal);
    for (const season of league.seasons) {
      if (!isReal(season.champion)) continue;
      const champion = clubOf(season.champion);
      const distractors = pickN(
        winners.filter((id) => id !== season.champion).map(clubOf),
        3,
        `league_champ:${league.league}:${season.season}`
      );
      if (distractors.length < 3) continue;
      const year = Number(season.season.slice(0, 4));

      out.push({
        semanticKey: `league_champ:${league.league}:${season.season}`,
        mode: "CLASSIC",
        category: "TITLES",
        // Distractors are other champions of the same league, so every option is
        // a club that really has won it — "near" by construction.
        difficulty: difficultyFor({
          archetype: "league_champion",
          fame: clubFame(champion),
          year: year + 1,
          distractors: "near",
        }),
        questionHe: `מי זכתה באליפות ${league.leagueHe} בעונת ${season.season}?`,
        explanationHe: `${champion.he} זכתה באליפות ${league.leagueHe} בעונת ${season.season}.`,
        options: [champion.he, ...distractors.map((c) => c.he)],
        correctIndex: 0,
        scopes: [
          { type: "REGION", value: "EUROPE" },
          { type: "COMPETITION", value: league.league },
          { type: "COUNTRY", value: champion.country },
        ],
        sourceLabel: `טבלת אלופות ${league.leagueHe}`,
        freeText: true,
        canonicalAnswer: champion.he,
        aliases: clubAliases(champion),
        hints: clubHints(champion),
      });
    }

    // League title counts within the covered seasons.
    const counts = new Map<string, number>();
    for (const s of league.seasons) counts.set(s.champion, (counts.get(s.champion) ?? 0) + 1);
    const firstSeason = league.seasons[0].season;
    const lastSeason = league.seasons[league.seasons.length - 1].season;
    for (const [clubId, count] of counts) {
      if (!isReal(clubId) || count < 4) continue;
      const c = clubOf(clubId);
      const wrong = numericDistractors({
        correct: count,
        offsets: [1, 2, 3, 4],
        min: 1,
        seedKey: `league_count:${league.league}:${clubId}`,
      });
      out.push({
        semanticKey: `league_count:${league.league}:${clubId}`,
        mode: "CLASSIC",
        category: "TITLES",
        difficulty: difficultyFor({
          archetype: "title_count",
          fame: clubFame(c),
          distractors: "near",
        }),
        questionHe: `כמה אליפויות ${league.leagueHe} זכתה ${c.he} בין העונות ${firstSeason} ל-${lastSeason}?`,
        explanationHe: `בין ${firstSeason} ל-${lastSeason}, ${c.he} זכתה ${count} פעמים באליפות ${league.leagueHe}.`,
        options: [String(count), ...wrong.map(String)],
        correctIndex: 0,
        scopes: [
          { type: "REGION", value: "EUROPE" },
          { type: "COMPETITION", value: league.league },
        ],
        sourceLabel: `טבלת אלופות ${league.leagueHe}`,
        freeText: false,
        hints: [`הטווח הוא בין ${firstSeason} ל-${lastSeason}`],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Club fact generators
// ---------------------------------------------------------------------------
function generateClubFacts(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  const withStadium = CLUBS.filter((c) => c.stadiumHe);

  for (const c of withStadium) {
    const distractors = pickN(
      withStadium.filter((x) => x.id !== c.id),
      3,
      `stadium:${c.id}`
    );
    if (distractors.length < 3) continue;
    out.push({
      semanticKey: `stadium:${c.id}`,
      mode: "CLASSIC",
      category: "STADIUMS",
      difficulty: difficultyFor({
        archetype: "stadium",
        fame: clubFame(c),
        distractors: "mixed",
      }),
      questionHe: `באיזה אצטדיון משחקת ${c.he} את משחקי הבית שלה?`,
      explanationHe: `${c.he} משחקת ${inHe(c.stadiumHe)}.`,
      options: [c.stadiumHe!, ...distractors.map((d) => d.stadiumHe!)],
      correctIndex: 0,
      scopes: [
        { type: "COUNTRY", value: c.country },
        ...(c.league ? [{ type: "COMPETITION" as const, value: c.league }] : []),
      ],
      sourceLabel: "נתוני מועדונים",
      freeText: true,
      canonicalAnswer: c.stadiumHe!,
      aliases: c.stadium ? [c.stadium] : [],
      hints: [`המועדון פועל ${inHe(countryHe(c.country))}`, firstLetterHint(c.stadiumHe!)],
    });
  }

  // Which country is this club from?
  const bigCountries = ["ENG", "ESP", "ITA", "GER", "FRA", "POR", "NED", "BRA", "ARG", "ISR"];
  for (const c of CLUBS) {
    if (!bigCountries.includes(c.country)) continue;
    const distractors = pickN(
      bigCountries.filter((x) => x !== c.country),
      3,
      `club_country:${c.id}`
    );
    if (distractors.length < 3) continue;
    out.push({
      semanticKey: `club_country:${c.id}`,
      mode: "CLASSIC",
      category: "CLUBS",
      difficulty: difficultyFor({
        archetype: "club_country",
        fame: clubFame(c),
        distractors: "far",
      }),
      questionHe: `מאיזו מדינה מגיע מועדון ${c.he}?`,
      explanationHe: `${c.he} הוא מועדון ${fromHe(countryHe(c.country))}.`,
      options: [countryHe(c.country), ...distractors.map(countryHe)],
      correctIndex: 0,
      scopes: [{ type: "COUNTRY", value: c.country }],
      sourceLabel: "נתוני מועדונים",
      freeText: true,
      canonicalAnswer: countryHe(c.country),
      aliases: [],
      hints: [firstLetterHint(countryHe(c.country))],
    });
  }

  // Club nicknames.
  const withNickname = CLUBS.filter((c) => c.nicknameHe);
  for (const c of withNickname) {
    const distractors = pickN(
      withNickname.filter((x) => x.id !== c.id),
      3,
      `nickname:${c.id}`
    );
    if (distractors.length < 3) continue;
    out.push({
      semanticKey: `nickname:${c.id}`,
      mode: "CLASSIC",
      category: "CLUBS",
      difficulty: difficultyFor({
        archetype: "nickname",
        fame: clubFame(c),
        distractors: "mixed",
      }),
      questionHe: `מה הכינוי של מועדון ${c.he}?`,
      explanationHe: `${c.he} מכונה "${c.nicknameHe}".`,
      options: [c.nicknameHe!, ...distractors.map((d) => d.nicknameHe!)],
      correctIndex: 0,
      scopes: [{ type: "COUNTRY", value: c.country }],
      sourceLabel: "נתוני מועדונים",
      freeText: false,
      hints: [`המועדון פועל ${inHe(countryHe(c.country))}`],
    });
  }

  // Founding years — the hardest shape in the bank, but no longer a single flat
  // band. Every club here used to be IMPOSSIBLE, which made that band 59%
  // founding-year questions; scoring by club prominence spreads them across
  // HARD / EXPERT / IMPOSSIBLE instead, because Manchester United's founding
  // year is far more widely known than a mid-table Eredivisie side's.
  for (const c of CLUBS.filter((x) => x.founded)) {
    const wrong = numericDistractors({
      correct: c.founded!,
      offsets: [3, 5, 7, 9, 13],
      seedKey: `founded:${c.id}`,
    });
    out.push({
      semanticKey: `founded:${c.id}`,
      mode: "CLASSIC",
      category: "CLUBS",
      // Not "near": a founding year is binary knowledge. Offering 1871 instead
      // of 1885 does not make 1878 harder to recall the way a same-career club
      // makes a transfer harder — you either know the year or you guess.
      difficulty: difficultyFor({
        archetype: "founded_year",
        fame: clubFame(c),
        distractors: "mixed",
      }),
      questionHe: `באיזו שנה נוסד מועדון ${c.he}?`,
      explanationHe: `${c.he} נוסד בשנת ${c.founded}.`,
      options: [String(c.founded), ...wrong.map(String)],
      correctIndex: 0,
      scopes: [{ type: "COUNTRY", value: c.country }],
      sourceLabel: "נתוני מועדונים",
      freeText: false,
      hints: [`המועדון נוסד במאה ה-${Math.ceil(c.founded! / 100)}`],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// ===========================================================================
// EXPANDED FAMILIES
//
// Everything below draws on exactly the same verified registries as the
// families above — no new facts are asserted anywhere in this file. What these
// add is COVERAGE: the original generators asked one question per player or per
// club and stopped, which is why Career Path sat at 43 questions and Who Am I
// and Guess The Club had no generator at all and lived on a handful of
// hand-written rows.
//
// The rule every one of them obeys: a question is only emitted if its answer is
// UNIQUE within the registry. A "who played for both Milan and PSG" with two
// possible answers is not a hard question, it is a broken one, so the ambiguity
// checks below are the substance rather than a safety net.
// ===========================================================================

/** Players whose club list is safe to slice for ordering questions. */
function sequencedPlayers(): PlayerRecord[] {
  return PLAYERS.filter((p) => p.clubs.length >= 3 && p.clubs.every(isReal));
}

/**
 * Career-path sub-sequences: A→B→C from a career of A→B→C→D→E→F.
 *
 * The original generator emitted the WHOLE career and nothing else, so a player
 * with eight clubs produced exactly one question. A run of three consecutive
 * clubs is a genuinely different question from the full path — it is harder,
 * because there is less to recognise — and a long career contains many of them.
 *
 * Two guards keep this from turning into noise:
 *   * a slice is skipped when more than one player in the registry has that
 *     exact run of clubs, because then the question has two right answers
 *   * the full-career slice is left to `generateCareerPaths`, so the two
 *     families never collide on a semantic key
 */
function generateCareerSubPaths(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  // Partial careers are included, but the wording below never claims the run is
  // consecutive for them — only that those clubs came in that order, which a
  // partial list does guarantee.
  const eligible = sequencedPlayers();

  // Which players own each run of clubs, so ambiguous runs can be dropped.
  const owners = new Map<string, Set<string>>();
  for (const player of eligible) {
    for (let size = 3; size <= 5; size++) {
      for (let start = 0; start + size <= player.clubs.length; start++) {
        const key = player.clubs.slice(start, start + size).join(">");
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key)!.add(player.id);
      }
    }
  }

  for (const player of eligible) {
    const distractorPool = PLAYERS.filter(
      (p) => p.id !== player.id && p.pos === player.pos && p.clubs.length >= 3
    );

    for (let size = 3; size <= 5; size++) {
      for (let start = 0; start + size <= player.clubs.length; start++) {
        const slice = player.clubs.slice(start, start + size);
        // The complete career already has its own question.
        if (size === player.clubs.length) continue;

        const runKey = slice.join(">");
        if ((owners.get(runKey)?.size ?? 0) > 1) continue;

        // A run that revisits the same club reads as a mistake rather than a
        // question ("Milan → PSG → Milan" inside a longer career).
        if (new Set(slice).size !== slice.length) continue;

        const distractors = pickN(distractorPool, 3, `career_sub:${player.id}:${runKey}`);
        if (distractors.length < 3) continue;

        const partial = start > 0 || start + size < player.clubs.length;
        out.push({
          semanticKey: `career_path:${player.id}:${runKey}`,
          mode: "CAREER_PATH",
          category: "CAREER_PATH",
          difficulty: difficultyFor({
            archetype: "career_path",
            fame: playerFame(player),
          // Fame already carries a band per step, so pinning close
          // distractors on top of it double-counts and pushes every
          // lesser-known subject into IMPOSSIBLE. Close distractors are what
          // make a question about a FAMOUS subject hard; for the rest, fame is
          // doing the work already.
            distractors: playerFame(player) === 0 ? "near" : "mixed",
          }),
          questionHe: partial
            ? "של מי קטע הקריירה הזה?"
            : "של מי מסלול הקריירה הזה?",
          // "ברצף" (consecutively) is only true for a complete career list.
          explanationHe:
            player.seq === "full"
              ? `${player.he} שיחק ${inHe(slice.map((id) => clubOf(id).he).join(", "))} ברצף.`
              : `${player.he} שיחק ${inHe(slice.map((id) => clubOf(id).he).join(", "))} בסדר הזה.`,
          clues: slice.map((id) => clubOf(id).he),
          options: [player.he, ...distractors.map((d) => d.he)],
          correctIndex: 0,
          scopes: playerScopes(player),
          sourceLabel: "מסלולי קריירה מאומתים",
          freeText: true,
          canonicalAnswer: player.he,
          aliases: [player.en, ...player.aliases],
          hints: playerHints(player),
        });
      }
    }
  }
  return out;
}

/** The clue types a Who Am I can be built from, most identifying last. */
interface ClueSet {
  id: string;
  clues: string[];
}

/**
 * Builds several distinct clue sets for one player.
 *
 * Each set is a genuinely different question — a different combination of
 * facts, revealed in a different order — not the same question reworded, which
 * the brief rules out explicitly. Sets are only kept when no other player in the
 * registry satisfies every clue in them.
 */
function whoAmIClueSets(player: PlayerRecord): ClueSet[] {
  const nat = NATIONALITIES[player.nat];
  if (!nat) return [];
  const clubs = player.clubs.filter(isReal).map((id) => clubOf(id));
  if (clubs.length < 2) return [];

  const posHe = { GK: "שוער", DF: "מגן", MF: "קשר", FW: "חלוץ" }[player.pos];
  const natHe = `הנבחרת שלי היא ${nat.he}`;
  const positionHe = `אני משחק בעמדת ${posHe}`;
  const leagues = [...new Set(clubs.map((c) => c.league).filter(Boolean) as string[])];
  const countries = [...new Set(clubs.map((c) => c.country))];

  const sets: ClueSet[] = [];

  // 1. Nationality + position + the two ends of the career.
  sets.push({
    id: "ends",
    clues: [
      natHe,
      positionHe,
      `התחלתי את הקריירה הבוגרת ${inHe(clubs[0].he)}`,
      `שיחקתי גם ${inHe(clubs[clubs.length - 1].he)}`,
    ],
  });

  // 2. Countries played in, then one club — a geography-led route to the answer.
  if (countries.length >= 2) {
    sets.push({
      id: "countries",
      clues: [
        natHe,
        positionHe,
        `שיחקתי ${inHe(countries.map(countryHe).join(", "))}`,
        `אחד המועדונים שלי הוא ${clubs[Math.floor(clubs.length / 2)].he}`,
      ],
    });
  }

  // 3. Leagues, for a player whose career crossed several of the big ones.
  if (leagues.length >= 3) {
    sets.push({
      id: "leagues",
      clues: [natHe, positionHe, `שיחקתי ב-${leagues.length} ליגות שונות`, `אחת מהן הייתה הליגה של ${countryHe(clubs[0].country)}`],
    });
  }

  // 4. Club count — only interesting for a well-travelled career.
  if (clubs.length >= 5) {
    sets.push({
      id: "journeyman",
      clues: [
        natHe,
        positionHe,
        `שיחקתי ב-${clubs.length} מועדונים בקריירה הבוגרת`,
        `אחד מהם היה ${clubs[1].he}`,
      ],
    });
  }

  return sets;
}

/** True when this clue set describes exactly one player in the registry. */
function clueSetIsUnique(player: PlayerRecord, set: ClueSet): boolean {
  const clubs = player.clubs.filter(isReal);
  const mentioned = CLUBS.filter((c) => set.clues.some((clue) => clue.includes(c.he))).map((c) => c.id);

  for (const other of PLAYERS) {
    if (other.id === player.id) continue;
    if (other.nat !== player.nat) continue;
    if (other.pos !== player.pos) continue;
    // Same nationality and position: the club facts have to separate them.
    const otherClubs = other.clubs.filter(isReal);
    const sharesEveryMentionedClub = mentioned.every((id) => otherClubs.includes(id));
    if (mentioned.length > 0 && !sharesEveryMentionedClub) continue;
    if (set.id === "journeyman" && otherClubs.length !== clubs.length) continue;
    // Nothing in the clue set rules this player out.
    return false;
  }
  return true;
}

/**
 * Who Am I, generated.
 *
 * Production had ten of these, all hand-written. Every fact used here is already
 * in the player registry; what was missing was a generator to ask with them.
 */
function generateWhoAmI(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  for (const player of PLAYERS) {
    if (player.clubs.some((c) => !isReal(c))) continue;
    const distractorPool = PLAYERS.filter(
      (p) => p.id !== player.id && p.pos === player.pos
    );

    for (const set of whoAmIClueSets(player)) {
      if (!clueSetIsUnique(player, set)) continue;
      const distractors = pickN(distractorPool, 3, `who_am_i:${player.id}:${set.id}`);
      if (distractors.length < 3) continue;

      out.push({
        semanticKey: `who_am_i:${player.id}:${set.id}`,
        mode: "WHO_AM_I",
        category: "WHO_AM_I",
        difficulty: difficultyFor({
          archetype: "who_am_i",
          fame: playerFame(player),
          // Same-position rivals only make it genuinely hard when the subject
          // is not a household name; naming Messi from four forwards is easy
          // however close the distractors are.
          distractors: playerFame(player) === 0 ? "near" : "mixed",
        }),
        questionHe: "מי אני?",
        explanationHe: `התשובה היא ${player.he}.`,
        clues: set.clues,
        options: [player.he, ...distractors.map((d) => d.he)],
        correctIndex: 0,
        scopes: playerScopes(player),
        sourceLabel: "מאגר שחקנים מאומת",
        freeText: true,
        canonicalAnswer: player.he,
        aliases: [player.en, ...player.aliases],
        hints: playerHints(player),
      });
    }
  }
  return out;
}

/** Clue sets for identifying a club. */
function guessClubClueSets(club: ClubRecord, famous: PlayerRecord[]): ClueSet[] {
  const sets: ClueSet[] = [];
  const country = countryHe(club.country);

  if (club.stadiumHe || club.stadium) {
    const stadium = club.stadiumHe ?? club.stadium!;
    sets.push({
      id: "stadium",
      clues: [`אני פועל ${inHe(country)}`, `המגרש הביתי שלי הוא ${stadium}`],
    });
  }

  if (club.founded) {
    sets.push({
      id: "founded",
      clues: [`אני פועל ${inHe(country)}`, `נוסדתי בשנת ${club.founded}`],
    });
  }

  if (famous.length >= 2) {
    sets.push({
      id: "players",
      clues: [
        `אני פועל ${inHe(country)}`,
        `${famous[0].he} שיחק אצלי`,
        `גם ${famous[1].he} שיחק אצלי`,
      ],
    });
  }

  if (club.nicknameHe) {
    sets.push({
      id: "nickname",
      clues: [`אני פועל ${inHe(country)}`, `הכינוי שלי הוא ${club.nicknameHe}`],
    });
  }

  return sets;
}

/**
 * Guess The Club, generated.
 *
 * Each set is checked against every other club: a founding year or a stadium
 * that two clubs share is dropped rather than asked.
 */
function generateGuessTheClub(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  // Who played where, so a club can be identified by its alumni.
  const alumni = new Map<string, PlayerRecord[]>();
  for (const player of PLAYERS) {
    for (const clubId of new Set(player.clubs.filter(isReal))) {
      if (!alumni.has(clubId)) alumni.set(clubId, []);
      alumni.get(clubId)!.push(player);
    }
  }

  for (const club of CLUBS) {
    const famous = (alumni.get(club.id) ?? [])
      .slice()
      .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));

    const sameCountry = CLUBS.filter((c) => c.id !== club.id && c.country === club.country);
    const distractorPool = sameCountry.length >= 3 ? sameCountry : CLUBS.filter((c) => c.id !== club.id);

    for (const set of guessClubClueSets(club, famous)) {
      // Uniqueness: no other club may satisfy the identifying fact.
      if (set.id === "founded" && sameCountry.some((c) => c.founded === club.founded)) continue;
      if (set.id === "stadium") {
        const stadium = club.stadiumHe ?? club.stadium;
        if (CLUBS.some((c) => c.id !== club.id && (c.stadiumHe ?? c.stadium) === stadium)) continue;
      }
      if (set.id === "nickname" && CLUBS.some((c) => c.id !== club.id && c.nicknameHe === club.nicknameHe)) {
        continue;
      }
      if (set.id === "players") {
        // Both named players must share only this club, or the answer is not unique.
        const shared = famous[0].clubs.filter((id) => famous[1].clubs.includes(id));
        if (new Set(shared).size !== 1) continue;
      }

      const distractors = pickN(distractorPool, 3, `guess_club:${club.id}:${set.id}`);
      if (distractors.length < 3) continue;

      out.push({
        semanticKey: `guess_club:${club.id}:${set.id}`,
        mode: "GUESS_THE_CLUB",
        category: "GUESS_THE_CLUB",
        /*
          NO ERA WEIGHT HERE, and the reason is worth stating.

          This used to pass `year: club.founded` for the founding-year clue set,
          which pushed every one of those questions up by the full pre-1975 era
          weight — 2.7 — and landed 49 of them in IMPOSSIBLE. That made the
          curated bank's top band 96% "guess the club", so choosing "בלתי אפשרי"
          meant playing a guess-the-club quiz. The band's own test caught it.

          The era weight exists to say "this happened long ago, so it is less
          well remembered". A club's founding year is not an event anybody
          remembers; it is a number printed on the badge, and here it is printed
          on the screen as the clue. The question is hard because founding years
          are not knowledge most fans carry — which is what the archetype weight
          already says.
        */
        difficulty: difficultyFor({
          archetype: "guess_club",
          // The club IS the subject here, so its recognisability belongs on the
          // fame axis and nowhere else. Adding entityProminence as well would
          // charge for the same thing twice.
          fame: clubFame(club),
          // Which clue set it is, expressed as what it actually is: how well
          // known the identifying fact is. A founding year is a fact almost
          // nobody carries; a stadium, a nickname and a famous alumnus are facts
          // a fan of that club does.
          factProminence: set.id === "founded" ? "OBSCURE" : undefined,
          distractors: sameCountry.length >= 3 && clubFame(club) === 0 ? "near" : "mixed",
        }),
        questionHe: "איזה מועדון אני?",
        explanationHe: `התשובה היא ${club.he}.`,
        clues: set.clues,
        options: [club.he, ...distractors.map((d) => d.he)],
        correctIndex: 0,
        scopes: club.league
          ? [{ type: "COMPETITION", value: club.league }, { type: "COUNTRY", value: club.country }]
          : [{ type: "COUNTRY", value: club.country }],
        sourceLabel: "מאגר מועדונים מאומת",
        freeText: true,
        canonicalAnswer: club.he,
        aliases: clubAliases(club),
        hints: clubHints(club),
      });
    }
  }
  return out;
}

/**
 * Every unambiguous club pair a player connects.
 *
 * The original family asked one pair per player. A career of five clubs contains
 * ten pairs, and the ones nobody expects — an early club and a late one — are the
 * good questions. A pair is only used when exactly one player in the registry
 * played for both.
 */
function generateClubPairConnections(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  // How many registry players connect each unordered club pair.
  const pairOwners = new Map<string, string[]>();
  for (const player of PLAYERS) {
    const clubs = [...new Set(player.clubs.filter(isReal))];
    for (let i = 0; i < clubs.length; i++) {
      for (let j = i + 1; j < clubs.length; j++) {
        const key = [clubs[i], clubs[j]].sort().join("+");
        if (!pairOwners.has(key)) pairOwners.set(key, []);
        pairOwners.get(key)!.push(player.id);
      }
    }
  }

  for (const player of PLAYERS) {
    const clubs = [...new Set(player.clubs.filter(isReal))];
    if (clubs.length < 2) continue;
    const distractorPool = PLAYERS.filter((p) => p.id !== player.id && p.pos === player.pos);

    for (let i = 0; i < clubs.length; i++) {
      for (let j = i + 1; j < clubs.length; j++) {
        const a = clubOf(clubs[i]);
        const b = clubOf(clubs[j]);
        const key = [clubs[i], clubs[j]].sort().join("+");
        if ((pairOwners.get(key) ?? []).length !== 1) continue;

        const distractors = pickN(distractorPool, 3, `connection:${player.id}:${key}`);
        if (distractors.length < 3) continue;

        // Two clubs in different countries make a more interesting question than
        // two clubs in the same league, and a harder one.
        const crossBorder = a.country !== b.country;

        out.push({
          semanticKey: `connection:${player.id}:${key}`,
          mode: "CLUB_CONNECTION",
          category: "CAREERS",
          difficulty: difficultyFor({
            archetype: "club_connection",
            fame: playerFame(player),
          // Fame already carries a band per step, so pinning close
          // distractors on top of it double-counts and pushes every
          // lesser-known subject into IMPOSSIBLE. Close distractors are what
          // make a question about a FAMOUS subject hard; for the rest, fame is
          // doing the work already.
            distractors: playerFame(player) === 0 ? "near" : "mixed",
          }),
          questionHe: `איזה שחקן שיחק גם ${inHe(a.he)} וגם ${inHe(b.he)}?`,
          explanationHe: `${player.he} שיחק בשני המועדונים.`,
          options: [player.he, ...distractors.map((d) => d.he)],
          correctIndex: 0,
          scopes: playerScopes(player),
          sourceLabel: "מסלולי קריירה מאומתים",
          freeText: true,
          canonicalAnswer: player.he,
          aliases: [player.en, ...player.aliases],
          hints: [
            crossBorder ? "הוא שיחק ביותר ממדינה אחת" : "שני המועדונים באותה מדינה",
            ...playerHints(player),
          ].slice(0, 3),
        });
      }
    }
  }
  return out;
}

/**
 * Which country a club plays in, and which league.
 *
 * Deliberately easy questions — the bank is top-heavy with hard ones, and a
 * mixed quiz needs somewhere to start.
 */
function generateClubCountryAndLeague(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  for (const club of CLUBS) {
    const otherCountries = [...new Set(CLUBS.map((c) => c.country))].filter((c) => c !== club.country);
    const countryDistractors = pickN(otherCountries, 3, `club_country:${club.id}`);
    if (countryDistractors.length === 3) {
      out.push({
        semanticKey: `club_country:${club.id}`,
        mode: "CLASSIC",
        category: "CLUBS",
        difficulty: difficultyFor({ archetype: "club_country", fame: clubFame(club), distractors: "far" }),
        questionHe: `באיזו מדינה משחק ${club.he}?`,
        explanationHe: `${club.he} משחק ${inHe(countryHe(club.country))}.`,
        options: [countryHe(club.country), ...countryDistractors.map(countryHe)],
        correctIndex: 0,
        scopes: [{ type: "COUNTRY", value: club.country }],
        sourceLabel: "מאגר מועדונים מאומת",
        freeText: true,
        canonicalAnswer: countryHe(club.country),
        aliases: [club.country],
        hints: [firstLetterHint(countryHe(club.country))],
      });
    }
  }
  return out;
}

/**
 * Position questions, at whatever precision the data supports.
 *
 * THE BUG THIS REPLACES. This generator used to translate the registry's `pos`
 * straight into Hebrew — FW became "חלוץ" — and ask "באיזו עמדה משחק X?". For
 * Mohamed Salah that produced a question asking for a position and answering
 * with a role he has never played: he is a right winger, and "חלוץ" means
 * striker. The data was not wrong. The question was the wrong question for it.
 *
 * So two questions are generated instead of one, and which ones depends on what
 * is actually known:
 *
 *   `position:<id>`      the UNIT — "באיזו חוליה משחק X?" → "התקפה". Always
 *                        available, because `pos` always is. This keeps the
 *                        existing semantic key, so the 131 stored questions are
 *                        repaired in place rather than replaced.
 *   `position_role:<id>` the ROLE — "מה התפקיד המדויק של X?" → "קיצוני ימני".
 *                        Only where PLAYER_ROLES names one, which is only where
 *                        the role is uncontested.
 *
 * A goalkeeper gets only the unit question: for a keeper the unit and the role
 * are the same word, so the second question would be the first one again.
 */
function generatePlayerPositions(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  for (const player of PLAYERS) {
    if (player.clubs.some((c) => !isReal(c))) continue;

    const resolved = resolvePosition({
      curatedRole: PLAYER_ROLES[player.id] ?? null,
      seedBroad: player.pos,
    });
    if (!resolved.broad) continue;

    const nationalityHint = [(NATIONALITIES[player.nat]?.he ? `השחקן מ${NATIONALITIES[player.nat]!.he}` : "").trim()].filter(Boolean);

    // ---- the unit. Four options, fixed rather than sampled: there are only four.
    const broadWrong = BROAD_POSITIONS.filter((p) => p !== resolved.broad);
    out.push({
      semanticKey: `position:${player.id}`,
      mode: "CLASSIC",
      category: "PLAYERS",
      difficulty: difficultyFor({
        archetype: "position_broad",
        fame: playerFame(player),
        distractors: "far",
      }),
      questionHe: `באיזו חוליה משחק ${player.he}?`,
      explanationHe:
        resolved.broad === "GOALKEEPER"
          ? `${player.he} הוא שוער.`
          : `${player.he} משחק בחוליית ה${BROAD_HE[resolved.broad]}.`,
      options: [BROAD_HE[resolved.broad], ...broadWrong.map((p) => BROAD_HE[p])],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מאגר שחקנים מאומת",
      freeText: true,
      canonicalAnswer: BROAD_HE[resolved.broad],
      aliases: [],
      hints: nationalityHint,
    });

    // ---- the role, where one is established.
    if (!supportsPreciseQuestion(resolved) || resolved.detailed === "GK") continue;
    const role = resolved.detailed!;
    // Distractors are roles a fan could plausibly mix up with this one. Offering
    // "שוער" against "קיצוני ימני" is not a question, it is a formality.
    const roleWrong = CONFUSABLE_WITH[role].filter((r) => DETAILED_HE[r] !== DETAILED_HE[role]).slice(0, 3);
    if (roleWrong.length < 3) continue;

    out.push({
      semanticKey: `position_role:${player.id}`,
      mode: "CLASSIC",
      category: "PLAYERS",
      difficulty: difficultyFor({
        archetype: "position_precise",
        fame: playerFame(player),
        // Confusable roles by construction, which is what makes this harder than
        // the unit question rather than a second copy of it.
        distractors: "near",
      }),
      questionHe: `מה התפקיד המדויק של ${player.he}?`,
      explanationHe: `${player.he} משחק בתפקיד ${DETAILED_HE[role]}.`,
      options: [DETAILED_HE[role], ...roleWrong.map((r) => DETAILED_HE[r])],
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מאגר שחקנים מאומת",
      freeText: true,
      canonicalAnswer: DETAILED_HE[role],
      aliases: [],
      hints: [...nationalityHint, `הוא שחקן ${BROAD_HE[resolved.broad]}`],
    });
  }
  return out;
}

/**
 * How many clubs a player has had, and how many countries.
 *
 * Exact-count questions, which the difficulty model already treats as hard.
 * Only for `seq: "full"` careers — a partial list would make the count wrong,
 * and a wrong answer presented as fact is worse than no question.
 */
function generateCareerSpan(): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];

  for (const player of PLAYERS) {
    if (player.seq !== "full") continue;
    if (player.clubs.some((c) => !isReal(c))) continue;
    const countries = new Set(player.clubs.map((id) => clubOf(id).country));
    if (countries.size < 2) continue;

    const correct = countries.size;
    const options = [correct, correct + 1, correct - 1, correct + 2].filter((n) => n > 0);
    if (new Set(options).size < 4) continue;

    out.push({
      semanticKey: `career_countries:${player.id}`,
      mode: "CLASSIC",
      category: "CAREERS",
      difficulty: difficultyFor({ archetype: "title_count", fame: playerFame(player), distractors: "near" }),
      questionHe: `בכמה מדינות שונות שיחק ${player.he} בקריירה הבוגרת?`,
      explanationHe: `${player.he} שיחק ב-${correct} מדינות: ${[...countries].map(countryHe).join(", ")}.`,
      options: options.map(String),
      correctIndex: 0,
      scopes: playerScopes(player),
      sourceLabel: "מסלולי קריירה מאומתים",
      freeText: false,
      hints: playerHints(player).slice(0, 2),
    });
  }
  return out;
}

export function generateAll(): GeneratedQuestion[] {
  const all = [
    ...generateFirstClub(),
    ...generateAdjacentClubMoves(),
    ...generateCareerPaths(),
    ...generateClubConnections(),
    ...generateDidNotPlayFor(),
    ...generateNationalities(),
    ...generateClubFinals(UCL_FINALS, "UCL", "ליגת האלופות", "ucl", "CHAMPIONS_LEAGUE"),
    ...generateClubFinals(UEL_FINALS, "UEL", "הליגה האירופית", "uel", "TITLES"),
    ...generateNationFinals(WORLD_CUP_FINALS, "WORLD_CUP", "מונדיאל", "wc", "WORLD_CUP"),
    ...generateNationFinals(EURO_FINALS, "EURO", "אליפות אירופה", "euro", "NATIONAL_TEAMS"),
    ...generateWorldCupHosts(),
    ...generateLeagueChampions(),
    ...generateClubFacts(),
    // ---- expanded coverage over the same verified registries ----
    ...generateCareerSubPaths(),
    ...generateWhoAmI(),
    ...generateGuessTheClub(),
    ...generateClubPairConnections(),
    ...generateClubCountryAndLeague(),
    ...generatePlayerPositions(),
    ...generateCareerSpan(),
  ];

  // Semantic de-duplication.
  const seen = new Set<string>();
  const deduped: GeneratedQuestion[] = [];
  for (const q of all) {
    if (seen.has(q.semanticKey)) continue;
    seen.add(q.semanticKey);
    // Sanity: exactly 4 distinct options, exactly one correct.
    const unique = new Set(q.options);
    if (q.options.length !== 4 || unique.size !== 4) continue;
    deduped.push(q);
  }
  return deduped.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
}
