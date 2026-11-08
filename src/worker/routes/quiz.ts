import { Hono } from "hono";
import type { Env } from "../env";
import { buildQuiz } from "../engine/questionEngine";
import { countAvailableQuestions, type QuestionFilter } from "../db/questions";
import { availabilityFilter, availabilityFor, type AvailabilityResult, type Dimension } from "../db/availability";
import { MIXED_TYPE_KEY } from "../../shared/questionTypes";
import { parseQuizConfiguration, ValidationError } from "../lib/validate";
import { gate } from "../lib/ratelimit";
import { cachedJson, putJson } from "../lib/edgeCache";

export const quizRoutes = new Hono<{ Bindings: Env }>();

quizRoutes.post("/", async (c) => {
  const limited = await gate(c, "RL_QUIZ", "build");
  if (limited) return limited;

  try {
    const body = await c.req.json();
    const config = parseQuizConfiguration(body);
    const quiz = await buildQuiz(c.env.DB, config);
    return c.json(quiz);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    console.error("quiz build failed", { name: (err as Error)?.name, message: (err as Error)?.message });
    return c.json({ error: "Failed to build quiz", messageHe: "לא הצלחנו לבנות חידון. נסו שוב." }, 500);
  }
});

/**
 * Per-option availability for the wizard's current step.
 *
 * The builder shows a real number beside every choice and disables the ones that
 * cannot fill the requested quiz, which is the difference between a step that
 * looks rich and a step that IS useful: "ישראל — 55 שאלות" tells a player
 * something true that no amount of card styling can.
 *
 * `dimensions` is what keeps it affordable. A step asks for the one dimension it
 * renders, each dimension is one GROUP BY rather than one COUNT per option, and
 * the answer caches at the edge exactly like /count — the bank moves when a seed
 * is applied, not while somebody is choosing filters. See db/availability.ts for
 * the measurement that made the GROUP BY necessary.
 */
quizRoutes.post("/options", async (c) => {
  const limited = await gate(c, "RL_QUIZ", "options");
  if (limited) return limited;

  try {
    const body = await c.req.json();
    const requested = Array.isArray(body?.dimensions) ? body.dimensions : [];
    const dimensions = requested.filter((d: unknown): d is Dimension =>
      d === "types" || d === "continents" || d === "countries" || d === "competitions" || d === "presets"
    );

    // `gameMode` is optional here in a way it is not for a quiz: the type step
    // counts across modes, so the absence of one is a meaningful request rather
    // than a malformed one.
    const config = parseQuizConfiguration({ ...body, gameMode: body?.gameMode ?? "CLASSIC" });
    const filter = availabilityFilter({
      region: config.region,
      countries: config.countries,
      competitions: config.competitions,
      categories: config.categories,
      difficulty: config.difficulty,
      gameMode: body?.gameMode === null ? null : config.gameMode,
      answerMode: config.answerMode,
    });

    const key = optionsCacheKey(new URL(c.req.url).origin, filter, dimensions);
    const hit = await cachedJson<AvailabilityResult>(key);
    if (hit) return c.json(hit);

    const payload = await availabilityFor(c.env.DB, filter, dimensions);
    await putJson(key, payload, COUNT_TTL_SECONDS);
    return c.json(payload);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    console.error("quiz options failed", { name: (err as Error)?.name, message: (err as Error)?.message });
    return c.json({ error: "Failed to read availability" }, 500);
  }
});

/**
 * The cache key for an availability count.
 *
 * Built from the filter in a canonical order with the lists sorted, so the same
 * selection arrived at by two different routes through the builder is one cache
 * entry rather than two. It is an opaque key on a synthetic URL and never
 * reaches a client.
 */
function countCacheKey(origin: string, filter: QuestionFilter): Request {
  const parts = [
    filter.gameMode,
    filter.answerMode,
    filter.difficulty,
    filter.region ?? "-",
    [...filter.countries].sort().join("."),
    [...filter.competitions].sort().join("."),
    [...filter.categories].sort().join("."),
  ].join("|");
  return new Request(`${origin}/__count/${encodeURIComponent(parts)}`, { method: "GET" });
}

/**
 * The cache key for a per-option availability lookup.
 *
 * Same canonicalisation as countCacheKey, plus the dimensions, sorted — two
 * steps asking for the same dimension under the same selection are one cache
 * entry however the player got there.
 */
function optionsCacheKey(origin: string, filter: QuestionFilter, dimensions: string[]): Request {
  const parts = [
    filter.gameMode ?? "ANY",
    filter.answerMode,
    filter.difficulty,
    filter.region ?? "-",
    [...filter.countries].sort().join("."),
    [...filter.competitions].sort().join("."),
    [...filter.categories].sort().join("."),
    [...dimensions].sort().join("."),
  ].join("|");
  return new Request(`${origin}/__options/${encodeURIComponent(parts)}`, { method: "GET" });
}

/** Six hours. The bank changes when a seed is applied, not while someone is choosing filters. */
const COUNT_TTL_SECONDS = 6 * 60 * 60;

/**
 * "How many questions match this?" — the builder's live availability figure.
 *
 * MEASURED COST, before this cache existed: 15,186 rows read for the simple
 * case and up to 25,197 for a mode filter, per call. The builder calls it every
 * time a chip is tapped. That made the cheapest-looking endpoint in the product
 * the most expensive one, and it is reachable by anyone without so much as a
 * session.
 *
 * The answer is a pure function of the filter and the question bank, and the
 * bank only moves when a seed is applied — so it caches cleanly. The Cache API
 * is per colo, which is the right granularity here: the first person in a region
 * to pick "Premier League, transfers, hard" pays for it and nobody else does.
 */
quizRoutes.post("/count", async (c) => {
  const limited = await gate(c, "RL_QUIZ", "count");
  if (limited) return limited;

  try {
    const body = await c.req.json();
    const config = parseQuizConfiguration(body);
    /*
      A mixed-type quiz spans modes, and so must its count.

      buildQuiz already counts a mixed selection with no mode predicate — the
      grid draws from Who Am I, Career Path and the classic quiz alike — so a
      count that pinned `mode = 'CLASSIC'` here reported a third of the real
      pool. The builder would then have disabled options it can serve perfectly
      well, and shown a summary figure the quiz immediately contradicted.
    */
    const filter: QuestionFilter = {
      region: config.region,
      countries: config.countries,
      competitions: config.competitions,
      categories: config.categories,
      difficulty: config.difficulty,
      gameMode: config.questionType === MIXED_TYPE_KEY ? null : config.gameMode,
      answerMode: config.answerMode,
    };

    const key = countCacheKey(new URL(c.req.url).origin, filter);

    const hit = await cachedJson<{ availableCount: number }>(key);
    if (hit) return c.json(hit);

    const count = await countAvailableQuestions(c.env.DB, filter);
    const payload = { availableCount: count };
    await putJson(key, payload, COUNT_TTL_SECONDS);

    return c.json(payload);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    console.error("quiz count failed", { name: (err as Error)?.name, message: (err as Error)?.message });
    return c.json({ error: "Failed to count questions" }, 500);
  }
});
