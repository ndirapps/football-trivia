import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCodeInput,
} from "../src/shared/multiplayer/roomCode.ts";
import { nameKey, sanitizePlayerName, uniquePlayerName } from "../src/shared/multiplayer/names.ts";
import { shouldShowMessage } from "../src/client/lib/mp/chatPolicy.ts";
import { scoreAnswer, scoringSummaryHe, streakBonusEnabled } from "../src/shared/multiplayer/scoring.ts";
import {
  autoBalance,
  buildStandings,
  buildTeamResult,
  comparePlayers,
  teamTotals,
  winnerIdsFrom,
} from "../src/shared/multiplayer/standings.ts";
import { parseClientMessage, parseSettingsPatch } from "../src/shared/multiplayer/protocol.ts";
import {
  SCORE_BASE_CORRECT,
  SCORE_CORRECT_FLOOR,
  SCORE_HINT_PENALTY,
  SCORE_MAX_SPEED_BONUS,
  SCORE_MAX_STREAK_BONUS,
} from "../src/shared/multiplayer/constants.ts";
import type { PublicPlayer } from "../src/shared/multiplayer/types.ts";

/*
  WHAT THESE TESTS ARE FOR

  Everything here is a rule a player can feel but cannot see: what a name is
  allowed to be, what an answer is worth, who wins a tie, and what a tampered
  client is allowed to change. All of it runs on the server, so the only way to
  know it is right is to test it directly.

  The protocol tests are the security ones. `parseClientMessage` is the single
  door into a room, and the cases below are the ones that matter: a score sent by
  a client, a question index from the future, a name made of bidi overrides, a
  4MB payload. None of them may get through.
*/

// ---------------------------------------------------------------- room codes

describe("room codes", () => {
  it("are six digits", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      assert.match(code, /^[0-9]{6}$/, `bad code: ${code}`);
      assert.ok(isValidRoomCode(code));
    }
  });

  it("reject anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "12a456", "  482731", null, 482731, undefined]) {
      assert.equal(isValidRoomCode(bad), false, `should reject ${String(bad)}`);
    }
  });

  it("discard bytes above the last whole multiple of ten rather than folding them in", () => {
    // Every byte here is >= 250 except the trailing zeros, so a modulo-only
    // implementation would emit digits from the biased tail. This generator must
    // skip them, which means it reaches the zeros.
    const bytes = [250, 251, 252, 253, 254, 255, 0, 0, 0, 0, 0, 0];
    let cursor = 0;
    const code = generateRoomCode((buffer) => {
      for (let i = 0; i < buffer.length; i++) buffer[i] = bytes[(cursor + i) % bytes.length];
      cursor += buffer.length;
    });
    assert.equal(code, "000000");
  });

  it("produce a roughly uniform digit distribution", () => {
    // Not a statistics test — a bias big enough to matter (modulo 10 over 0-255
    // makes 0-5 about 20% likelier) would blow past this bound.
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 4000; i++) {
      for (const digit of generateRoomCode()) counts[Number(digit)]++;
    }
    const expected = (4000 * 6) / 10;
    for (const count of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.2, `digit distribution off: ${counts.join(",")}`);
    }
  });

  it("pull the code out of a pasted link, a spaced code or a dashed one", () => {
    assert.equal(normalizeRoomCodeInput("https://football-iq.naorl.workers.dev/room/482731"), "482731");
    assert.equal(normalizeRoomCodeInput("482 731"), "482731");
    assert.equal(normalizeRoomCodeInput("482-731"), "482731");
    assert.equal(normalizeRoomCodeInput("  482731  "), "482731");
    assert.equal(normalizeRoomCodeInput("12345"), null);
    assert.equal(normalizeRoomCodeInput(""), null);
  });

  it("format for reading aloud", () => {
    assert.equal(formatRoomCode("482731"), "482 731");
  });
});

// ------------------------------------------------------------------ names

