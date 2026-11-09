import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockKeyOf,
  containsBlockedLanguage,
  nameBlockKey,
  parseBlockedNames,
  parseBlockKeys,
} from "../src/shared/multiplayer/moderation.ts";
import { sanitizePlayerName } from "../src/shared/multiplayer/names.ts";
import { resolveOutgoingMessage } from "../src/shared/multiplayer/messages.ts";
import { parseClientMessage } from "../src/shared/multiplayer/protocol.ts";

test("abusive player names are refused, ordinary ones kept", () => {
  assert.equal(sanitizePlayerName("f u c k"), null);
  assert.equal(sanitizePlayerName("בן זונה"), null);
  assert.equal(sanitizePlayerName("נאור"), "נאור");
  assert.equal(sanitizePlayerName("Messi10"), "Messi10");
  assert.equal(sanitizePlayerName("זינה"), "זינה");
  assert.equal(sanitizePlayerName("Nazir"), "Nazir");
});

test("messages still use the same filter", () => {
  assert.equal(resolveOutgoingMessage({ text: "shiiiit" }).rejection, "BLOCKED");
  assert.equal(containsBlockedLanguage("כל הכבוד"), false);
});

test("block keys are stable, distinct and well-formed", () => {
  const a = blockKeyOf("0123456789abcdef0123456789abcdef");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, blockKeyOf("0123456789abcdef0123456789abcdef"));
  assert.notEqual(a, blockKeyOf("0123456789abcdef0123456789abcdee"));
});

test("matchmaking blocked lists are validated and capped", () => {
  assert.deepEqual(parseBlockKeys(["zz", "0123456789abcdef", "0123456789abcdef", 3]), ["0123456789abcdef"]);
  assert.equal(parseBlockKeys(Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(16, "0"))).length, 50);
  assert.deepEqual(parseBlockedNames(["  Roy  ", "ROY", 5]), [nameBlockKey("Roy")]);
});

test("JOIN_MATCHMAKING carries the block list, and old clients still parse", () => {
  const withList = parseClientMessage(
    JSON.stringify({ type: "JOIN_MATCHMAKING", name: "רועי", blocked: ["0123456789abcdef"], blockedNames: ["X"] })
  );
  assert.deepEqual(withList, {
    type: "JOIN_MATCHMAKING",
    name: "רועי",
    blocked: ["0123456789abcdef"],
    blockedNames: ["x"],
  });
  const old = parseClientMessage(JSON.stringify({ type: "JOIN_MATCHMAKING", name: "רועי" }));
  assert.deepEqual(old, { type: "JOIN_MATCHMAKING", name: "רועי", blocked: [], blockedNames: [] });
});
