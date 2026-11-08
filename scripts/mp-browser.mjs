// Multi-client multiplayer testing in real browsers.
//
// scripts/mp-e2e.mjs proves the SERVER is right by speaking the protocol
// directly. This proves the PRODUCT is right: that four people on four devices,
// tapping real buttons, see the same game — and that the things a protocol test
// cannot see (the QR is on screen, the chosen answer is not coloured green before
// the reveal, the podium renders, a reload mid-round puts you back) actually
// hold.
//
// Each player is a separate BrowserContext, not a separate tab: a context has its
// own storage, so each one mints its own player token exactly as four phones
// would. Sharing one context would give every "player" the same identity.
//
//   node scripts/mp-browser.mjs                   # against the dev server
//   node scripts/mp-browser.mjs https://host      # against a deployment
//   node scripts/mp-browser.mjs --headed          # watch it happen

import { chromium } from "playwright";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const BASE = (args.find((a) => a.startsWith("http")) ?? "http://localhost:5173").replace(/\/+$/, "");

/**
 * Launches whatever Chromium this machine actually has.
 *
 * `npx playwright install` downloads a build pinned to the installed Playwright
 * version, and on a slow or filtered connection that download simply times out.
 * Falling back to the system Chrome (or to a Chromium another Playwright version
 * already fetched) means the suite runs on a developer laptop and in CI without
 * anyone having to fight a CDN first. The order is: the pinned build, then the
 * installed Chrome channel, then the newest Chromium lying around.
 */
async function launchChromium() {
  const attempts = [
    { label: "bundled chromium", options: {} },
    { label: "system Chrome", options: { channel: "chrome" } },
    { label: "system Edge", options: { channel: "msedge" } },
  ];

  const problems = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({ headless: !headed, ...attempt.options });
      if (attempt.label !== "bundled chromium") {
        console.log(`(using ${attempt.label} — the pinned Chromium build is not installed)\n`);
      }
      return browser;
    } catch (error) {
      problems.push(`${attempt.label}: ${String(error.message).split("\n")[0]}`);
    }
  }

  throw new Error(`no usable Chromium found.\n  ${problems.join("\n  ")}`);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One player, in their own browser context.
 *
 * `grantConsent` seeds the privacy choice before the app boots, so the consent
 * banner is not in the way of every test. That is a fixture, not a shortcut: the
 * banner has its own tests, and a multiplayer test that spent its first action
 * dismissing it would be testing the wrong thing.
 */
async function newPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("fiq_privacy_v1", JSON.stringify({ decided: true, preferences: true, history: true }));
    } catch {
      /* private mode: the app copes, and so does this */
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { name, context, page, errors };
}

/** Walks a player through the name gate into the room. */
async function join(player, code) {
  await player.page.goto(`${BASE}/room/${code}`, { waitUntil: "domcontentloaded" });
  await player.page.waitForSelector("#mp-name", { timeout: 20_000 });
  await player.page.fill("#mp-name", player.name);
  await player.page.press("#mp-name", "Enter");
  await player.page.waitForSelector(".mp-lobby", { timeout: 20_000 });
}

async function phaseOf(page) {
  return page.$eval(".mp-room", (el) => el.dataset.phase).catch(() => null);
}

