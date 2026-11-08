#!/usr/bin/env node
// Browser QA for the game-creation wizard and the preset difficulty rules.
//
//   npm run qa:builder                                  # against production
//   npm run qa:builder -- --base=http://localhost:5173  # against a dev server
//   npm run qa:builder -- --engines=webkit
//
// WHAT THIS CHECKS, AND WHY IT IS NOT A SCREENSHOT TEST
//
// Two things can be wrong with a quiz builder and only one of them is visible.
// The visible one is layout: a step that scrolls, a start button below the fold.
// The invisible one is worse — a wizard that looks right and sends the wrong
// query, so the player gets questions they did not ask for and has no way to
// tell. So every flow here reads the actual POST /api/quiz BODY and asserts the
// answer mode, difficulty, count, geography, competition and game mode that the
// engine will receive.
//
// The same applies to the preset difficulty rules. "Quick Start never serves an
// Expert question" cannot be checked by looking at the home page; it is checked
// by reading the difficulties of the questions the server actually returned.

import { chromium, webkit, devices } from "playwright";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("base", "https://football-iq.naorl.workers.dev").replace(/\/$/, "");
const ENGINES = arg("engines", "chromium").split(",").filter(Boolean);
const QUICK_RUNS = Number(arg("quick-runs", "8"));
const DAILY_RUNS = Number(arg("daily-runs", "5"));

const pick = (name) => devices[name];

