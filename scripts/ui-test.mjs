// SUPERSEDED — see scripts/product-qa.mjs.
//
// This script was written against an earlier generation of the UI and its
// selectors no longer match the markup, so it reports failures on a product
// that works. Known stale: .quick-card (the presets are .quick-btn), .how-step (no such section exists), and the flow assumes a preset navigates straight to /play when it now opens the answer-mode sheet first.
//
// It is left in place rather than deleted because removing someone else’s test
// is their call, not a side effect of a reliability pass. Do not treat a
// failure here as a regression without checking the selector first.

// Headless UI smoke test driving the real app with a locally installed Chrome.
// Usage: node scripts/ui-test.mjs [baseUrl]   (default http://localhost:5173)
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5173";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
const page = await context.newPage();

const consoleErrors = [];
// The run deliberately exercises error paths (unknown challenge id), so the
// browser's own "failed to load resource: 404" noise is expected there.
let expectingNotFound = false;
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  if (expectingNotFound && msg.text().includes("404")) return;
  consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

console.log(`\nFootball IQ UI smoke test → ${BASE} (mobile viewport 390x844)\n`);

// --- Home page
await page.goto(BASE, { waitUntil: "networkidle" });
check("home renders the hero title", (await page.locator("h1.home-title").count()) === 1);
check(
  "hero shows the Hebrew brand question",
  (await page.locator("h1.home-title").innerText()).includes("Football IQ")
);
check("page direction is RTL", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
check("primary CTA is present", (await page.getByRole("button", { name: "בנו חידון" }).count()) === 1);
check("quick game cards render", (await page.locator(".quick-card").count()) === 6);
check("how-it-works section renders 3 steps", (await page.locator(".how-step").count()) === 3);

// no horizontal overflow on mobile
const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("no horizontal scroll on mobile viewport", !hasOverflow);

// --- Quick preset flow → play screen
await page.locator(".quick-card").first().click();
await page.waitForURL("**/play", { timeout: 15000 });
check("quick preset navigates to the play screen", page.url().endsWith("/play"));
await page.waitForSelector(".quiz-question");
check("question text renders", (await page.locator(".quiz-question").innerText()).length > 5);
check("four answer options render", (await page.locator(".option-btn").count()) === 4);
check(
  "progress label shows question 1",
  (await page.locator(".quiz-progress-label").innerText()).includes("1")
);

// answer options must be thumb-sized on mobile
const optionBox = await page.locator(".option-btn").first().boundingBox();
check("answer buttons are large enough for thumbs (>=48px tall)", optionBox.height >= 48, `${optionBox?.height}px`);

// no answer revealed before selecting
check(
  "correct answer is not revealed before answering",
  (await page.locator(".option-btn.correct").count()) === 0
);
check("next button hidden before answering", (await page.locator(".quiz-footer").count()) === 0);

// --- Answer a question
await page.locator(".option-btn").first().click();
await page.waitForSelector(".option-btn.correct");
check("correct answer is highlighted after answering", (await page.locator(".option-btn.correct").count()) === 1);
check("choices are locked after answering", await page.locator(".option-btn").first().isDisabled());
check("explanation is shown after answering", (await page.locator(".explanation-box").count()) === 1);
check("next action appears after answering", (await page.locator(".quiz-footer button").count()) === 1);

// --- Play through the whole quiz
let guard = 0;
while (guard++ < 30) {
  const footerBtn = page.locator(".quiz-footer button");
  const label = await footerBtn.innerText();
  await footerBtn.click();
  if (label.includes("סיום")) break;
  await page.waitForSelector(".option-btn:not([disabled])");
  await page.locator(".option-btn").first().click();
  await page.waitForSelector(".quiz-footer button");
}

await page.waitForURL("**/results", { timeout: 15000 });
check("finishing the quiz navigates to results", page.url().endsWith("/results"));
await page.waitForSelector(".results-score");
check("results show a score", /\d+\s*\/\s*\d+/.test(await page.locator(".results-score").innerText()));
check("results show accuracy", (await page.locator(".results-accuracy").innerText()).includes("%"));
check("results show a rank badge", (await page.locator(".badge-gold").count()) >= 1);
check("results show category breakdown", (await page.locator(".category-row").count()) >= 1);
check("results offer replay / new quiz / challenge actions", (await page.locator(".results-actions button").count()) === 3);

// --- Builder page
await page.goto(`${BASE}/build`, { waitUntil: "networkidle" });
check("builder renders game mode options", (await page.locator(".builder-section").count()) >= 6);
await page.waitForFunction(() => {
  const el = document.querySelector(".availability");
  return el && el.textContent && el.textContent.includes("שאלות זמינות");
}, null, { timeout: 15000 });
check("builder shows live availability count", true);

// narrow the filters and confirm the count updates
const before = await page.locator(".availability").innerText();
await page.getByRole("button", { name: "קל", exact: true }).click();
await page.waitForTimeout(1200);
const after = await page.locator(".availability").innerText();
check("availability updates when filters change", before !== after, `${before} → ${after}`);

// --- Daily challenge
await page.goto(`${BASE}/daily`, { waitUntil: "networkidle" });
await page.waitForSelector(".intro-card", { timeout: 15000 });
check("daily challenge page renders an intro card", (await page.locator(".intro-card h1").innerText()).includes("אתגר יומי"));

// --- Unknown challenge id → graceful error
expectingNotFound = true;
await page.goto(`${BASE}/challenge/nope1234`, { waitUntil: "networkidle" });
await page.waitForSelector(".intro-card", { timeout: 15000 });
check("invalid challenge shows a friendly error", (await page.locator(".intro-card").innerText()).includes("לא נמצא"));

// --- 404 route
await page.goto(`${BASE}/totally-unknown-route`, { waitUntil: "networkidle" });
check("unknown route renders the 404 page", (await page.locator(".intro-card h1").innerText()).includes("לא נמצא"));

check("no console errors during the whole run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