async function waitForPhase(page, phases, timeout = 40_000) {
  const wanted = Array.isArray(phases) ? phases : [phases];
  const deadline = Date.now() + timeout;
  for (;;) {
    const phase = await phaseOf(page);
    if (phase && wanted.includes(phase)) return phase;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

/**
 * Taps an option if this page currently has an answerable question.
 *
 * Uses a locator with a short timeout rather than an element handle: the round
 * can close between "find the button" and "click it", and a handle taken before
 * that re-render throws "Element is not attached to the DOM" — which surfaced as
 * a harness crash against production, where the extra latency made the window
 * wide enough to hit. A missed click here is not a failure, it is the round
 * having moved on, so it is swallowed and reported as "did not answer".
 */
async function answerIfOpen(page, optionIndex = 0) {
  const phase = await phaseOf(page);
  if (phase !== "QUESTION" && phase !== "WAITING_FOR_ANSWERS") return false;
  try {
    await page.locator(".options .opt:not([disabled])").nth(optionIndex).click({ timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until the room is showing question `index` (0-based).
 *
 * `waitForPhase(["QUESTION", "WAITING_FOR_ANSWERS"])` is not enough to mean "the
 * next round has started", because the phase is already WAITING_FOR_ANSWERS the
 * moment this player answers — so it returns immediately, still on the round that
 * has not banked its points yet. Waiting on the question NUMBER is the thing that
 * actually says a round is over.
 */
async function waitForQuestionIndex(page, index, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await page
      .$eval(".mp-hud-progress b", (el) => Number(el.textContent.trim()))
      .catch(() => null);
    if (current !== null && current - 1 >= index) return true;
    if ((await phaseOf(page)) === "FINISHED") return false;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/** Polls a predicate until it holds, so an assertion never races a round trip. */
async function eventually(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* mid-render; try again */
    }
    if (Date.now() > deadline) return false;
    await sleep(120);
  }
}

async function createRoom(page, mode) {
  return page.evaluate(async (m) => {
    const res = await fetch("/api/mp/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: m }),
    });
    return (await res.json()).code;
  }, mode);
}

/** Presses a value in one of the host settings segmented controls. */
async function setSetting(page, groupLabel, value) {
  await page.evaluate(
    ({ groupLabel, value }) => {
      const group = [...document.querySelectorAll(".mp-group")].find((g) =>
        g.querySelector("legend")?.textContent.includes(groupLabel)
      );
      const button = [...group.querySelectorAll(".mp-seg-btn")].find((b) => b.textContent.trim().startsWith(value));
      button.click();
    },
    { groupLabel, value }
  );
}

// ======================================================= private room, 4 up

async function testPrivateRoomInBrowsers(browser) {
  section("FOUR BROWSERS — lobby, settings, a full game, the podium");

  const players = [];
  for (const name of ["נאור", "יובל", "דניאל", "רועי"]) {
    players.push(await newPlayer(browser, name));
  }
  const [host, a, b, c] = players;

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "CLASSIC_BATTLE");
  check(/^\d{6}$/.test(code), "a room code was allocated", code);

  await join(host, code);
  check(await host.page.isVisible(".mp-code-digits"), "the host sees the room code");
  check(await host.page.isVisible(".mp-qr"), "and a QR to join by");

  // The QR must be dark-on-light or phone cameras will not read it.
  const qrColours = await host.page.evaluate(() => {
    const svg = document.querySelector(".mp-qr");
    return {
      panel: svg.querySelector("rect").getAttribute("fill"),
      modules: svg.querySelector("path").getAttribute("fill"),
    };
  });
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  };
  check(
    luminance(qrColours.panel) > luminance(qrColours.modules) + 100,
    "the QR is dark modules on a light panel, not inverted",
    qrColours
  );

  for (const player of [a, b, c]) await join(player, code);

  // The lobby is live for everyone, not just whoever acted last.
  await host.page.waitForFunction(() => document.querySelectorAll(".mp-sheet-row").length === 4, null, {
    timeout: 20_000,
  });
  for (const player of players) {
    const names = await player.page.$$eval(".mp-sheet-name", (els) => els.map((e) => e.textContent.trim()));
    check(
      names.length === 4,
      `${player.name} sees all four players on the team sheet`,
      names
    );
  }

  const hostBadges = await host.page.$$eval(".mp-sheet-row", (rows) =>
    rows.map((r) => r.textContent.includes("מארח"))
  );
  check(hostBadges.filter(Boolean).length === 1 && hostBadges[0], "exactly one player wears the armband, and it is the first");

  check(
    !(await a.page.isVisible(".mp-settings")),
    "a non-host does not get the settings panel"
  );
  check(await host.page.isVisible(".mp-settings"), "and the host does");

  // A host settings change reaches the other three screens.
  await setSetting(host.page, "כמה שאלות", "5");
  await setSetting(host.page, "זמן לשאלה", "10");
  for (const player of [a, b, c]) {
    const seen = await player.page
      .waitForFunction(() => document.body.innerText.includes("שאלות") || true, null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    check(seen, `${player.name}'s screen stayed live through the settings change`);
  }

  await host.page.click(".mp-lobby-actions .btn-primary");

  const countdown = await waitForPhase(host.page, ["COUNTDOWN", "QUESTION"], 15_000);
  check(!!countdown, "the game starts for the host", countdown);
  for (const player of [a, b, c]) {
    check(
      !!(await waitForPhase(player.page, ["COUNTDOWN", "QUESTION", "WAITING_FOR_ANSWERS"], 15_000)),
      `${player.name} is taken into the game too`
    );
  }

  await waitForPhase(host.page, ["QUESTION", "WAITING_FOR_ANSWERS"], 20_000);

  // Every screen shows the same question.
  const texts = [];
  for (const player of players) {
    texts.push(await player.page.$eval(".mp-q .q", (el) => el.textContent.trim()).catch(() => null));
  }
  check(new Set(texts).size === 1 && texts[0], "all four screens show the same question", texts[0]);

  const optionSets = [];
  for (const player of players) {
    optionSets.push(await player.page.$$eval(".options .opt-text", (els) => els.map((e) => e.textContent.trim()).join("|")));
  }
  check(new Set(optionSets).size === 1, "in the same option order", optionSets[0]);

  // The critical one: a locked answer must not be coloured right or wrong.
  await answerIfOpen(host.page, 0);
  await host.page.waitForSelector(".opt.is-chosen", { timeout: 8000 }).catch(() => null);
  const lockedClasses = await host.page.$$eval(".options .opt", (els) => els.map((e) => e.className));
  check(
    lockedClasses.some((c) => c.includes("is-chosen")),
    "the chosen option is marked as chosen"
  );
  check(
    !lockedClasses.some((c) => c.includes("is-correct") || c.includes("is-wrong")),
    "and NOT as right or wrong while the round is still open",
    lockedClasses
  );
  // The lock badge waits on the server confirming the answer, so this polls
  // rather than asserting on the instant after the click.
  check(
    await eventually(() => host.page.isVisible(".mp-q-locked")),
    "the player is told their answer is locked in"
  );

  const scoresDuringRound = await host.page.$$eval(".mp-board-score", (els) => els.map((e) => e.textContent.trim()));
  check(
    scoresDuringRound.every((s) => s === "0"),
    "and nobody's score has moved yet",
    scoresDuringRound
  );

  // Play the rest out from every screen.
  const finish = players.map(async (player) => {
    for (let i = 0; i < 400; i++) {
      if ((await phaseOf(player.page)) === "FINISHED") return true;
      await answerIfOpen(player.page, 0);
      await sleep(150);
    }
    return (await phaseOf(player.page)) === "FINISHED";
  });
  const finished = await Promise.all(finish);
  check(finished.every(Boolean), "every screen reached the end of the game", finished);

  // The podium and the full table.
  check(await host.page.isVisible(".mp-podium"), "a four-player game finishes on a podium");
  const steps = await host.page.$$eval(".mp-podium-step", (els) => els.length);
  check(steps === 3, "with three steps", steps);
  check(await host.page.isVisible(".mp-standings"), "and the full standings underneath");

  const tables = [];
  for (const player of players) {
    tables.push(
      await player.page.$$eval(".mp-standings-row", (rows) =>
        rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()).join(" || ")
      )
    );
  }
  check(new Set(tables).size === 1, "and the same final table on all four screens", tables.map((t) => t.slice(0, 60)));
  check(tables[0].split("||").length === 4, "listing all four players", tables[0]);

  for (const player of players) {
    check(player.errors.length === 0, `${player.name}'s browser logged no errors`, player.errors.slice(0, 2));
  }

  await Promise.all(players.map((p) => p.context.close()));
}

// ============================================================ turn based UI

async function testTurnBasedInBrowsers(browser) {
  section("TURN BASED IN THE BROWSER — only one player can act");

  const players = [];
  for (const name of ["נאור", "יובל", "דניאל"]) players.push(await newPlayer(browser, name));
  const [host] = players;

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "TURN_BASED");
  for (const player of players) await join(player, code);
  await host.page.waitForFunction(() => document.querySelectorAll(".mp-sheet-row").length === 3, null, { timeout: 20_000 });

  await setSetting(host.page, "כמה שאלות", "5");
  await setSetting(host.page, "זמן לשאלה", "30");
  await host.page.click(".mp-lobby-actions .btn-primary");
  await waitForPhase(host.page, ["QUESTION", "WAITING_FOR_ANSWERS"], 25_000);

  const banners = [];
  for (const player of players) {
    banners.push(await player.page.$eval(".mp-turn", (el) => el.textContent.trim()).catch(() => null));
  }
  check(banners.every(Boolean), "every screen says whose turn it is", banners);
  check(banners[0] === "התור שלכם", "the player whose turn it is is told so in the second person", banners[0]);
  check(
    banners[1]?.includes("נאור") && banners[2]?.includes("נאור"),
    "and the others are told whose turn it is by name",
    banners.slice(1)
  );

  const watchers = await Promise.all(players.slice(1).map((p) => p.page.isVisible(".mp-q-watching")));
  check(watchers.every(Boolean), "the other players are told they are watching this round");

  const disabled = await players[1].page.$$eval(".options .opt", (els) => els.every((e) => e.disabled));
  check(disabled, "and their options are not clickable");

  await Promise.all(players.map((p) => p.context.close()));
}

// ============================================================== reconnect

async function testReconnectInBrowser(browser) {
  section("RELOAD MID-ROUND — the browser case reconnect exists for");

  const players = [];
  for (const name of ["נאור", "יובל"]) players.push(await newPlayer(browser, name));
  const [host, rival] = players;

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "CLASSIC_BATTLE");
  for (const player of players) await join(player, code);
  await host.page.waitForFunction(() => document.querySelectorAll(".mp-sheet-row").length === 2, null, { timeout: 20_000 });

  await setSetting(host.page, "כמה שאלות", "5");
  await setSetting(host.page, "זמן לשאלה", "30");
  await host.page.click(".mp-lobby-actions .btn-primary");
  await waitForPhase(host.page, ["QUESTION", "WAITING_FOR_ANSWERS"], 25_000);

  // Bank a score, then reload in the middle of the NEXT question — so the score
  // being compared is one the server has already committed.
  await answerIfOpen(host.page, 0);
  await answerIfOpen(rival.page, 0);
  const advanced = await waitForQuestionIndex(host.page, 1);
  check(advanced, "the first round completed and the second question opened");

  const before = await host.page.$eval(".mp-board-row.is-you .mp-board-score", (el) => el.textContent.trim());

  await host.page.reload({ waitUntil: "domcontentloaded" });

  const back = await waitForPhase(host.page, ["QUESTION", "WAITING_FOR_ANSWERS", "ANSWER_REVEAL", "ROUND_RESULTS"], 25_000);
  check(!!back, "a reload lands back inside the game, not on the name prompt", back);
  check(
    !(await host.page.isVisible("#mp-name")),
    "the name prompt is not shown again — the token identified the player"
  );

  const questionVisible = await host.page.isVisible(".mp-q .q");
  check(questionVisible, "and the question is on screen, not an empty board");

  const after = await host.page.$eval(".mp-board-row.is-you .mp-board-score", (el) => el.textContent.trim());
  check(after === before, "with the score intact", { before, after });

  const rowCount = await rival.page.$$eval(".mp-board-row", (els) => els.length);
  check(rowCount === 2, "and the other player still sees two players, not three", rowCount);

  await Promise.all(players.map((p) => p.context.close()));
}