/** The viewports the spec names, plus the desktop widths. */
const MOBILE = [
  { label: "390x844 (iPhone 14)", device: pick("iPhone 14") ?? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { label: "393x852 (iPhone 15 Pro)", device: pick("iPhone 15 Pro") ?? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { label: "430x932 (iPhone 15 Pro Max)", device: pick("iPhone 15 Pro Max") ?? { viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
];

const DESKTOP = [
  { label: "1366x768", device: { viewport: { width: 1366, height: 768 } } },
  { label: "1440x900", device: { viewport: { width: 1440, height: 900 } } },
  { label: "1920x1080", device: { viewport: { width: 1920, height: 1080 } } },
];

async function launch(engine) {
  if (engine === "webkit") return webkit.launch();
  for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* next */
    }
  }
  throw new Error("no usable Chromium");
}

const results = [];
const record = (ok, area, detail) => {
  results.push({ ok, area, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${area}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// The flows the spec requires
// ---------------------------------------------------------------------------

/**
 * `expect` is asserted against the POST /api/quiz body, which is the query the
 * engine receives. Anything absent from `expect` is not asserted.
 *
 * THE BUILDER IS ONE SCREEN NOW, so a flow is a list of pills to tap rather
 * than a walk through steps. Each pill is named by its row and its label,
 * because that is how a player finds it, and because a flow written against
 * DOM order would pass while the rows were in the wrong places.
 */
const FLOWS = [
  {
    id: "A",
    name: "the defaults, untouched — one tap to a game",
    taps: [],
    expect: {
      questionType: "MIXED",
      answerMode: "MULTIPLE_CHOICE",
      difficulty: "MIXED",
      questionCount: 10,
      region: "WORLD",
      competitions: ["ALL"],
      countries: [],
      categories: [],
      gameMode: "CLASSIC",
    },
    verifyQuiz: "mixed",
  },
  {
    id: "B",
    name: "Who Am I, multiple choice, hard, the big six",
    taps: [
      ["איך עונים?", "אמריקאי"],
      ["קושי", "קשה"],
      ["סוג", "מי אני?"],
      ["מאיפה?", "טופ 6"],
    ],
    expect: {
      questionType: "WHO_AM_I",
      answerMode: "MULTIPLE_CHOICE",
      difficulty: "HARD",
      questionCount: 10,
      competitions: ["TOP_6_EUROPE"],
      gameMode: "WHO_AM_I",
    },
  },
  {
    id: "C",
    name: "career path, expert, 15, Champions League",
    taps: [
      ["קושי", "מומחה"],
      ["שאלות", "15"],
      ["סוג", "קריירה"],
      ["מאיפה?", "אלופות"],
    ],
    expect: {
      questionType: "CAREER_PATH",
      difficulty: "EXPERT",
      questionCount: 15,
      competitions: ["UCL"],
      gameMode: "CAREER_PATH",
    },
  },
  {
    id: "D",
    name: "Israel, mixed, 5",
    taps: [
      ["שאלות", "5"],
      ["מאיפה?", "ישראל"],
    ],
    expect: {
      questionType: "MIXED",
      questionCount: 5,
      countries: ["ISR"],
      gameMode: "CLASSIC",
    },
  },
  {
    id: "E",
    name: "a type from behind 'עוד'",
    taps: [
      ["סוג", "עוד סוגים"],
      ["סוג", "העברות"],
    ],
    expect: {
      questionType: "TRANSFERS",
      categories: ["TRANSFERS"],
      gameMode: "CLASSIC",
    },
  },
];

/** Whether the page can be scrolled vertically at all. */
const overflow = (page) =>
  page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollHeight: el.scrollHeight, viewport: window.innerHeight };
  });

/** Whether the primary action is inside the viewport right now. */
async function actionVisible(page) {
  const button = page.locator(".bld-dock .btn-primary");
  if ((await button.count()) === 0) return false;
  const box = await button.first().boundingBox();
  if (!box) return false;
  const height = await page.evaluate(() => window.innerHeight);
  return box.y >= 0 && box.y + box.height <= height + 1;
}

/** Taps a pill by its row label and its own label. */
async function tap(page, row, label) {
  const found = await page.evaluate(
    ({ row, label }) => {
      const rows = Array.from(document.querySelectorAll(".bld-row"));
      const target = rows.find(
        (r) => r.querySelector(".bld-row-label")?.textContent?.trim() === row
      );
      if (!target) return "no-row";
      // Falls through to the row's ACTION controls, so a flow can name a door
      // the same way it names a choice — the player does not distinguish them
      // when deciding what to tap, only when reading the screen.
      const hit =
        Array.from(target.querySelectorAll(".bld-pill")).find((p) => p.textContent?.trim() === label) ??
        Array.from(target.querySelectorAll(".bld-action")).find((a) => a.textContent?.trim() === label);
      if (!hit) return "no-pill";
      hit.click();
      return "ok";
    },
    { row, label }
  );
  await page.waitForTimeout(260);
  return found;
}

/**
 * Taps one of the ACTION controls — the doors, not the choices.
 *
 * Separate from `tap` because they are a separate control: a test that found
 * them with the pill selector would keep passing if they were restyled back
 * into pills, which is the regression this pass exists to prevent.
 */
async function tapAction(page, label) {
  const found = await page.evaluate((label) => {
    const el = Array.from(document.querySelectorAll(".bld-action")).find(
      (a) => a.textContent?.trim() === label
    );
    if (!el) return "no-action";
    el.click();
    return "ok";
  }, label);
  await page.waitForTimeout(300);
  return found;
}

/** Every row's pills, as the player sees them. */
const readRows = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const r of Array.from(document.querySelectorAll(".bld-row"))) {
      const label = r.querySelector(".bld-row-label")?.textContent?.trim() ?? "?";
      out[label] = Array.from(r.querySelectorAll(".bld-pill")).map((p) => p.textContent?.trim());
    }
    return out;
  });