describe("player names", () => {
  it("trim, collapse whitespace and cap length", () => {
    assert.equal(sanitizePlayerName("  נאור  "), "נאור");
    assert.equal(sanitizePlayerName("נאור\t\t לוי"), "נאור לוי");
    assert.equal(sanitizePlayerName("a".repeat(80))?.length, 16);
  });

  it("strip markup, control characters and zero-width marks", () => {
    assert.equal(sanitizePlayerName("<script>x"), "scriptx");
    const withControls = `נאור${String.fromCodePoint(0x0000)}${String.fromCodePoint(0x001f)}`;
    assert.equal(sanitizePlayerName(withControls), "נאור");
    const zeroWidth = `נא${String.fromCodePoint(0x200b)}ור`;
    assert.equal(sanitizePlayerName(zeroWidth), "נאור");
  });

  it("strip bidi overrides, which in an RTL product could rewrite the row next to them", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, then U+202C POP DIRECTIONAL FORMATTING.
    const attack = `${String.fromCodePoint(0x202e)}נאור${String.fromCodePoint(0x202c)}`;
    assert.equal(sanitizePlayerName(attack), "נאור");
  });

  it("keep the punctuation that appears in real Hebrew names", () => {
    assert.equal(sanitizePlayerName("ג׳וני"), "ג׳וני");
    assert.equal(sanitizePlayerName("בן-אור"), "בן-אור");
    assert.equal(sanitizePlayerName("או'ניל"), "או'ניל");
  });

  it("reject a name with nothing usable left", () => {
    assert.equal(sanitizePlayerName(""), null);
    assert.equal(sanitizePlayerName("   "), null);
    assert.equal(sanitizePlayerName("​​"), null);
    assert.equal(sanitizePlayerName(42), null);
    assert.equal(sanitizePlayerName(null), null);
  });

  it("suffix a duplicate name instead of refusing it", () => {
    assert.equal(uniquePlayerName("נאור", []), "נאור");
    assert.equal(uniquePlayerName("נאור", ["נאור"]), "נאור 2");
    assert.equal(uniquePlayerName("נאור", ["נאור", "נאור 2"]), "נאור 3");
  });

  it("treat case and spacing differences as the same name", () => {
    assert.equal(uniquePlayerName("Naor", ["naor"]), "Naor 2");
    assert.equal(nameKey("  Naor  Levi "), nameKey("naor levi"));
  });

  it("make room for the suffix rather than overflowing the length cap", () => {
    const long = "a".repeat(16);
    const unique = uniquePlayerName(long, [long]);
    assert.ok(unique.length <= 16, `too long: ${unique} (${unique.length})`);
    assert.ok(unique.endsWith(" 2"));
  });
});

// ----------------------------------------------------------------- scoring

describe("multiplayer scoring", () => {
  const base = {
    correct: true,
    revealed: false,
    limitMs: 20_000,
    streakBefore: 0,
    hintsUsed: 0,
    streakBonusEnabled: true,
  };

  it("gives an instant correct answer the full speed bonus", () => {
    const score = scoreAnswer({ ...base, timeMs: 0 });
    assert.equal(score.base, SCORE_BASE_CORRECT);
    assert.equal(score.speed, SCORE_MAX_SPEED_BONUS);
    assert.equal(score.total, SCORE_BASE_CORRECT + SCORE_MAX_SPEED_BONUS);
  });

  it("gives a last-second correct answer no speed bonus", () => {
    const score = scoreAnswer({ ...base, timeMs: 20_000 });
    assert.equal(score.speed, 0);
    assert.equal(score.total, SCORE_BASE_CORRECT);
  });

  it("scales the speed bonus linearly in the time left", () => {
    assert.equal(scoreAnswer({ ...base, timeMs: 10_000 }).speed, SCORE_MAX_SPEED_BONUS / 2);
  });

  it("scores nothing for a wrong answer, a reveal or a no-show", () => {
    assert.equal(scoreAnswer({ ...base, correct: false, timeMs: 1000 }).total, 0);
    assert.equal(scoreAnswer({ ...base, revealed: true, timeMs: 1000 }).total, 0);
    assert.equal(scoreAnswer({ ...base, timeMs: null }).total, 0);
  });

  it("caps the streak bonus", () => {
    assert.equal(scoreAnswer({ ...base, timeMs: 0, streakBefore: 99 }).streak, SCORE_MAX_STREAK_BONUS);
  });

  it("turns the streak bonus off for EVERYONE_ANSWERS and keeps it on elsewhere", () => {
    assert.equal(streakBonusEnabled("EVERYONE_ANSWERS"), false);
    assert.equal(streakBonusEnabled("CLASSIC_BATTLE"), true);
    assert.equal(streakBonusEnabled("DUEL"), true);
    assert.equal(scoreAnswer({ ...base, timeMs: 0, streakBefore: 3, streakBonusEnabled: false }).streak, 0);
  });

  it("charges for hints but never takes a correct answer below the floor", () => {
    assert.equal(
      scoreAnswer({ ...base, timeMs: 20_000, hintsUsed: 1 }).total,
      SCORE_BASE_CORRECT - SCORE_HINT_PENALTY
    );
    assert.equal(scoreAnswer({ ...base, timeMs: 20_000, hintsUsed: 50 }).total, SCORE_CORRECT_FLOOR);
  });

  it("cannot be made to mint points by a time outside the window", () => {
    // A negative or over-long time would otherwise push the speed bonus out of
    // range; both are clamped.
    assert.equal(scoreAnswer({ ...base, timeMs: -99_999 }).speed, SCORE_MAX_SPEED_BONUS);
    assert.equal(scoreAnswer({ ...base, timeMs: 999_999 }).speed, 0);
  });

  it("describes the rules in force in the lobby", () => {
    const summary = scoringSummaryHe("CLASSIC_BATTLE", true);
    assert.match(summary, /100/);
    assert.match(summary, /רצף/);
    assert.match(summary, /רמז/);
    assert.doesNotMatch(scoringSummaryHe("EVERYONE_ANSWERS", false), /רצף/);
  });
});