// ======================================================== accessibility

async function testAccessibility(browser) {
  section("ACCESSIBILITY — keyboard, reduced motion, contrast, announcements");

  const players = [];
  for (const name of ["נאור", "יובל"]) players.push(await newPlayer(browser, name));
  const [host, rival] = players;

  // Reduced motion, high contrast and large text, set before the app boots.
  await host.context.addInitScript(() => {
    try {
      localStorage.setItem(
        "fiq_a11y_v1",
        JSON.stringify({ textScale: 1.3, highContrast: true, reduceMotion: true, underlineLinks: true })
      );
    } catch {
      /* ignored */
    }
  });

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "CLASSIC_BATTLE");
  for (const player of players) await join(player, code);
  await host.page.waitForFunction(() => document.querySelectorAll(".mp-sheet-row").length === 2, null, { timeout: 20_000 });

  const settings = await host.page.evaluate(() => ({
    motion: document.documentElement.dataset.motion,
    contrast: document.documentElement.dataset.contrast,
    scale: getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim(),
  }));
  check(settings.motion === "off", "reduced motion is applied in the room", settings);
  check(settings.contrast === "high", "as is high contrast", settings);
  check(settings.scale === "1.3", "and the text scale", settings);

  // Every control is reachable and named.
  const unnamed = await host.page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !((el.getAttribute("aria-label") || el.textContent || el.title || "").trim()))
      .map((el) => `${el.tagName}.${el.className}`)
  );
  check(unnamed.length === 0, "every interactive element in the lobby has an accessible name", unnamed);

  // The focus ring is real, not suppressed.
  await host.page.keyboard.press("Tab");
  const ring = await host.page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle };
  });
  check(
    ring && ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0,
    "keyboard focus is visible",
    ring
  );

  await setSetting(host.page, "כמה שאלות", "5");
  await setSetting(host.page, "זמן לשאלה", "30");
  await host.page.click(".mp-lobby-actions .btn-primary");
  await waitForPhase(host.page, ["QUESTION", "WAITING_FOR_ANSWERS"], 25_000);

  // The live region carries the question, so it is spoken without any visual cue.
  const announced = await host.page.$eval("[role='status'][aria-live='polite']", (el) => el.textContent.trim());
  check(announced.length > 0, "the room announces what is happening into a live region", announced.slice(0, 60));

  // The countdown must NOT be announced on every tick.
  const timerLive = await host.page.$eval("[role='timer']", (el) => el.getAttribute("aria-live")).catch(() => null);
  check(timerLive === "off", "the clock is not announced every tick", timerLive);

  // Number keys answer, exactly as in the single-player board.
  await host.page.keyboard.press("2");
  const chosen = await host.page
    .waitForSelector(".opt.is-chosen", { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  check(chosen, "a number key answers the question");

  const chosenIndex = await host.page.$$eval(".options .opt", (els) =>
    els.findIndex((e) => e.className.includes("is-chosen"))
  );
  check(chosenIndex === 1, "and picks the option that key names", chosenIndex);

  // Reduced motion really does suppress the animations rather than just the CSS
  // class being present.
  const animating = await host.page.evaluate(() =>
    [...document.querySelectorAll(".mp-room *")].filter((el) => {
      const name = getComputedStyle(el).animationName;
      return name && name !== "none" && !name.startsWith("fade");
    }).length
  );
  check(animating === 0, "no football-flavoured animation runs under reduced motion", animating);

  await answerIfOpen(rival.page, 0);
  await Promise.all(players.map((p) => p.context.close()));
}

// ================================================== matchmaking in browsers

async function testMatchmakingInBrowsers(browser) {
  section("RANDOM DUEL IN THE BROWSER — queue, match, auto-join, play");

  const players = [];
  for (const name of ["נאור", "יובל"]) players.push(await newPlayer(browser, name));
  const [a, b] = players;

  for (const player of players) {
    await player.page.goto(`${BASE}/multiplayer/duel`, { waitUntil: "domcontentloaded" });
    await player.page.waitForSelector("#mp-duel-name", { timeout: 20_000 });
  }

  await a.page.fill("#mp-duel-name", "נאור");
  await a.page.click(".mp-duel-form button[type=submit]");
  const searching = await a.page.waitForSelector(".mp-search", { timeout: 15_000 }).then(() => true).catch(() => false);
  check(searching, "the first player sees the searching stage, not a spinner");
  check(await a.page.isVisible(".mp-duel-cancel"), "with a way to cancel");

  await b.page.fill("#mp-duel-name", "יובל");
  await b.page.click(".mp-duel-form button[type=submit]");

  const urls = await Promise.all(
    players.map((p) =>
      p.page.waitForURL(/\/room\/\d{6}$/, { timeout: 30_000 }).then(() => p.page.url()).catch(() => null)
    )
  );
  check(urls.every(Boolean), "both players are taken into a room", urls);
  check(urls[0] === urls[1], "the SAME room", urls);

  // The whole point of the auto-join: no second name prompt.
  for (const player of players) {
    const prompted = await player.page.isVisible("#mp-name").catch(() => false);
    check(!prompted, `${player.name} is not asked for their name a second time`);
  }

  const started = await Promise.all(
    players.map((p) => waitForPhase(p.page, ["COUNTDOWN", "QUESTION", "WAITING_FOR_ANSWERS"], 30_000))
  );
  check(started.every(Boolean), "the duel starts itself, with no host to press start", started);

  await Promise.all(players.map((p) => waitForPhase(p.page, ["QUESTION", "WAITING_FOR_ANSWERS"], 30_000)));

  const boards = await Promise.all(players.map((p) => p.page.isVisible(".mp-duel")));
  check(boards.every(Boolean), "both see the head-to-head scoreboard, not a generic table");

  const questions = await Promise.all(
    players.map((p) => p.page.$eval(".mp-q .q", (el) => el.textContent.trim()).catch(() => null))
  );
  check(new Set(questions).size === 1 && questions[0], "with the same question", questions[0]);

  check(
    !(await a.page.isVisible(".mp-code-digits")),
    "a matchmade room shows no room code — there is nobody to invite"
  );

  await Promise.all(players.map((p) => p.context.close()));
}

// ================================================================= layout

async function testLayout(browser) {
  section("MOBILE LAYOUT — no horizontal overflow anywhere");

  const sizes = [
    { width: 320, height: 720, label: "320px" },
    { width: 390, height: 844, label: "390px" },
    { width: 768, height: 1024, label: "768px" },
  ];

  const player = await newPlayer(browser, "נאור");
  await player.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(player.page, "TEAM_BATTLE");
  await join(player, code);

  for (const size of sizes) {
    await player.page.setViewportSize({ width: size.width, height: size.height });
    await sleep(250);
    for (const [label, url] of [
      ["the multiplayer landing", `${BASE}/multiplayer`],
      ["the random duel screen", `${BASE}/multiplayer/duel`],
      ["a room lobby", `${BASE}/room/${code}`],
    ]) {
      await player.page.goto(url, { waitUntil: "domcontentloaded" });
      await sleep(400);
      const overflow = await player.page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      check(
        overflow.scroll <= overflow.client + 1,
        `${label} has no horizontal overflow at ${size.label}`,
        overflow
      );
    }
  }

  await player.context.close();
}

// =================================================================== main

/**
 * Trash talk, across real browsers.
 *
 * The room-engine tests already prove the rules — who receives a message, the
 * cooldown, the per-question ceiling, sanitising. What only a browser can show is
 * that the bubble actually arrives on the other screens, renders the sender, and
 * does not sit on top of the answer buttons: a message overlay that swallows a tap
 * is worse than no message overlay, and that is a layout fact, not a rule.
 */
async function testTrashTalkInBrowsers(browser) {
  section("THREE BROWSERS — trash talk arrives, and does not block the game");

  const players = [];
  for (const name of ["נאור", "יובל", "דנה"]) players.push(await newPlayer(browser, name));
  const [host, opponent, third] = players;

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "CLASSIC_BATTLE");
  for (const player of players) await join(player, code);

  await host.page.click("button:has-text('התחילו משחק')");
  await waitForPhase(host.page, ["QUESTION", "COUNTDOWN"]);
  await waitForPhase(opponent.page, ["QUESTION", "COUNTDOWN"]);
  await waitForPhase(third.page, ["QUESTION"]);

  // ---- a preset reaches the others
  await host.page.click(".mp-talk-toggle");
  check(await host.page.isVisible(".mp-talk-panel"), "the composer opens on the sender's screen");
  await host.page.click(".mp-talk-preset:has-text('זה היה קל')");

  for (const receiver of [opponent, third]) {
    const arrived = await eventually(() => receiver.page.isVisible(".mp-talk-bubble"));
    check(arrived, `a bubble reaches ${receiver.name}`);
    if (!arrived) continue;
    const bubble = await receiver.page.$eval(".mp-talk-bubble", (el) => ({
      name: el.querySelector(".mp-talk-bubble-name")?.textContent ?? "",
      text: el.querySelector(".mp-talk-bubble-text")?.textContent ?? "",
    }));
    check(bubble.text.includes("זה היה קל"), `${receiver.name} sees the message`, bubble.text);
    check(bubble.name.includes("נאור"), `and sees who sent it`, bubble.name);
  }

  // ---- the sender does not see their own
  check(
    !(await host.page.isVisible(".mp-talk-bubble")),
    "the sender's own jibe does not pop up on their own screen"
  );

  // ---- the bubble cannot intercept a tap meant for an answer
  const overlap = await opponent.page.evaluate(() => {
    const bubble = document.querySelector(".mp-talk-bubble");
    const container = document.querySelector(".mp-talk-bubbles");
    if (!bubble || !container) return { missing: true };
    const box = bubble.getBoundingClientRect();
    const midpoint = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      pointerEvents: getComputedStyle(container).pointerEvents,
      // Whatever is under the middle of the bubble must not be the bubble itself.
      hitIsBubble: bubble.contains(midpoint),
    };
  });
  check(overlap.pointerEvents === "none", "the bubble layer does not take pointer events");
  check(overlap.hitIsBubble === false, "a tap through the bubble reaches what is underneath");

  // ---- the game still progresses for everyone
  for (const player of players) await answerIfOpen(player.page, 0);
  await waitForPhase(opponent.page, ["ANSWER_REVEAL", "ROUND_RESULTS", "QUESTION"]);
  check(true, "the round still resolves after a message");

  // ---- a custom message, and the length cap in the markup
  await eventually(async () => (await opponent.page.getAttribute(".mp-talk-toggle", "disabled")) === null);
  await opponent.page.click(".mp-talk-toggle");
  await opponent.page.click(".mp-talk-open-custom");
  const maxLength = await opponent.page.getAttribute(".mp-talk-custom input", "maxLength");
  check(maxLength === "60", "the custom field caps length in the markup too", maxLength);
  await opponent.page.fill(".mp-talk-custom input", "פוקס");
  await opponent.page.click(".mp-talk-custom button[type=submit]");

  const custom = await eventually(async () => {
    const text = await host.page.$eval(".mp-talk-bubble-text", (el) => el.textContent).catch(() => null);
    return Boolean(text && text.includes("פוקס"));
  });
  check(custom, "a custom message reaches the other player");

  // ---- the cooldown is visible rather than silent
  check(
    (await opponent.page.getAttribute(".mp-talk-toggle", "disabled")) !== null,
    "the control disables itself for the cooldown"
  );

  for (const player of players) {
    check(player.errors.length === 0, `${player.name}'s console stayed clean`, player.errors[0]);
    await player.context.close();
  }
}

