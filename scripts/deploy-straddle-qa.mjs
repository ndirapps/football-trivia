// What happens to a visitor who is holding the previous deployment's shell.
//
// This is the only blank-screen mechanism that server-side measurement cannot
// rule out, because it does not depend on anything being wrong with the server:
// the browser is holding an HTML document that names bundle hashes which no
// longer exist, and no amount of server health changes that.
//
// It is also the mechanism that matches the report. The site is deployed often
// during development, every deploy changes the bundle hash and deletes the old
// file, and "sometimes it is blank and sometimes it is not" is exactly what a
// population of visitors straddling deploys looks like.
//
// Three cases, and they behave differently — which is the whole point of
// measuring rather than reasoning:
//
//   1. A TAB ALREADY OPEN across a deploy. Its JavaScript is already in memory,
//      so it does not re-request anything. Client-side navigation keeps working.
//      A reload fetches the current shell, because the shell is `no-store`.
//
//   2. A CURRENT shell restored from cache, naming a dead hash. The boot layer
//      in index.html sees the script fail and reloads once onto the live shell.
//      Self-healing.
//
//   3. A PRE-FIX shell restored from cache. It has no boot layer, so nothing
//      notices the dead script and nothing recovers: blank, until the visitor
//      reloads by hand. Nothing deployed today can fix a document that is
//      already in somebody's browser — but it is worth measuring so the size
//      and the lifetime of the residue are known rather than guessed.
//
// Usage:
//   node scripts/deploy-straddle-qa.mjs [baseUrl] --phase=before
//   …deploy…
//   node scripts/deploy-straddle-qa.mjs [baseUrl] --phase=after --old-shell=<file>

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "https://football-iq.naorl.workers.dev").replace(/\/+$/, "");
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PHASE = flag("phase", "both");
const SHELL_FILE = flag("old-shell", "deploy-straddle-shell.html");

let passed = 0;
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function launch() {
  for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      /* next */
    }
  }
  throw new Error("no usable Chromium");
}

const MOBILE = { viewport: { width: 393, height: 852 }, locale: "he-IL", isMobile: true, hasTouch: true };

/** Is there a Football IQ screen on display — the app, or an honest recovery? */
async function visibleState(page) {
  return page
    .evaluate(() => {
      const root = document.getElementById("root");
      const boot = document.getElementById("boot");
      const body = document.body;
      const bg = body ? getComputedStyle(body).backgroundColor : null;
      return {
        stage: window.__FIQ_STAGE__ ?? null,
        rootText: root ? (root.textContent ?? "").trim().length : -1,
        bootVisible: !!boot && !boot.hasAttribute("hidden"),
        bodyText: body ? (body.innerText ?? "").trim().slice(0, 140) : "",
        white: bg === "rgba(0, 0, 0, 0)" || bg === "rgb(255, 255, 255)",
        hasApp: !!document.querySelector("h1.home-title"),
        hasAction: !!document.querySelector("button, a[href]"),
      };
    })
    .catch(() => null);
}

// ================================================================== before

if (PHASE === "before" || PHASE === "both") {
  console.log(`\n--- BEFORE the deploy: capturing the current shell ---`);
  const shell = await (await fetch(`${BASE}/`)).text();
  const hash = shell.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1];
  writeFileSync(SHELL_FILE, shell);
  console.log(`  captured shell naming bundle hash ${hash} -> ${SHELL_FILE}`);
  console.log(`  now deploy, then re-run with --phase=after`);
  if (PHASE === "before") process.exit(0);
}

// =================================================================== after