// -------------------------------------------------------------- standings

function player(partial: Partial<PublicPlayer> & { id: string }): PublicPlayer {
  return {
    name: partial.id,
    isHost: false,
    connected: true,
    reconnecting: false,
    team: null,
    score: 0,
    streak: 0,
    correctCount: 0,
    wrongCount: 0,
    bestStreak: 0,
    averageResponseMs: null,
    joinedAt: 0,
    ...partial,
  };
}

describe("standings and tie-breaking", () => {
  it("orders by score first", () => {
    const standings = buildStandings([
      player({ id: "a", score: 800 }),
      player({ id: "b", score: 1450 }),
      player({ id: "c", score: 1320 }),
    ]);
    assert.deepEqual(standings.map((s) => s.playerId), ["b", "c", "a"]);
    assert.deepEqual(standings.map((s) => s.position), [1, 2, 3]);
  });

  it("breaks a score tie on correct answers", () => {
    const standings = buildStandings([
      player({ id: "a", score: 500, correctCount: 3 }),
      player({ id: "b", score: 500, correctCount: 5 }),
    ]);
    assert.equal(standings[0].playerId, "b");
  });

  it("breaks a score-and-correct tie on average response time, fastest first", () => {
    const standings = buildStandings([
      player({ id: "slow", score: 500, correctCount: 4, averageResponseMs: 9000 }),
      player({ id: "fast", score: 500, correctCount: 4, averageResponseMs: 3000 }),
    ]);
    assert.equal(standings[0].playerId, "fast");
  });

  it("places a player who answered nothing last on the response-time key", () => {
    const standings = buildStandings([
      player({ id: "silent", score: 0, averageResponseMs: null }),
      player({ id: "slow", score: 0, averageResponseMs: 19_000 }),
    ]);
    assert.equal(standings[0].playerId, "slow");
  });

  it("shares a position when every tiebreak is identical, and consumes the ranks", () => {
    const standings = buildStandings([
      player({ id: "a", score: 500, correctCount: 4, averageResponseMs: 3000 }),
      player({ id: "b", score: 500, correctCount: 4, averageResponseMs: 3000 }),
      player({ id: "c", score: 100 }),
    ]);
    assert.deepEqual(standings.map((s) => s.position), [1, 1, 3]);
    assert.deepEqual(winnerIdsFrom(standings), ["a", "b"]);
  });

  it("orders a shared position deterministically so every client renders the same list", () => {
    const one = player({ id: "zzz", score: 500, joinedAt: 10 });
    const two = player({ id: "aaa", score: 500, joinedAt: 20 });
    assert.ok(comparePlayers(one, two) < 0, "earlier joiner is listed first");
    assert.deepEqual(buildStandings([two, one]).map((s) => s.playerId), ["zzz", "aaa"]);
  });

  it("computes accuracy over answered questions only", () => {
    const standings = buildStandings([player({ id: "a", correctCount: 3, wrongCount: 1 })]);
    assert.equal(standings[0].accuracy, 75);
    assert.equal(buildStandings([player({ id: "b" })])[0].accuracy, 0);
  });
});

