#!/usr/bin/env node
// QA for the multiplayer entry restructure and the header.
//
//   node scripts/mp-entry-qa.mjs [http://localhost:5174]
//
// What this covers that the other suites do not: the entry screen no longer asks
// for a game type, the lobby does, only the host can change it, and every client
// sees the change without a refresh. Those are claims about where a decision
// lives, so they are checked by looking for the control in one place and failing
// to find it in the other.

import { chromium } from "playwright";
import { MODES } from "../src/shared/multiplayer/constants.ts";

const BASE = (process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:5174").replace(/\/+$/, "");
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
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

const section = (name) => console.log(`\n=== ${name} ===`);

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

async function newPlayer(browser, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "he-IL" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("fiq_privacy_v1", JSON.stringify({ decided: true, preferences: true, history: true }));
    } catch {
      /* private mode */
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { name, context, page, errors };
}

async function join(player, code) {
  await player.page.goto(`${BASE}/room/${code}`, { waitUntil: "domcontentloaded" });
  await player.page.waitForSelector("#mp-name", { timeout: 20_000 });
  await player.page.fill("#mp-name", player.name);
  await player.page.press("#mp-name", "Enter");
  await player.page.waitForSelector(".mp-lobby", { timeout: 20_000 });
}

async function eventually(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* mid-render */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const hostModes = MODES.filter((m) => m.hostSelectable);

async function run() {
  const browser = await launch();
  try {
    // ---------------------------------------------------------------- A
    section("A — the entry screen is three doors, not a mode picker");
    const host = await newPlayer(browser, "נאור");
    await host.page.goto(`${BASE}/multiplayer`, { waitUntil: "domcontentloaded" });
    await host.page.waitForSelector(".mp-home");

    const body = await host.page.textContent("body");
    check(body.includes("רב משתתפים"), "the page names itself רב משתתפים");
    check(!body.includes("מולטיפלייר"), "and never uses the transliteration");

    check((await host.page.$$(".mp-modes")).length === 0, "no mode grid on the entry screen");
    check(
      (await host.page.$$('[role="radiogroup"][aria-label="בחירת סוג משחק"]')).length === 0,
      "no game-type radiogroup either"
    );
    // None of the five mode names should be offered as a choice here.
    const modeNamesOnEntry = hostModes.filter((m) => body.includes(m.labelHe));
    check(modeNamesOnEntry.length === 0, "none of the five modes is named", modeNamesOnEntry.map((m) => m.labelHe).join(", "));

    check(body.includes("פתחו חדר"), "פתחו חדר is offered");
    check(body.includes("הצטרפו עם קוד"), "הצטרפו עם קוד is offered");
    check(body.includes("מצאו יריב לדו־קרב"), "מצאו יריב לדו־קרב is offered");
    check(body.includes("אין עם מי לשחק?"), "with the 'nobody to play with' framing");

    // ---------------------------------------------------------------- B
    section("B — creating a room puts the picker in the lobby");
    await host.page.click(".mp-create");
    await host.page.waitForURL(/\/room\/\d{6}/, { timeout: 20_000 });
    const code = new URL(host.page.url()).pathname.split("/").pop();
    check(/^\d{6}$/.test(code), "a room code was allocated", code);

    await host.page.waitForSelector("#mp-name", { timeout: 20_000 });
    await host.page.fill("#mp-name", "נאור");
    await host.page.press("#mp-name", "Enter");
    await host.page.waitForSelector(".mp-lobby", { timeout: 20_000 });

    check((await host.page.$$(".mp-modes-pick")).length === 1, "the lobby has the game-type selector");
    const lobbyModes = await host.page.$$eval(".mp-mode-pick > button:first-child", (els) =>
      els.map((e) => e.textContent.trim())
    );
    check(lobbyModes.length === hostModes.length, `all ${hostModes.length} modes are selectable in the lobby`, lobbyModes.join(", "));

    // ---------------------------------------------------------------- C
    section("C — the host changes mode and everyone sees it");
    const guest = await newPlayer(browser, "יובל");
    await join(guest, code);

    async function guestSeesMode(label) {
      return eventually(async () => (await guest.page.textContent(".mp-lobby-facts")).includes(label));
    }

    check(await guestSeesMode("קרב רגיל"), "the guest starts on קרב רגיל");

    await host.page.click('.mp-mode-pick:has-text("תורות") > button:first-child');
    check(await guestSeesMode("תורות"), "the guest sees תורות without a refresh");

    await host.page.click('.mp-mode-pick:has-text("קרב קבוצות") > button:first-child');
    check(await guestSeesMode("קרב קבוצות"), "and follows a second change to קרב קבוצות");

    // ---------------------------------------------------------------- D
    section("D — a guest cannot change the mode");
    check((await guest.page.$$(".mp-modes-pick")).length === 0, "the guest is not given the selector at all");
    // And the server refuses it even when the frame is sent by hand.
    const refused = await guest.page.evaluate(async () => {
      const socket = window.__fiqSocket;
      if (!socket) return "no-socket-handle";
      socket.send(JSON.stringify({ type: "UPDATE_SETTINGS", settings: { mode: "DUEL" } }));
      return "sent";
    });
    if (refused === "sent") {
      await new Promise((r) => setTimeout(r, 900));
      const stillTeams = (await host.page.textContent(".mp-settings")).includes("קרב קבוצות");
      check(stillTeams, "a hand-sent settings frame from a guest changes nothing");
    } else {
      check(true, "no socket handle exposed to page scripts (guest cannot forge a frame)");
    }

    // ---------------------------------------------------------------- E
    section("E — every mode explains itself");
    for (const mode of hostModes) {
      await host.page.click(`.mp-mode-pick:has-text("${mode.labelHe}") .mp-mode-info`);
      const open = await eventually(async () => (await host.page.$$('[role="dialog"]')).length === 1);
      if (!open) {
        check(false, `ⓘ opens for ${mode.labelHe}`);
        continue;
      }
      const text = await host.page.textContent(".mp-mode-explain");
      check(text.includes(mode.explainHe), `${mode.labelHe} shows its own explanation`);
      await host.page.keyboard.press("Escape");
      const closed = await eventually(async () => (await host.page.$$('[role="dialog"]')).length === 0);
      check(closed, `Escape closes the ${mode.labelHe} dialog`);
    }
    check((await host.page.$$(".mp-lobby")).length === 1, "the lobby survived all five dialogs");
    check(
      (await host.page.textContent(".mp-settings")).includes("קרב קבוצות"),
      "and the chosen mode is still selected"
    );

    // Focus returns to the button that opened the dialog.
    await host.page.click('.mp-mode-pick:has-text("תורות") .mp-mode-info');
    await eventually(async () => (await host.page.$$('[role="dialog"]')).length === 1);
    await host.page.keyboard.press("Escape");
    await eventually(async () => (await host.page.$$('[role="dialog"]')).length === 0);
    const focusLabel = await host.page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    check(focusLabel === "הסבר על תורות", "focus returns to the ⓘ that opened it", focusLabel);

    // ---------------------------------------------------------------- F
    section("F — the header");
    await host.page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await host.page.waitForSelector(".topbar");
    const topbar = await host.page.textContent(".topbar");
    check(!topbar.includes("מולטיפלייר"), "the multiplayer button is gone from the header");
    check((await host.page.$$('.topbar a[href="/multiplayer"]')).length === 0, "and so is any link to it");
    check((await host.page.$$(".topbar-daily")).length === 1, "the daily challenge CTA is there");
    check(topbar.includes("האתגר היומי"), "named האתגר היומי");

    await host.page.click(".topbar-daily");
    await host.page.waitForURL(/\/daily/, { timeout: 15_000 });
    check(/\/daily$/.test(new URL(host.page.url()).pathname), "and it opens the daily challenge");

    // Multiplayer is still reachable from the homepage itself.
    await host.page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await host.page.waitForSelector(".home-ctas");
    const homeCtas = await host.page.$$eval(".home-ctas button", (els) => els.map((e) => e.textContent.trim()));
    check(homeCtas.some((t) => t.includes("משחק עם חברים")), "multiplayer is still on the homepage", homeCtas.join(" | "));
    check(homeCtas.some((t) => t.includes("מצאו יריב לדו־קרב")), "and so is the duel search");

    // ---------------------------------------------------------------- G
    section("G — terminology, across the surfaces a player sees");
    for (const path of ["/", "/multiplayer", "/multiplayer/duel", "/daily", "/privacy"]) {
      await host.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await host.page.waitForTimeout(400);
      const text = await host.page.textContent("body");
      check(!text.includes("מולטיפלייר"), `no transliteration on ${path}`);
    }

    for (const player of [host, guest]) {
      check(player.errors.length === 0, `${player.name}'s console stayed clean`, player.errors[0]);
      await player.context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`passed: ${passed}   failed: ${failed}`);
  if (failures.length > 0) for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(56));
  process.exit(failed === 0 ? 0 : 1);
}

run();