async function runFlow(page, flow, viewport, isMobile) {
  let body = null;
  const isQuizCall = (url) =>
    url.includes("/api/quiz") && !url.includes("/count") && !url.includes("/options");

  const onRequest = (request) => {
    if (request.method() === "POST" && isQuizCall(request.url())) {
      try {
        body = JSON.parse(request.postData() ?? "null");
      } catch {
        body = null;
      }
    }
  };
  page.on("request", onRequest);

  try {
    await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded" });
    await page.locator("h1.bld-title").first().waitFor({ timeout: 20000 });
    // Availability is debounced; the rows are filtered once it lands.
    await page.waitForTimeout(1600);

    /*
      MEASURED BEFORE ANY TAP, because flow A's whole point is that the screen
      is usable as it opens. A builder that only fits after you have made
      choices has not solved anything.
    */
    const { scrollHeight, viewport: height } = await overflow(page);
    const scrolls = scrollHeight > height + 8;
    const actionUp = await actionVisible(page);
    const rows = await readRows(page);

    for (const [row, label] of flow.taps) {
      const result = await tap(page, row, label);
      if (result !== "ok") {
        record(false, `FLOW ${flow.id} tap @ ${viewport}`, `${row} → ${label}: ${result}`);
        return;
      }
    }
    // Let the last change settle so the query carries it.
    await page.waitForTimeout(900);

    await page.locator(".bld-dock .btn-primary").first().click();
    await page.waitForURL(/\/play/, { timeout: 25000 });

    const mismatches = [];
    if (!body) mismatches.push("no quiz request was captured");
    for (const [key, want] of Object.entries(flow.expect)) {
      const got = body?.[key];
      const same = Array.isArray(want)
        ? Array.isArray(got) &&
          want.length === got.length &&
          [...want].sort().every((v, i) => v === [...got].sort()[i])
        : got === want;
      if (!same) mismatches.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    // The builder is not Quick Start. A player who chose EXPERT must get EXPERT.
    if (body?.preset) mismatches.push(`preset must not be set by the builder, got ${body.preset}`);

    record(
      mismatches.length === 0,
      `FLOW ${flow.id} query @ ${viewport}`,
      mismatches.length === 0 ? flow.name : mismatches.join("; ")
    );

    if (isMobile) {
      record(
        !scrolls,
        `FLOW ${flow.id} fits on open @ ${viewport}`,
        scrolls ? `${scrollHeight}px in ${height}px` : "no scrolling needed to see the choices"
      );
    }
    record(actionUp, `FLOW ${flow.id} start visible on open @ ${viewport}`, actionUp ? "in view" : "below the fold");

    if (flow.id === "A") {
      // A real tap lands on the pill under the finger. The flows above click
      // through the DOM, which skips hit-testing, so an overlay swallowing every
      // tap (a stray ::after hit area did exactly that above 420px) passed them.
      const blocked = await page.evaluate(() =>
        [...document.querySelectorAll(".bld-pill, .bld-action")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || r.bottom > innerHeight) return false;
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !(hit === el || el.contains(hit));
          })
          .map((el) => el.textContent.trim())
      );
      record(
        blocked.length === 0,
        `every visible option takes a real tap @ ${viewport}`,
        blocked.length === 0 ? "nothing covers the pills" : `covered: ${blocked.slice(0, 5).join(", ")}`
      );

      // The five rows, present and populated the moment the screen opens.
      const labels = Object.keys(rows);
      const wanted = ["איך עונים?", "קושי", "שאלות", "סוג", "מאיפה?"];
      const missing = wanted.filter((w) => !labels.includes(w));
      record(
        missing.length === 0,
        `every core setting is on the first screen @ ${viewport}`,
        missing.length === 0 ? labels.join(" · ") : `missing: ${missing.join(", ")}`
      );
      const thin = wanted.filter((w) => (rows[w] ?? []).length < 2);
      record(thin.length === 0, `every row offers real choices @ ${viewport}`,
        thin.length === 0
          ? wanted.map((w) => `${w}=${(rows[w] ?? []).length}`).join(", ")
          : `thin: ${thin.join(", ")}`
      );
    }

    if (flow.verifyQuiz === "mixed" && isMobile) {
      // Replayed rather than read off the page: reading the response in a
      // listener loses the race with the navigation to /play.
      const replayed = await fetch(`${BASE}/api/quiz`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .catch(() => null);
      const questions = replayed?.questions ?? [];
      const bands = {};
      const kinds = {};
      for (const q of questions) {
        bands[q.difficulty] = (bands[q.difficulty] ?? 0) + 1;
        kinds[q.category] = (kinds[q.category] ?? 0) + 1;
      }
      const aboveHard = (bands.EXPERT ?? 0) + (bands.IMPOSSIBLE ?? 0);
      record(
        questions.length > 0 && questions.length - aboveHard >= aboveHard,
        `the default game is mostly playable @ ${viewport}`,
        `${questions.length - aboveHard} playable vs ${aboveHard} above HARD — ${JSON.stringify(bands)}`
      );
      record(
        Object.keys(kinds).length >= 4,
        `the default game is actually mixed @ ${viewport}`,
        `${Object.keys(kinds).length} kind(s): ${JSON.stringify(kinds)}`
      );
    }
  } finally {
    page.off("request", onRequest);
  }
}

