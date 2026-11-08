// The builder's model.
//
// WHAT THESE TESTS ARE FOR
//
// "Verify the query, not just the screen." A builder that looks right and sends
// the wrong query is worse than an ugly one that sends the right query — the
// player gets questions they did not ask for and has no way to tell. So the
// mapping to QuizConfiguration lives outside React and is asserted here.
//
// And one rule that is new in this pass: an option is OFFERED only when it can
// fill the quiz being asked for. Hiding the rest is what makes a dead end
// impossible rather than unlikely, so the hiding is tested as carefully as the
// query.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  COUNT_CHOICES,
  countriesIn,
  competitionsForCountry,
  DIFFICULTY_CHOICES,
  DIFFICULTY_COMMON,
  INITIAL_STATE,
  isOfferable,
  isOfferableStrict,
  MAIN_TYPE_KEYS,
  MORE_TYPE_KEYS,
  offerableScopes,
  offerableTypes,
  PRESETS,
  PRESET_BY_KEY,
  repair,
  SCOPE_ALL,
  SCOPE_CHOICES,
  SCOPE_COMPETITIONS,
  scopeLabel,
  SUPPORTED_CONTINENTS,
  toConfiguration,
  typeLabel,
  type Availability,
  type BuilderState,
} from "../src/client/lib/builderWizard.ts";
import { parseQuizConfiguration } from "../src/worker/lib/validate.ts";
import { COMPETITIONS, COUNTRIES, QUESTION_COUNTS } from "../src/shared/constants.ts";
import { MIXED_TYPE_KEY, QUESTION_TYPES } from "../src/shared/questionTypes.ts";

const state = (over: Partial<BuilderState> = {}): BuilderState => ({ ...INITIAL_STATE, ...over });

/** Availability where everything is plentiful. */
const plentiful = (total = 9999): Availability => ({
  total,
  types: Object.fromEntries([MIXED_TYPE_KEY, ...QUESTION_TYPES.map((t) => t.key)].map((k) => [k, total])),
  presets: Object.fromEntries(PRESETS.map((p) => [p.key, total])),
});