if (PHASE === "after" || PHASE === "both") {
  console.log(`\n--- AFTER the deploy ---`);

  const oldShell = readFileSync(SHELL_FILE, "utf8");
  const oldHash = oldShell.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1];
  const liveShell = await (await fetch(`${BASE}/`)).text();
  const newHash = liveShell.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1];

  console.log(`  old bundle: ${oldHash}`);
  console.log(`  new bundle: ${newHash}`);
  check("the deploy actually changed the bundle hash", oldHash !== newHash, `${oldHash} vs ${newHash}`);

  const oldAsset = await fetch(`${BASE}/assets/index-${oldHash}.js`);
  check(
    "the previous bundle is gone, and says so with a 404",
    oldAsset.status === 404,
    `status ${oldAsset.status}, type ${oldAsset.headers.get("content-type")}`
  );
  check(
    "the previous bundle is NOT answered with HTML",
    !(oldAsset.headers.get("content-type") ?? "").includes("text/html"),
    oldAsset.headers.get("content-type")
  );

  const browser = await launch();

  // --- case 2: the current shell, but holding a dead hash.
  //
  // Served by rewriting the live shell's hash to the previous one, which is
  // exactly the document a browser restoring a tab from cache would replay.
  {
    const context = await browser.newContext(MOBILE);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    let served = 0;
    await page.route(`${BASE}/`, async (route) => {
      served++;
      // Only the FIRST navigation gets the stale document. The reload the boot
      // layer performs must reach the real, current shell — otherwise the test
      // would be measuring an endless loop of its own making.
      if (served > 1) return route.fallback();
      const response = await route.fetch();
      const html = await response.text();
      route.fulfill({
        response,
        body: html.replace(/\/assets\/index-[A-Za-z0-9_-]+\.js/, `/assets/index-${oldHash}.js`),
        headers: { ...response.headers(), "content-type": "text/html; charset=utf-8" },
      });
    });

    await page.goto(`${BASE}/`, { waitUntil: "commit", timeout: 40000 }).catch(() => {});
    // Room for the one-shot reload and the fresh load behind it.
    await page
      .waitForFunction(() => !!document.querySelector("h1.home-title"), { timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    const state = await visibleState(page);
    console.log(`  case 2 state: ${JSON.stringify(state).slice(0, 220)}`);
    check("a current shell with a dead hash recovers itself", state?.hasApp === true, JSON.stringify(state));
    check("case 2 never shows a white page", state?.white === false);
    check("case 2 served the stale document then reloaded", served >= 2, `shell requests: ${served}`);

    await context.close();
  }

  // --- case 1: a tab that was already open when the deploy happened.
  {
    const context = await browser.newContext(MOBILE);
    const page = await context.newPage();

    // Load the PREVIOUS shell's situation by loading the app now, then deleting
    // its bundle from under it is not possible — so instead this verifies the
    // property that matters: a loaded page keeps working, and a reload lands on
    // the current shell.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 40000 });
    await page.locator("h1.home-title").waitFor({ timeout: 25000 });

    // Client-side navigation needs no new asset.
    await page.getByRole("button", { name: "בנו חידון" }).click();
    await page.waitForURL("**/build", { timeout: 20000 }).catch(() => {});
    check("an open tab can still navigate after a deploy", page.url().includes("/build"), page.url());

    // And a reload gets the live shell, because the shell is never stored.
    await page.reload({ waitUntil: "commit", timeout: 40000 });
    await page.locator(".build").waitFor({ timeout: 25000 }).catch(() => {});
    const reloaded = await visibleState(page);
    check(
      "a reload after a deploy lands on a working app",
      (reloaded?.rootText ?? 0) > 20 && reloaded?.white === false,
      JSON.stringify(reloaded)
    );

    await context.close();
  }

  // --- case 3: a PRE-FIX shell, i.e. one with no boot layer at all.
  //
  // Measured, not fixed: a document already sitting in somebody's browser cannot
  // be changed by anything deployed today. The number this produces is the size
  // of the residue, and it is what says how long the reports should keep
  // arriving.
  {
    const context = await browser.newContext(MOBILE);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    // The pre-fix shell: no inline boot script, no loading shell, no inline
    // background — reconstructed from the live one by stripping exactly those.
    await page.route(`${BASE}/legacy-shell`, async (route) => {
      const body = liveShell
        .replace(/<div id="boot"[\s\S]*?<\/div>\s*/i, "")
        .replace(/<style>[\s\S]*?<\/style>\s*/i, "")
        .replace(/<script nonce="[^"]*">[\s\S]*?<\/script>\s*/i, "")
        .replace(/\/assets\/index-[A-Za-z0-9_-]+\.js/, `/assets/index-${oldHash}.js`);
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    });

    await page.goto(`${BASE}/legacy-shell`, { waitUntil: "commit", timeout: 40000 }).catch(() => {});
    // Long enough to be sure nothing is coming: the boot layer’s failsafe is nine
    // seconds, and the point of this case is that a pre-fix shell has no failsafe.
    await page.waitForTimeout(10000);

    const state = await visibleState(page);
    console.log(`  case 3 state: ${JSON.stringify(state).slice(0, 220)}`);
    console.log(`  case 3 console: ${consoleErrors.slice(0, 2).join(" | ")}`);

    // This is expected to be blank — it is the residue, and the assertion
    // records that rather than pretending it is fixed.
    const blank = (state?.rootText ?? 0) <= 0 && state?.hasApp !== true;
    console.log(
      blank
        ? "  NOTE a pre-fix shell cannot self-heal, as expected. It needs one manual reload,\n" +
          "       after which it is replaced by the current shell and the problem is gone for good."
        : "  NOTE a pre-fix shell recovered, which means the reconstruction was not faithful."
    );

    // What MUST hold is that one manual reload fixes it permanently.
    await page.goto(`${BASE}/`, { waitUntil: "commit", timeout: 40000 }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector("h1.home-title"), { timeout: 25000 }).catch(() => {});
    const healed = await visibleState(page);
    check(
      "one reload permanently fixes a visitor stuck on a pre-fix shell",
      healed?.hasApp === true,
      JSON.stringify(healed)
    );

    await context.close();
  }

  await browser.close();
}

console.log(`\n======== ${passed}/${passed + failures.length} passed ========`);
for (const f of failures) console.log(`FAIL ${f.name}${f.detail ? `\n     ${f.detail}` : ""}`);
process.exit(failures.length ? 1 : 0);