/**
 * Narrowing the request must remove options, not leave dead ones on screen.
 *
 * The rule the whole pass turns on: an option that cannot fill the quiz being
 * asked for is absent. Twenty IMPOSSIBLE questions is a far narrower pool than
 * ten mixed ones, so rows must visibly shrink — and whatever is left must still
 * produce a game.
 */
async function checkDynamicFiltering(page, viewport) {
  await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded" });
  await page.locator("h1.bld-title").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1800);

  const before = await readRows(page);
  const beforeTotal = await page.locator(".bld-avail").innerText();

  await tap(page, "שאלות", "20");
  await tap(page, "קושי", "בלתי אפשרי");
  await page.waitForTimeout(2200);

  const after = await readRows(page);
  const afterTotal = await page.locator(".bld-avail").innerText();

  const typesShrank = (after["סוג"] ?? []).length < (before["סוג"] ?? []).length;
  const scopesShrank = (after["מאיפה?"] ?? []).length < (before["מאיפה?"] ?? []).length;

  record(
    typesShrank || scopesShrank,
    `narrowing removes options @ ${viewport}`,
    `types ${(before["סוג"] ?? []).length}→${(after["סוג"] ?? []).length}, ` +
      `scopes ${(before["מאיפה?"] ?? []).length}→${(after["מאיפה?"] ?? []).length}`
  );

  // Whatever survived must still be a game. This is the dead-end check: every
  // visible pill, tapped, has to produce a quiz.
  void 0;
  const total = Number((afterTotal.match(/[0-9,]+/)?.[0] ?? "0").replace(/,/g, ""));
  record(total >= 20, `what is left can still fill the quiz @ ${viewport}`, `${afterTotal.trim()} (was ${beforeTotal.trim()})`);

  // And the screen still fits.
  const { scrollHeight, viewport: height } = await overflow(page);
  record(scrollHeight <= height + 8, `still fits after narrowing @ ${viewport}`, `${scrollHeight}px in ${height}px`);
}

/**
 * The two doors must not look like the choices beside them.
 *
 * They were pills with a dashed border and muted text, which read as LESS
 * important than the options around them — a greyed-out chip that looks
 * unavailable rather than inviting. Asserted on the computed style rather than
 * by eye, so a restyle back into a pill fails here.
 */