describe("teams", () => {
  it("sums member scores into a team total", () => {
    const players = [
      player({ id: "a", team: "GREEN", score: 700 }),
      player({ id: "b", team: "GREEN", score: 540 }),
      player({ id: "c", team: "GOLD", score: 900 }),
    ];
    assert.deepEqual(teamTotals(players), { GREEN: 1240, GOLD: 900 });
    const result = buildTeamResult(players, { GREEN: "הירוקים", GOLD: "הזהובים" });
    assert.equal(result.winner, "GREEN");
  });

  it("reports a level team score as no winner", () => {
    const result = buildTeamResult(
      [player({ id: "a", team: "GREEN", score: 500 }), player({ id: "b", team: "GOLD", score: 500 })],
      { GREEN: "הירוקים", GOLD: "הזהובים" }
    );
    assert.equal(result.winner, null);
  });

  it("picks the MVP across both teams, so it can be somebody on the losing side", () => {
    const result = buildTeamResult(
      [
        player({ id: "star", team: "GOLD", score: 1240, correctCount: 9 }),
        player({ id: "a", team: "GREEN", score: 700, correctCount: 5 }),
        player({ id: "b", team: "GREEN", score: 650, correctCount: 5 }),
      ],
      { GREEN: "הירוקים", GOLD: "הזהובים" }
    );
    assert.equal(result.winner, "GREEN", "green wins on the aggregate");
    assert.equal(result.mvpPlayerId, "star", "the MVP is the best individual regardless of side");
  });

  it("auto-balances to sizes differing by at most one, in join order", () => {
    const players = [1, 2, 3, 4, 5].map((n) => player({ id: `p${n}`, joinedAt: n }));
    const assignment = autoBalance(players);
    const green = players.filter((p) => assignment.get(p.id) === "GREEN").length;
    const gold = players.filter((p) => assignment.get(p.id) === "GOLD").length;
    assert.ok(Math.abs(green - gold) <= 1);
    assert.equal(assignment.get("p1"), "GREEN");
    assert.equal(assignment.get("p2"), "GOLD");
  });
});

// ----------------------------------------------------------------- protocol

describe("client message parsing", () => {
  it("accepts the messages the protocol defines", () => {
    assert.deepEqual(parseClientMessage('{"type":"START_GAME"}'), { type: "START_GAME" });
    assert.deepEqual(parseClientMessage('{"type":"JOIN_ROOM","name":"נאור"}'), {
      type: "JOIN_ROOM",
      name: "נאור",
    });
    assert.deepEqual(parseClientMessage('{"type":"SEND_REACTION","emoji":"🔥"}'), {
      type: "SEND_REACTION",
      emoji: "🔥",
    });
  });

  it("rejects unknown types, non-objects and malformed JSON", () => {
    assert.equal(parseClientMessage('{"type":"GRANT_ME_POINTS"}'), null);
    assert.equal(parseClientMessage("[]"), null);
    assert.equal(parseClientMessage("null"), null);
    assert.equal(parseClientMessage("not json"), null);
    assert.equal(parseClientMessage('{"noType":1}'), null);
  });

  it("refuses an oversized payload before parsing it", () => {
    const huge = `{"type":"JOIN_ROOM","name":"${"a".repeat(10_000)}"}`;
    assert.equal(parseClientMessage(huge), null);
  });

  it("drops every field a client must not control", () => {
    // A client sending its own score, correctness, turn or points gets a message
    // carrying none of them: the parser rebuilds from a fixed shape rather than
    // casting the blob.
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "SUBMIT_ANSWER",
        questionIndex: 2,
        optionId: 17,
        typed: null,
        score: 99_999,
        correct: true,
        points: 5000,
        isHost: true,
        playerId: "someone-else",
      })
    );
    assert.deepEqual(parsed, {
      type: "SUBMIT_ANSWER",
      questionIndex: 2,
      optionId: 17,
      typed: null,
      reveal: false,
    });
  });

  it("rejects a negative or non-integer question index", () => {
    assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER","questionIndex":-1,"optionId":1}'), null);
    assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER","questionIndex":1.5,"optionId":1}'), null);
    assert.equal(parseClientMessage('{"type":"REQUEST_HINT","questionIndex":-3}'), null);
  });

  it("rejects an option id that is not an integer", () => {
    assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER","questionIndex":0,"optionId":"1"}'), null);
    assert.equal(parseClientMessage('{"type":"SUBMIT_ANSWER","questionIndex":0,"optionId":1.2}'), null);
  });

  it("rejects a reaction that is not on the fixed list", () => {
    assert.equal(parseClientMessage('{"type":"SEND_REACTION","emoji":"🖕"}'), null);
    assert.equal(parseClientMessage('{"type":"SEND_REACTION","emoji":"<img onerror=x>"}'), null);
  });

  it("caps a typed free-text answer instead of relaying it whole", () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: "SUBMIT_ANSWER", questionIndex: 0, typed: "x".repeat(500) })
    );
    assert.equal((parsed as { typed: string }).typed.length, 120);
  });
});