// ---------------------------------------------------------------------------
describe("the default game starts without being touched", () => {
  /*
    THE ONE-TAP REQUIREMENT, as an assertion rather than an intention. Opening
    the builder and pressing Start has to work, which means the defaults must be
    a real quiz and the widest pool the bank has.
  */
  it("defaults to mixed on both axes, multiple choice, ten, everywhere", () => {
    assert.equal(INITIAL_STATE.questionType, MIXED_TYPE_KEY);
    assert.equal(INITIAL_STATE.answerMode, "MULTIPLE_CHOICE");
    assert.equal(INITIAL_STATE.difficulty, "MIXED");
    assert.equal(INITIAL_STATE.questionCount, 10);
    assert.equal(INITIAL_STATE.scope, SCOPE_ALL);
  });

  it("the default configuration is unfiltered, which is the largest pool there is", () => {
    const config = toConfiguration(INITIAL_STATE);
    assert.equal(config.region, "WORLD");
    assert.deepEqual(config.countries, []);
    assert.deepEqual(config.competitions, ["ALL"]);
    assert.deepEqual(config.categories, [], "mixed pins no category — the grid draw does that");
    assert.equal(config.questionType, MIXED_TYPE_KEY);
    assert.equal(config.preset, undefined, "the builder is not Quick Start");
    parseQuizConfiguration(JSON.parse(JSON.stringify(config)));
  });

  it("nothing is left unset, so there is no step to complete first", () => {
    for (const [key, value] of Object.entries(INITIAL_STATE)) {
      if (key === "scopeCountry") continue;
      assert.ok(value !== null && value !== undefined, `${key} is unset`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the screen is five rows of choices", () => {
  it("offers both answer modes, six difficulties and four counts", () => {
    assert.equal(DIFFICULTY_CHOICES.length, 6);
    assert.deepEqual(COUNT_CHOICES, [5, 10, 15, 20]);
    assert.ok(DIFFICULTY_CHOICES.includes("EXPERT"), "the full builder keeps Expert");
    assert.ok(DIFFICULTY_CHOICES.includes("IMPOSSIBLE"), "and Impossible");
  });

  it("emphasises the three difficulties most people pick without hiding the rest", () => {
    assert.deepEqual(DIFFICULTY_COMMON, ["MIXED", "NORMAL", "HARD"]);
    for (const d of DIFFICULTY_COMMON) assert.ok(DIFFICULTY_CHOICES.includes(d));
  });

  it("shows five question types up front and keeps the rest behind 'עוד'", () => {
    assert.equal(MAIN_TYPE_KEYS.length, 5);
    assert.equal(MAIN_TYPE_KEYS[0], MIXED_TYPE_KEY, "mixed leads");
    assert.ok(MORE_TYPE_KEYS.length >= 7, `${MORE_TYPE_KEYS.length} behind the door`);
    // Every type is reachable one way or the other.
    const all = [...MAIN_TYPE_KEYS, ...MORE_TYPE_KEYS].filter((k) => k !== MIXED_TYPE_KEY).sort();
    assert.deepEqual(all, QUESTION_TYPES.map((t) => t.key).sort());
  });

  it("gives every pill a label short enough for a pill", () => {
    for (const key of [MIXED_TYPE_KEY, ...QUESTION_TYPES.map((t) => t.key)]) {
      const label = typeLabel(key);
      assert.ok(label.length > 0 && label.length <= 12, `${key}: "${label}"`);
    }
    for (const choice of SCOPE_CHOICES) {
      assert.ok(choice.labelHe.length <= 14, `${choice.key}: "${choice.labelHe}"`);
    }
  });

  it("the scope row answers most of what people want without geography", () => {
    assert.equal(SCOPE_CHOICES[0].key, SCOPE_ALL, "everywhere first — it is the default");
    for (const choice of SCOPE_CHOICES.slice(1)) {
      assert.ok(PRESET_BY_KEY.has(choice.key), `${choice.key} is not a real preset`);
    }
    for (const key of ["top6", "ucl", "israel", "europe"]) {
      assert.ok(SCOPE_CHOICES.some((c) => c.key === key), `${key} should be one tap away`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("an option that cannot fill the quiz is not offered", () => {
  /*
    THE RULE THAT REMOVES THE DEAD END. The previous build disabled such options
    and said why, which turned the screen into a list of things you could not
    have. Absent is better: every visible choice leads to a game.
  */
  it("hides a type with fewer questions than were asked for", () => {
    const availability: Availability = { total: 500, types: { [MIXED_TYPE_KEY]: 500, WHO_AM_I: 8 }, presets: {} };
    const offered = offerableTypes(availability, 10, false);
    assert.ok(!offered.includes("WHO_AM_I"), "eight questions cannot fill ten");
    assert.ok(offered.includes(MIXED_TYPE_KEY));
  });

  it("shows the same type once the count drops below its pool", () => {
    const availability: Availability = { total: 500, types: { [MIXED_TYPE_KEY]: 500, WHO_AM_I: 8 }, presets: {} };
    assert.ok(offerableTypes(availability, 5, false).includes("WHO_AM_I"), "eight can fill five");
  });

  it("hides a scope with nothing behind it", () => {
    const availability: Availability = { total: 500, types: {}, presets: { top6: 900, copa: 0, israel: 45 } };
    const keys = offerableScopes(availability, 10).map((s) => s.key);
    assert.ok(!keys.includes("copa"), "a preset with zero questions must not appear at all");
    assert.ok(keys.includes("israel"), "forty-five can fill ten");
    assert.ok(keys.includes(SCOPE_ALL));
  });

  it("hides 'everywhere' itself if even that cannot fill the quiz", () => {
    const keys = offerableScopes({ total: 3, types: {}, presets: {} }, 20).map((s) => s.key);
    assert.ok(!keys.includes(SCOPE_ALL));
  });

  it("treats an unknown count as offerable, so the screen does not flicker or empty", () => {
    assert.equal(isOfferable(undefined, 20), true);
    // Availability arrives a moment after the screen and can fail outright;
    // hiding everything unmeasured would be worse than showing it.
    assert.deepEqual(offerableTypes(null, 20, false), MAIN_TYPE_KEYS);
    assert.equal(offerableScopes(null, 20).length, SCOPE_CHOICES.length);
  });

  it("'עוד' reveals the rest, still filtered", () => {
    const availability = plentiful();
    availability.types!.TRANSFERS = 2;
    const more = offerableTypes(availability, 10, true);
    assert.ok(more.length > MAIN_TYPE_KEYS.length, "the door opens");
    assert.ok(!more.includes("TRANSFERS"), "and the rule still applies behind it");
  });
});

// ---------------------------------------------------------------------------
describe("a selection the pool can no longer serve is repaired", () => {
  /*
    Choices interact: twenty questions can empty a type that was fine at five,
    and picking Israel can empty a type that was fine worldwide. A state the
    screen no longer offers is the dead end in slow motion.
  */
  it("falls back to mixed when the chosen type empties", () => {
    const next = repair(state({ questionType: "WHO_AM_I", questionCount: 20 }), {
      total: 900,
      types: { [MIXED_TYPE_KEY]: 900, WHO_AM_I: 8 },
      presets: {},
    });
    assert.equal(next.questionType, MIXED_TYPE_KEY);
  });

  it("falls back to everywhere when the chosen scope empties", () => {
    const next = repair(state({ scope: "israel", questionCount: 20 }), {
      total: 900,
      types: {},
      presets: { israel: 8 },
    });
    assert.equal(next.scope, SCOPE_ALL);
    assert.equal(next.scopeCountry, null);
  });

  it("repairs a competition chosen in the picker too", () => {
    const next = repair(state({ scope: "LA_LIGA", scopeCountry: "ESP", questionCount: 20 }), {
      total: 900,
      types: {},
      presets: {},
      competitions: { LA_LIGA: 4 },
    });
    assert.equal(next.scope, SCOPE_ALL);
  });

  it("leaves a healthy state untouched, and returns the same object so it cannot loop", () => {
    const healthy = state({ questionType: "WHO_AM_I", scope: "top6" });
    const next = repair(healthy, plentiful());
    assert.equal(next, healthy, "an unchanged state must be referentially equal");
  });

  it("never repairs away from mixed, which is the widest pool there is", () => {
    const next = repair(state(), { total: 2, types: { [MIXED_TYPE_KEY]: 2 }, presets: {} });
    assert.equal(next.questionType, MIXED_TYPE_KEY, "there is nowhere wider to fall back to");
  });

  it("does nothing at all before availability has arrived", () => {
    const s = state({ questionType: "WHO_AM_I" });
    assert.equal(repair(s, null), s);
  });
});

// ---------------------------------------------------------------------------
describe("the required flows map to the right query", () => {
  const accepted = (config: ReturnType<typeof toConfiguration>) =>
    parseQuizConfiguration(JSON.parse(JSON.stringify(config)));

  it("the simple default flow", () => {
    const config = toConfiguration(state());
    assert.equal(config.difficulty, "MIXED");
    assert.equal(config.questionCount, 10);
    accepted(config);
  });

  it("free text, hard, 10, Who Am I, the big six", () => {
    const config = toConfiguration(
      state({ answerMode: "FREE_TEXT", difficulty: "HARD", questionCount: 10, questionType: "WHO_AM_I", scope: "top6" })
    );
    assert.equal(config.answerMode, "FREE_TEXT");
    assert.equal(config.difficulty, "HARD");
    assert.equal(config.gameMode, "WHO_AM_I", "the type decides the mode");
    assert.deepEqual(config.competitions, ["TOP_6_EUROPE"]);
    accepted(config);
  });

  it("a preset's categories replace the type's, because the scope was chosen later", () => {
    const config = toConfiguration(state({ questionType: "TRANSFERS", scope: "nations" }));
    assert.deepEqual(config.categories, PRESET_BY_KEY.get("nations")!.categories);
  });

  it("a league from the picker narrows to that league inside that country", () => {
    const config = toConfiguration(state({ scope: "LA_LIGA", scopeCountry: "ESP" }));
    assert.deepEqual(config.competitions, ["LA_LIGA"]);
    assert.deepEqual(config.countries, ["ESP"]);
    assert.equal(config.region, "WORLD", "a region tag that matches nothing must not be sent");
    accepted(config);
  });

  it("switching back to everywhere drops a stale league and country", () => {
    const config = toConfiguration(state({ scope: SCOPE_ALL, scopeCountry: "ESP" }));
    assert.deepEqual(config.competitions, ["ALL"]);
    assert.deepEqual(config.countries, []);
  });

  it("labels whatever the scope currently is", () => {
    assert.equal(scopeLabel(state()), "הכל");
    assert.equal(scopeLabel(state({ scope: "top6" })), "טופ 6");
    assert.equal(scopeLabel(state({ scope: "LA_LIGA" })), "לה ליגה");
  });
});

// ---------------------------------------------------------------------------
describe("every configuration the builder can produce is valid server-side", () => {
  it("survives the real parser for every combination of choices", () => {
    const types = [MIXED_TYPE_KEY, ...QUESTION_TYPES.map((t) => t.key)];
    const scopes = [
      SCOPE_ALL,
      ...PRESETS.map((p) => p.key),
      ...SCOPE_COMPETITIONS.map((c) => c.code),
    ];
    let checked = 0;

    for (const questionType of types) {
      for (const difficulty of DIFFICULTY_CHOICES) {
        for (const scope of scopes) {
          const config = toConfiguration(state({ questionType, difficulty, scope }));
          const parsed = parseQuizConfiguration(JSON.parse(JSON.stringify(config)));
          assert.equal(parsed.difficulty, config.difficulty);
          assert.equal(parsed.questionType, config.questionType);
          assert.equal(parsed.gameMode, config.gameMode);
          assert.deepEqual([...parsed.competitions].sort(), [...config.competitions].sort());
          assert.deepEqual([...parsed.countries].sort(), [...config.countries].sort());
          assert.deepEqual([...parsed.categories].sort(), [...config.categories].sort());
          checked++;
        }
      }
    }
    assert.ok(checked > 2000, `only ${checked} combinations were checked`);
  });

  it("every count the builder offers is on the server's allow-list", () => {
    for (const count of COUNT_CHOICES) {
      assert.ok(QUESTION_COUNTS.includes(count as never), `${count} is not accepted`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the optional league picker", () => {
  it("only names real codes", () => {
    for (const country of COUNTRIES) {
      for (const code of competitionsForCountry(country.code)) {
        assert.ok(COMPETITIONS.some((c) => c.code === code), `${country.code} names ${code}`);
      }
    }
  });

  it("treats a missing count as none once the level's counts have arrived", () => {
    /*
      A count GROUP BY returns no row for an option with no questions, so the
      Conference League — which has none — was absent from the response and
      therefore "unknown", which the main screen permits. In the picker that
      technicality was offering a league that cannot produce a single question.
    */
    assert.equal(isOfferableStrict({ LA_LIGA: 1258 }, "UECL", 10), false, "absent means none here");
    assert.equal(isOfferableStrict({ LA_LIGA: 1258 }, "LA_LIGA", 10), true);
    assert.equal(isOfferableStrict(undefined, "UECL", 10), true, "but not before they arrive");
    // The main screen keeps the permissive rule, so it cannot flicker on open.
    assert.equal(isOfferable(undefined, 10), true);
  });

  it("offers every continent, and the empty ones are filtered by their counts", () => {
    assert.equal(SUPPORTED_CONTINENTS.length, 6);
    // Africa and Oceania have no countries in the bank, so their count is zero
    // and the picker drops them — by the same rule as everything else, rather
    // than by being absent from the list.
    assert.equal(countriesIn("AFRICA").length, 0);
    assert.equal(isOfferable(0, 10), false);
  });

  it("gives a country with no domestic league the continental competitions", () => {
    // Brazil's clubs are in the bank; its league is not exposed as a filter.
    const codes = competitionsForCountry("BRA");
    assert.ok(codes.length > 0, "the picker must not dead-end on a country");
    assert.ok(codes.includes("UCL"));
  });
});