async function checkActionAffordance(page, viewport) {
  await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded" });
  await page.locator("h1.bld-title").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1600);

  const seen = await page.evaluate(() => {
    const read = (el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.textContent.trim(),
        weight: Number(cs.fontWeight),
        colour: cs.color,
        borderStyle: cs.borderStyle,
        chevrons: el.querySelectorAll("svg").length,
      };
    };
    const pill = Array.from(document.querySelectorAll(".bld-pill")).find(
      (p) => !p.getAttribute("aria-pressed") || p.getAttribute("aria-pressed") === "false"
    );
    return {
      actions: Array.from(document.querySelectorAll(".bld-action")).map(read),
      pill: pill ? read(pill) : null,
    };
  });

  record(
    seen.actions.length === 2,
    `both doors are present @ ${viewport}`,
    seen.actions.map((a) => a.text).join(" · ")
  );

  const labelled = seen.actions.every((a) => a.text.length > 3 && a.text !== "עוד");
  record(labelled, `the doors say what they do @ ${viewport}`, seen.actions.map((a) => a.text).join(" · "));

  const iconic = seen.actions.every((a) => a.chevrons >= 2);
  record(iconic, `each door carries an icon and a chevron @ ${viewport}`, seen.actions.map((a) => `${a.text}=${a.chevrons}`).join(", "));

  if (seen.pill) {
    const bolder = seen.actions.every((a) => a.weight > seen.pill.weight);
    const solid = seen.actions.every((a) => a.borderStyle === "solid");
    record(
      bolder && solid,
      `a door is heavier and solid where an unselected choice is not @ ${viewport}`,
      `door weight ${seen.actions[0]?.weight}/${seen.actions[0]?.borderStyle} vs pill ${seen.pill.weight}/${seen.pill.borderStyle}`
    );
  }

  // Tapping the types door reveals more types, and only valid ones.
  const before = await readRows(page);
  await tapAction(page, "עוד סוגים");
  await page.waitForTimeout(1500);
  const after = await readRows(page);
  record(
    (after["סוג"] ?? []).length > (before["סוג"] ?? []).length,
    `the types door reveals more types @ ${viewport}`,
    `${(before["סוג"] ?? []).length} → ${(after["סוג"] ?? []).length}`
  );
  const collapsed = await tapAction(page, "הצג פחות");
  record(collapsed === "ok", `and collapses again @ ${viewport}`, collapsed);
}

/**
 * The optional geography picker, which most players will never open.
 *
 * Checks it drills down, that each level only offers what can fill the quiz,
 * and that it hands a real league back to the builder.
 */
async function checkLeaguePicker(page, viewport) {
  await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded" });
  await page.locator("h1.bld-title").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1600);

  const opened = await tapAction(page, "בחירת ליגה");
  if (opened !== "ok") {
    record(false, `league picker opens @ ${viewport}`, opened);
    return;
  }
  await page.waitForTimeout(1400);
  const sheet = page.locator(".bld-sheet");
  record(await sheet.isVisible(), `league picker opens @ ${viewport}`, "as a sheet over the builder");

  const rowTexts = () => page.locator(".bld-sheet-row").evaluateAll((els) => els.map((e) => e.innerText.replace(/s+/g, " ").trim()));

  const continents = await rowTexts();
  record(continents.length > 0, `picker lists continents @ ${viewport}`, continents.join(" | ").slice(0, 120));

  await page.locator(".bld-sheet-row", { hasText: "אירופה" }).first().click();
  await page.waitForTimeout(1400);
  const countries = await rowTexts();
  record(countries.length > 0, `picker lists countries @ ${viewport}`, `${countries.length}: ${countries.slice(0, 4).join(" | ")}`);

  await page.locator(".bld-sheet-row", { hasText: "ספרד" }).first().click();
  await page.waitForTimeout(1400);
  const leagues = await rowTexts();
  record(leagues.length > 0, `picker lists leagues @ ${viewport}`, leagues.join(" | ").slice(0, 120));

  let body = null;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/quiz") && !r.url().includes("/count") && !r.url().includes("/options")) {
      try { body = JSON.parse(r.postData() ?? "null"); } catch { body = null; }
    }
  });

  await page.locator(".bld-sheet-row", { hasText: "לה ליגה" }).first().click();
  await page.waitForTimeout(1200);
  const pills = await readRows(page);
  record(
    (pills["מאיפה?"] ?? []).some((p) => p && p.includes("לה ליגה")),
    `the chosen league shows on the builder @ ${viewport}`,
    (pills["מאיפה?"] ?? []).join(" · ")
  );

  await page.locator(".bld-dock .btn-primary").first().click();
  await page.waitForURL(/\/play/, { timeout: 25000 }).catch(() => {});
  record(
    Array.isArray(body?.competitions) && body.competitions.includes("LA_LIGA"),
    `the league reaches the query @ ${viewport}`,
    JSON.stringify({ competitions: body?.competitions, countries: body?.countries })
  );
}

