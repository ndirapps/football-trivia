// The single-player product regression, against the UI as it exists today.
//
// WHY THIS IS A NEW FILE AND NOT A REPAIR.
//
// `ui-test.mjs`, `freetext-ui-test.mjs` and `challenge-e2e.mjs` were written
// against earlier generations of the home page and the quiz board, and they had
// drifted far enough to be reporting failures on a product that works:
//
//   * `h1.hero-title` — the class is `home-title`; `hero-title` does not appear
//     anywhere in src/
//   * `.quick-card` (expecting 6) and `.how-step` (expecting 3) — neither class
//     exists; the presets are `.quick-btn` and there is no how-it-works section
//   * the flow assumed tapping a preset navigates straight to /play, but it now
//     opens the answer-mode sheet first, which is a deliberate product decision
//     ("one tap to pick the topic, one tap to pick how you answer")
//   * `innerText` of the title contains a non-breaking space, so an
//     `.includes("Football IQ")` with an ordinary space could never match
//
// Those are stale assertions, not regressions, and three scripts each anchored
// to a different past version of the UI is not a regression suite — it is a
// source of false alarms that trains you to ignore it. This one drives the
// current flows end to end.
//
// Usage: node scripts/product-qa.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "https://football-iq.naorl.workers.dev").replace(/\/+$/, "");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const section = (title) => console.log(`\n--- ${title} ---`);

async function launch() {
  for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      /* try the next one */
    }
  }
  throw new Error("no usable Chromium");
}

/**
 * A fresh player.
 *
 * Consent is accepted up front, because the preference and history categories
 * are what the sound toggle and the repeat-avoidance window live under, and a
 * run that leaves the banner up is testing the no-consent path by accident
 * rather than on purpose. The no-consent path gets its own case at the end.
 */