describe("settings patches", () => {
  it("keep only values the product defines", () => {
    const patch = parseSettingsPatch({
      mode: "TURN_BASED",
      questionCount: 20,
      difficulty: "HARD",
      secondsPerQuestion: 15,
      hintsAllowed: false,
      categories: ["PLAYERS", "NOT_A_CATEGORY"],
      competitions: ["UCL", "MADE_UP_LEAGUE"],
      countries: ["ENG", "ZZZ"],
      region: "EUROPE",
      answerMode: "FREE_TEXT",
      gameMode: "WHO_AM_I",
    });
    assert.equal(patch.mode, "TURN_BASED");
    assert.equal(patch.questionCount, 20);
    assert.equal(patch.difficulty, "HARD");
    assert.deepEqual(patch.categories, ["PLAYERS"]);
    assert.deepEqual(patch.competitions, ["UCL"]);
    assert.deepEqual(patch.countries, ["ENG"]);
    assert.equal(patch.answerMode, "FREE_TEXT");
    assert.equal(patch.gameMode, "WHO_AM_I");
  });

  it("ignore invalid values entirely rather than falling back to a default", () => {
    // Absence matters: a key that is dropped leaves the room's current setting
    // alone, where a defaulted key would silently reset it.
    const patch = parseSettingsPatch({
      questionCount: 7,
      secondsPerQuestion: 3,
      difficulty: "TRIVIAL",
      answerMode: "TELEPATHY",
      gameMode: "HIGHER_LOWER",
    });
    assert.equal("questionCount" in patch, false);
    assert.equal("secondsPerQuestion" in patch, false);
    assert.equal("difficulty" in patch, false);
    assert.equal("answerMode" in patch, false);
    // HIGHER_LOWER is defined in the type but disabled in the product; a room
    // must not be the back door that turns it on.
    assert.equal("gameMode" in patch, false);
  });

  it("do not let a host cap-bust the question count or the timer", () => {
    assert.equal("questionCount" in parseSettingsPatch({ questionCount: 5000 }), false);
    assert.equal("secondsPerQuestion" in parseSettingsPatch({ secondsPerQuestion: 100000 }), false);
  });

  it("clean team names and ignore empty ones", () => {
    assert.deepEqual(parseSettingsPatch({ teamNames: { GREEN: "  הצוות  " } }).teamNames, {
      GREEN: "הצוות",
    });
    assert.equal("teamNames" in parseSettingsPatch({ teamNames: { GREEN: "   " } }), false);
  });
});

describe("app chat is presets only", () => {
  it("shows a preset everywhere, and free text only off the app", () => {
    assert.equal(shouldShowMessage("VAR בבקשה", true), true);
    assert.equal(shouldShowMessage("anything typed", true), false);
    assert.equal(shouldShowMessage("anything typed", false), true);
  });
});
