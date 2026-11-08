// The player's own result for each daily challenge, so the daily page can say
// "you already played today" instead of serving the same ten questions as new.

import { readJson, safeLocal, writeJson } from "./safeStorage";
import { privacy } from "./privacy";

const KEY = "fiq_daily_record";

export interface DailyRecord {
  date: string;
  correct: number;
  total: number;
  points: number;
}

function isDailyRecord(v: unknown): v is DailyRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.date === "string" && typeof r.correct === "number" && typeof r.total === "number" && typeof r.points === "number";
}

export function loadDailyRecord(date: string): DailyRecord | null {
  if (!privacy.allows("history")) return null;
  const r = readJson(safeLocal, KEY, isDailyRecord);
  return r && r.date === date ? r : null;
}

/** Only the first finish of the day is kept: a replay does not overwrite it. */
export function saveDailyRecord(record: DailyRecord): void {
  if (!privacy.allows("history") || loadDailyRecord(record.date)) return;
  writeJson(safeLocal, KEY, record);
}