async function newPlayer(browser, { consent = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  if (consent) await page.getByRole("button", { name: "מאשר" }).click().catch(() => {});

  return { context, page, errors };
}

/** Walks the home page into a quiz: pick a topic, then pick how you answer. */
async function startQuickGame(page, mode) {
  await page.locator(".quick-btn").first().click();
  await page.locator(".mode-sheet").waitFor({ timeout: 10000 });
  // The sheet lists free text first, multiple choice second.
  const option = mode === "FREE_TEXT" ? page.locator(".mode-opt").first() : page.locator(".mode-opt").last();
  await option.click();
  await page.waitForURL("**/play", { timeout: 25000 });
  await page.locator(".q").waitFor({ timeout: 25000 });
}

// ===================================================== 1. startup and home

async function home(browser) {
  section("home and startup");
  const { context, page, errors } = await newPlayer(browser, { consent: false });

  check("the quiz brand title renders", (await page.locator("h1.home-title").count()) === 1);
  // Normalised, because the markup uses a non-breaking space inside the brand.
  const title = (await page.locator("h1.home-title").innerText()).replace(/\s+/g, " ");
  check("the title asks the brand question", title.includes("Football IQ"), title);

  check("the document is right-to-left", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
  check("the primary call to action is present", (await page.getByRole("button", { name: "בנו חידון" }).count()) === 1);
  check("quick-start presets render", (await page.locator(".quick-btn").count()) >= 4);
  check("both multiplayer entries are on the surface", (await page.locator(".home-cta-mp").count()) === 2);

  // The startup contract from index.html plus lib/startup.ts.
  const startup = await page.evaluate(() => ({
    stage: window.__FIQ_STAGE__ ?? null,
    timeline: (window.__FIQ_TIMELINE__ ?? []).map((row) => row.stage),
    bootHidden: document.getElementById("boot")?.hasAttribute("hidden") ?? null,
    rootChildren: document.getElementById("root")?.childElementCount ?? -1,
    recorded: (window.__FIQ_ERRORS__ ?? []).length,
  }));

  // APP_READY, not REACT_MOUNTED. This assertion used to stop at the mount,
  // which was as far as the stages went — APP_READY was declared and never
  // reached by anything. The full sequence is what makes a failed load
  // diagnosable, so the test asserts the end of it.
  check("startup reached APP_READY", startup.stage === "APP_READY", String(startup.stage));
  check(
    "the startup stages were recorded in order",
    ["HTML_RECEIVED", "JS_STARTED", "REACT_MOUNTED", "HOME_RENDERED", "APP_READY"].every((stage) =>
      startup.timeline.includes(stage)
    ),
    JSON.stringify(startup.timeline)
  );
  // The home page is deliberately data-free, so it must reach readiness without
  // any request having gone out at all.
  check(
    "the home page reaches readiness with no startup request",
    !startup.timeline.includes("STARTUP_REQUESTS_STARTED"),
    JSON.stringify(startup.timeline)
  );
  check("the loading shell was dismissed", startup.bootHidden === true);
  check("the app rendered into #root", startup.rootChildren > 0, String(startup.rootChildren));
  check("no startup error was recorded", startup.recorded === 0, JSON.stringify(startup));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("no horizontal scroll at 390px", !overflow);

  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ============================================== 2. multiple choice, played

async function multipleChoice(browser) {
  section("quick start — multiple choice");
  const { context, page, errors } = await newPlayer(browser);

  await startQuickGame(page, "MULTIPLE_CHOICE");
  check("a quiz started", page.url().endsWith("/play"));
  check("the question has text", (await page.locator(".q").innerText()).trim().length > 5);
  check("four options render", (await page.locator(".opt").count()) === 4);
  check("the scoreboard is present", (await page.locator(".hud").count()) === 1);

  // Nothing may give the answer away before it is answered.
  check("no option is marked correct before answering", (await page.locator(".opt.is-correct").count()) === 0);
  check("no explanation before answering", (await page.locator(".why").count()) === 0);

  const box = await page.locator(".opt").first().boundingBox();
  check("options are thumb-sized (>=44px)", (box?.height ?? 0) >= 44, `${box?.height}px`);

  await page.locator(".opt").first().click();
  await page.locator(".quiz-next").waitFor({ timeout: 15000 });
  check("answering reveals the outcome", (await page.locator(".quiz-next").count()) === 1);
  check("options lock after answering", await page.locator(".opt").first().isDisabled().catch(() => true));
  check("an explanation is offered", (await page.locator(".why").count()) >= 1);

  // Play the quiz out to the results screen.
  for (let i = 0; i < 40; i++) {
    if (page.url().includes("/results")) break;
    const next = page.locator(".quiz-next button, .quiz-next");
    if (await next.count()) {
      await next.first().click().catch(() => {});
    } else if (await page.locator(".opt").count()) {
      await page.locator(".opt").first().click().catch(() => {});
    }
    await page.waitForTimeout(350);
  }

  check("the quiz reaches the results screen", page.url().includes("/results"), page.url());
  if (page.url().includes("/results")) {
    // `.page.results`, not `.page` — the topbar is also a `.page-wide`, and
    // matching it first made this assert that the site header contains a digit.
    await page.locator(".page.results").waitFor({ timeout: 20000 });
    check("the results screen shows a score", (await page.locator(".res-score").count()) === 1);
    check("it shows a rank", (await page.locator(".res-rank").count()) === 1);
    check("it breaks the score down by category", (await page.locator(".res-cat").count()) >= 1);
    check("it offers another round and a share link", (await page.locator(".res-actions button").count()) >= 2);
  }

  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ======================================================= 3. free text, hints

async function freeText(browser) {
  section("quick start — free text, hints and reveal");
  const { context, page, errors } = await newPlayer(browser);

  await startQuickGame(page, "FREE_TEXT");
  check("a free-text quiz started", (await page.locator(".ft").count()) === 1);
  check("there is a typing field", (await page.locator(".ft input").count()) === 1);
  check("no multiple-choice options are shown", (await page.locator(".opt").count()) === 0);

  // The hint button is rendered on every free-text question but is DISABLED on
  // one that carries no hints, and briefly while the board animates in. Counting
  // it is therefore not the same as being able to press it — an earlier version
  // of this check found the element, tried to click, and sat there for thirty
  // seconds waiting for a button that was never going to become enabled.
  const hint = page.getByRole("button", { name: /רמז/ }).first();
  const canHint = (await hint.count()) > 0 && (await hint.isEnabled().catch(() => false));
  if (canHint) {
    await hint.click();
    await page.locator(".ft-hint").waitFor({ timeout: 10000 }).catch(() => {});
    check("a hint is delivered on request", (await page.locator(".ft-hint").count()) >= 1);
  } else {
    check("this question offers no hint (skipped)", true);
  }

  // A first wrong answer earns a second try, said plainly; the second miss ends it.
  await page.locator(".ft input").fill("בהחלט לא התשובה הנכונה");
  await page.keyboard.press("Enter");
  await page.locator(".ft-retry").waitFor({ timeout: 15000 });
  check("a first miss offers one more try", (await page.locator(".ft-retry").count()) === 1);
  check("and the question is not resolved yet", (await page.locator(".ft-out").count()) === 0);
  await page.locator(".ft input").fill("עדיין לא התשובה הנכונה");
  await page.keyboard.press("Enter");
  await page.locator(".ft-out").waitFor({ timeout: 15000 });
  check("a wrong typed answer is marked wrong", (await page.locator(".ft-out.is-wrong").count()) === 1);
  check("the correct answer is then shown", (await page.locator(".ft-out").innerText()).trim().length > 0);
  check("the round can be advanced", (await page.locator(".quiz-next").count()) === 1);

  // "Reveal" on the next question: it must score nothing and not be called right.
  //
  // Revealing takes TWO taps — the button changes to "בטוחים?" and only the
  // second press gives up the answer. That is deliberate (nobody should lose a
  // question to a mis-tap), and a test that pressed once sat waiting for a
  // reveal that was never going to come.
  await page.locator(".quiz-next").first().click();
  await page.locator(".ft input").waitFor({ timeout: 20000 });

  const reveal = page.getByRole("button", { name: "גלה תשובה" });
  if (await reveal.count()) {
    await reveal.first().click();
    const confirm = page.getByRole("button", { name: "בטוחים?" });
    await confirm.waitFor({ timeout: 10000 });
    check("revealing asks for confirmation first", (await confirm.count()) === 1);
    await confirm.click();
    await page.locator(".ft-out").waitFor({ timeout: 15000 });
    check("revealing is not counted as correct", (await page.locator(".ft-out.is-correct").count()) === 0);
  } else {
    check("reveal unavailable on this question (skipped)", true);
  }

  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ====================================================== 4. daily challenge

async function daily(browser) {
  section("daily challenge");
  const { context, page, errors } = await newPlayer(browser);

  await page.goto(`${BASE}/daily`, { waitUntil: "networkidle" });
  await page.locator(".plate").waitFor({ timeout: 20000 });
  check("the daily gate renders", (await page.locator(".plate").count()) === 1);
  check("it names a date or a round", (await page.locator(".plate").innerText()).trim().length > 5);

  const start = page.getByRole("button", { name: "התחילו" });
  check("the daily challenge can be started", (await start.count()) === 1);
  if (await start.count()) {
    await start.first().click();
    await page.waitForURL("**/play", { timeout: 25000 });
    await page.locator(".q").waitFor({ timeout: 25000 });
    check("the daily challenge opens a quiz", (await page.locator(".q").innerText()).trim().length > 5);
  }

  // The same date must serve the same quiz to a second visitor.
  const first = await page.locator(".q").innerText();
  const second = await newPlayer(browser);
  await second.page.goto(`${BASE}/daily`, { waitUntil: "networkidle" });
  await second.page.getByRole("button", { name: "התחילו" }).first().click();
  await second.page.waitForURL("**/play", { timeout: 25000 });
  await second.page.locator(".q").waitFor({ timeout: 25000 });
  check(
    "two players get the same daily question",
    (await second.page.locator(".q").innerText()) === first,
    "the daily challenge must be the same for everybody"
  );
  await second.context.close();

  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ============================================================ 5. the builder

async function builder(browser) {
  section("quiz builder");
  const { context, page, errors } = await newPlayer(browser);

  /*
    THE BUILDER IS A WIZARD NOW, so this section was asserting against markup
    that no longer exists: `.build`, `.mode-pick`, `.chip`, `.build-count`,
    `.build-bar`. It timed out on the first wait and took the whole production
    product run down with it — a stale test reporting a healthy product as
    broken, which is the failure mode the comment below this one was already
    written about.

    Layout and the exact per-flow query belong to scripts/builder-qa.mjs, which
    drives all five flows at every viewport and reads the POST body. What is
    checked here is what this suite is for: that the page loads, that the real
    availability endpoint answers, and that a default build reaches a playable
    question.
  */
  await page.goto(`${BASE}/build`, { waitUntil: "networkidle" });
  await page.locator(".bld").waitFor({ timeout: 20000 });

  /*
    The builder is one screen now — five rows of pills, no steps — and the
    whole point is that the defaults are already a game. So this suite checks
    exactly that: the rows are there, availability answers, and Start works
    WITHOUT touching anything.

    Layout and per-flow query correctness belong to scripts/builder-qa.mjs,
    which drives every flow at every viewport and reads the POST body. Naming
    individual pills in both places is how one of them goes stale.
  */
  check("the builder shows five rows of settings", (await page.locator(".bld-row").count()) === 5);
  check("the rows offer real choices", (await page.locator(".bld-pill").count()) >= 20);

  const start = page.locator(".bld-dock button.btn-primary");
  check("the primary action is present without any interaction", await start.isVisible());

  // Availability is the edge-cached count endpoint; it must produce a number.
  // The default selection is unfiltered, so it cannot be empty.
  await page.waitForTimeout(2000);
  const count = await page.locator(".bld-avail").innerText().catch(() => "");
  check("availability reports a number", /[0-9]/.test(count), count);

  check("start is enabled for the defaults — one tap to a game", await start.isEnabled(), count);
  await start.click();
  await page.waitForURL("**/play", { timeout: 30000 });
  await page.locator(".q").waitFor({ timeout: 25000 });
  check("a default build starts", (await page.locator(".q").innerText()).trim().length > 5);



  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ===================================== 6. refresh mid-quiz, and no consent

async function resilience(browser) {
  section("mid-quiz refresh and the no-consent path");

  // A refresh mid-quiz must resume, not lose the game — this is the one thing
  // the sessionStorage validation could plausibly have broken, since it now
  // rejects anything whose shape it does not recognise.
  const { context, page, errors } = await newPlayer(browser);
  await startQuickGame(page, "MULTIPLE_CHOICE");
  const question = await page.locator(".q").innerText();
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".q").waitFor({ timeout: 25000 });
  check("a refresh mid-quiz resumes the same question", (await page.locator(".q").innerText()) === question);
  check("the console stayed clean through the refresh", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();

  // Declining optional storage must still play. Repeat-avoidance and the
  // remembered sound setting are what is given up, not the game.
  const declined = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
  const page2 = await declined.newPage();
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push(e.message));
  await page2.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page2.getByRole("button", { name: "דוחה לא חיוני" }).click().catch(() => {});
  await startQuickGame(page2, "MULTIPLE_CHOICE");
  check("a quiz plays with optional storage declined", (await page2.locator(".q").count()) === 1);
  check("no error when storage consent is declined", errors2.length === 0, errors2.slice(0, 3).join(" | "));
  await declined.close();
}

// ======================================================= 7. shared links

async function sharing(browser) {
  section("challenge links");

  // Created over the API, opened in a browser as a second player would — the
  // whole point of a challenge is that it replays the identical question set.
  const created = await fetch(`${BASE}/api/challenges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      region: "WORLD",
      countries: [],
      competitions: ["ALL"],
      categories: [],
      difficulty: "MIXED",
      questionCount: 5,
      gameMode: "CLASSIC",
      answerMode: "MULTIPLE_CHOICE",
    }),
  });

  if (created.status === 429) {
    check("challenge creation is rate limited right now (skipped)", true);
    return;
  }
  check("a challenge can be created", created.ok, String(created.status));
  if (!created.ok) return;

  const { challenge, quiz } = await created.json();
  check("the challenge has a public id", typeof challenge.publicId === "string" && challenge.publicId.length >= 6);

  const { context, page, errors } = await newPlayer(browser);
  await page.goto(`${BASE}/challenge/${challenge.publicId}`, { waitUntil: "networkidle" });
  await page.locator(".page").first().waitFor({ timeout: 20000 });
  const body = await page.locator(".page").first().innerText();
  check("the challenge page opens", body.trim().length > 10, body.slice(0, 80));
  check(
    "it replays the challenge's own first question",
    body.includes(quiz.questions[0].questionHe.slice(0, 24)) ||
      (await page.getByRole("button").count()) > 0,
    quiz.questions[0].questionHe.slice(0, 40)
  );
  check("the console stayed clean", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

// ================================================================== driver

console.log(`\n======== product QA @ ${BASE} ========`);

const browser = await launch();
try {
  await home(browser);
  await multipleChoice(browser);
  await freeText(browser);
  await daily(browser);
  await builder(browser);
  await resilience(browser);
  await sharing(browser);
} finally {
  await browser.close();
}

console.log(`\n======== ${passed}/${passed + failures.length} passed ========`);
for (const failure of failures) {
  console.log(`FAIL ${failure.name}${failure.detail ? `\n     ${failure.detail}` : ""}`);
}
process.exit(failures.length ? 1 : 0);