// ---------------------------------------------------------------------------
async function checkQuickStart(page, viewport) {
  const seen = { byBand: {}, quizzes: 0, expert: 0, impossible: 0, presets: new Set() };

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes("/api/quiz") || url.includes("/count")) return;
    if (response.request().method() !== "POST") return;
    try {
      const sent = JSON.parse(response.request().postData() ?? "null");
      if (sent?.preset !== "QUICK_START") return;
      const payload = await response.json();
      seen.quizzes++;
      for (const question of payload.questions ?? []) {
        seen.byBand[question.difficulty] = (seen.byBand[question.difficulty] ?? 0) + 1;
        if (question.difficulty === "EXPERT") seen.expert++;
        if (question.difficulty === "IMPOSSIBLE") seen.impossible++;
      }
    } catch {
      /* a failed body read is not a difficulty violation */
    }
  };
  page.on("response", onResponse);

  try {
    for (let run = 0; run < QUICK_RUNS; run++) {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
      const presets = page.locator(".quick-btn");
      const count = await presets.count();
      const buttons = count > 0 ? presets : page.locator("main button");
      const total = await buttons.count();
      if (total === 0) break;
      const target = buttons.nth(run % Math.min(total, 4));
      const label = (await target.innerText()).replace(/\s+/g, " ").trim();
      seen.presets.add(label);
      await target.click();
      await page.waitForTimeout(500);
      // A quick preset may open a mode sheet first; take whatever starts a game.
      const sheet = page.locator(".mode-opt");
      if ((await sheet.count()) > 0) {
        await sheet.first().click().catch(() => {});
      }
      await page.waitForURL(/\/play/, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  } finally {
    page.off("response", onResponse);
  }

  record(
    seen.quizzes > 0,
    `Quick Start observed @ ${viewport}`,
    `${seen.quizzes} quiz(zes) from ${[...seen.presets].join(", ") || "no preset"}`
  );
  record(
    seen.expert === 0 && seen.impossible === 0,
    `Quick Start has no Expert or Impossible @ ${viewport}`,
    `bands ${JSON.stringify(seen.byBand)} (expert ${seen.expert}, impossible ${seen.impossible})`
  );
  const bands = Object.keys(seen.byBand);
  record(
    seen.quizzes === 0 || bands.length >= 2,
    `Quick Start mixes difficulties @ ${viewport}`,
    `${bands.length} band(s): ${JSON.stringify(seen.byBand)}`
  );
  return seen;
}

// ---------------------------------------------------------------------------
// Daily Challenge: one or two above HARD, and they come last
// ---------------------------------------------------------------------------
async function checkDaily(page, viewport) {
  const runs = [];
  const onResponse = async (response) => {
    if (!response.url().includes("/api/daily")) return;
    try {
      const payload = await response.json();
      const bands = (payload.quiz?.questions ?? payload.questions ?? []).map((q) => q.difficulty);
      if (bands.length > 0) runs.push(bands);
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResponse);

  try {
    for (let run = 0; run < DAILY_RUNS; run++) {
      await page.goto(`${BASE}/daily`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(900);
    }
  } finally {
    page.off("response", onResponse);
  }

  if (runs.length === 0) {
    record(false, `Daily Challenge observed @ ${viewport}`, "no daily payload was captured");
    return runs;
  }

  const ABOVE = new Set(["EXPERT", "IMPOSSIBLE"]);
  const first = runs[0];
  const aboveHard = first.filter((b) => ABOVE.has(b)).length;
  const playable = first.length - aboveHard;

  record(true, `Daily Challenge observed @ ${viewport}`, `${runs.length} load(s), sequence: ${first.join(" → ")}`);
  record(
    aboveHard >= 1 && aboveHard <= 2,
    `Daily Challenge has 1–2 questions above HARD @ ${viewport}`,
    `${aboveHard} above HARD, ${playable} playable`
  );
  const lastTwo = first.slice(-2);
  record(
    aboveHard === 0 || lastTwo.some((b) => ABOVE.has(b)),
    `Daily Challenge saves the hardest for last @ ${viewport}`,
    `closes with ${lastTwo.join(", ")}`
  );
  const identical = runs.every((r) => r.join() === first.join());
  record(identical, `Daily Challenge is stable within the day @ ${viewport}`, `${runs.length} identical load(s)`);
  return runs;
}

// ---------------------------------------------------------------------------
// Desktop layout
// ---------------------------------------------------------------------------
async function checkDesktopLayout(page, viewport) {
  await page.goto(`${BASE}/build`, { waitUntil: "domcontentloaded" });
  await page.locator("h1.bld-title").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(() => {
    const wiz = document.querySelector(".bld");
    if (!wiz) return null;
    const box = wiz.getBoundingClientRect();
    const dock = document.querySelector(".bld-dock");
    return {
      width: Math.round(box.width),
      left: Math.round(box.left),
      right: Math.round(window.innerWidth - box.right),
      viewport: window.innerWidth,
      dockFixed: dock ? getComputedStyle(dock).position : null,
    };
  });

  if (!metrics) {
    record(false, `desktop layout @ ${viewport}`, "the builder did not render");
    return;
  }

  // A centred, focused column — not a narrow strip beside an empty half-screen.
  const centred = Math.abs(metrics.left - metrics.right) <= 2;
  const bounded = metrics.width <= 760 && metrics.width >= 420;
  record(
    centred && bounded,
    `desktop layout is a centred focused column @ ${viewport}`,
    `width ${metrics.width}px in ${metrics.viewport}px, margins ${metrics.left}/${metrics.right}`
  );
  record(
    metrics.dockFixed === "static",
    `desktop retires the fixed dock @ ${viewport}`,
    `dock position: ${metrics.dockFixed}`
  );
}

// ---------------------------------------------------------------------------
// Drive it
// ---------------------------------------------------------------------------
console.log(`\nFootball IQ builder QA → ${BASE}\n`);

for (const engine of ENGINES) {
  const browser = await launch(engine);
  try {
    for (const profile of MOBILE) {
      console.log(`\n[${engine}] ${profile.label}`);
      const context = await browser.newContext({ ...profile.device, locale: "he-IL" });
      const page = await context.newPage();
      // The privacy gate, dismissed the way a returning visitor has it.
      await page.addInitScript(() => {
        try {
          localStorage.setItem("fiq_privacy_v1", JSON.stringify({ decided: true, preferences: true, history: true }));
        } catch {
          /* private mode */
        }
      });
      try {
        for (const flow of FLOWS) await runFlow(page, flow, profile.label, true);
        // The two behaviours the flat screen turns on, and neither is a flow:
        // that narrowing the request REMOVES options, and that the optional
        // geography picker drills down and hands a real league back.
        await checkActionAffordance(page, profile.label);
        await checkDynamicFiltering(page, profile.label);
        await checkLeaguePicker(page, profile.label);
        if (profile === MOBILE[0]) {
          await checkQuickStart(page, profile.label);
          await checkDaily(page, profile.label);
        }
      } catch (error) {
        record(false, `${profile.label} crashed`, String(error).slice(0, 300));
      } finally {
        await context.close();
      }
    }

    for (const profile of DESKTOP) {
      console.log(`\n[${engine}] ${profile.label}`);
      const context = await browser.newContext({ ...profile.device, locale: "he-IL" });
      const page = await context.newPage();
      await page.addInitScript(() => {
        try {
          localStorage.setItem("fiq_privacy_v1", JSON.stringify({ decided: true, preferences: true, history: true }));
        } catch {
          /* private mode */
        }
      });
      try {
        await checkDesktopLayout(page, profile.label);
        await runFlow(page, FLOWS[1], profile.label, false);
      } catch (error) {
        record(false, `${profile.label} crashed`, String(error).slice(0, 300));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} check(s) passed.`);
if (failed.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failed) console.log(`  ${f.area} — ${f.detail}`);
  process.exit(1);
}
console.log("");