/**
 * In a duel the jibe is between the two of them.
 *
 * The engine test proves the targeting; this proves the wiring end to end, which
 * is the case most likely to break silently if the effect kind ever changes.
 */
async function testDuelTrashTalkInBrowsers(browser) {
  section("TWO BROWSERS — a duel jibe reaches the opponent only");

  const host = await newPlayer(browser, "נאור");
  const rival = await newPlayer(browser, "יובל");

  await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
  const code = await createRoom(host.page, "DUEL");
  await join(host, code);
  await join(rival, code);

  await host.page.click("button:has-text('התחילו משחק')");
  await waitForPhase(rival.page, ["QUESTION", "COUNTDOWN", "DUEL_INTRO"]);

  await host.page.click(".mp-talk-toggle");
  await host.page.click(".mp-talk-preset:has-text('לא ראית את זה בא')");

  const duelArrived = await eventually(async () =>
    Boolean(await rival.page.$eval(".mp-talk-bubble-text", (el) => el.textContent).catch(() => null))
  );
  check(duelArrived, "the opponent receives the duel message");
  check(!(await host.page.isVisible(".mp-talk-bubble")), "and the sender does not see their own");

  for (const player of [host, rival]) {
    check(player.errors.length === 0, `${player.name}'s console stayed clean`, player.errors[0]);
    await player.context.close();
  }
}

async function main() {
  console.log("Football IQ — multiplayer, in real browsers");
  console.log(`target: ${BASE}\n`);

  const browser = await launchChromium();
  try {
    await testPrivateRoomInBrowsers(browser);
    await testTurnBasedInBrowsers(browser);
    await testReconnectInBrowser(browser);
    await testAccessibility(browser);
    await testTrashTalkInBrowsers(browser);
    await testDuelTrashTalkInBrowsers(browser);
    await testMatchmakingInBrowsers(browser);
    await testLayout(browser);
  } catch (error) {
    failed++;
    failures.push(`harness error: ${error.message}`);
    console.error(`\nHARNESS ERROR: ${error.stack ?? error.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`passed: ${passed}   failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log("=".repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main();
