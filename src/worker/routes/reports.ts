// Player reports (App Store guideline 1.2).
//
//   POST /api/reports  { roomCode?, blockKey, name, reason, message? } -> { reported: true }
//
// Open to guests: anyone who can see another player's name or message can report
// it. The report is stored for the developer to review; blocking itself happens
// on the reporter's device and in the matchmaker (see moderation.ts).

import { Hono } from "hono";
import type { Env } from "../env";
import { gate } from "../lib/ratelimit";
import { sanitizeShortText } from "../../shared/multiplayer/names";
import { isValidRoomCode } from "../../shared/multiplayer/roomCode";

export const REPORT_REASONS = ["offensive_name", "offensive_message", "cheating", "other"] as const;
type ReportReason = (typeof REPORT_REASONS)[number];

export const reportRoutes = new Hono<{ Bindings: Env }>();

reportRoutes.post("/", async (c) => {
  const limited = await gate(c, "RL_WRITE", "report");
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const blockKey = typeof body.blockKey === "string" && /^[0-9a-f]{16}$/.test(body.blockKey) ? body.blockKey : null;
  const name = sanitizeShortText(body.name, 40);
  const reason = REPORT_REASONS.includes(body.reason as ReportReason) ? (body.reason as ReportReason) : null;
  if (!blockKey || !name || !reason) return c.json({ error: "INVALID_REPORT" }, 400);

  const roomCode = isValidRoomCode(body.roomCode) ? body.roomCode : null;
  const message = sanitizeShortText(body.message, 200);

  await c.env.DB.prepare(
    `INSERT INTO player_reports (room_code, reported_key, reported_name, reason, message_text) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(roomCode, blockKey, name, reason, message)
    .run();

  return c.json({ reported: true });
});
