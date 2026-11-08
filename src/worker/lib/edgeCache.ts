// The edge cache, behind a small typed door.
//
// Two reasons this is a module rather than two inline calls:
//
// TYPES. The project compiles the client and the Worker with one tsconfig, so
// `lib` includes DOM and the global `caches` resolves to DOM's `CacheStorage` —
// which has no `default`. `caches.default` is a Workers extension. Narrowing it
// here, once, with a comment saying why, beats a cast at every call site or
// splitting the tsconfig in two for one property.
//
// FAILURE POLICY. A cache is an optimisation, and every operation on it has to
// be allowed to fail without taking the request with it. Wrapping it means that
// rule is written down once instead of being re-decided, slightly differently,
// by whoever adds the next cached endpoint.

/*
 * MEMORY FIRST. The Cache API is a no-op on *.workers.dev hostnames, which is
 * where this Worker is served, so on its own it cached nothing: every builder
 * tap went to D1 and the free tier's 5M daily row reads ran out (2026-11-08).
 * A small per-isolate map in front of it holds hot answers for as long as the
 * isolate lives, on any hostname. It is bounded so it cannot grow without limit.
 */
const MEMORY_MAX = 500;
const memory = new Map<string, { value: unknown; expires: number }>();

function memoryGet<T>(key: Request): T | null {
  const hit = memory.get(key.url);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memory.delete(key.url);
    return null;
  }
  return hit.value as T;
}

function memoryPut(key: Request, value: unknown, maxAgeSeconds: number): void {
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key.url, { value, expires: Date.now() + maxAgeSeconds * 1000 });
}

/** The Workers-only `default` cache, which DOM's CacheStorage does not declare. */
interface WorkersCacheStorage {
  readonly default: Cache;
}

function edge(): Cache | null {
  try {
    const store = caches as unknown as Partial<WorkersCacheStorage>;
    return store.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads a cached JSON value.
 *
 * Returns null for a miss, for an unavailable cache, and for a hit whose body
 * will not parse — all three mean the same thing to a caller: compute it.
 */
export async function cachedJson<T>(key: Request): Promise<T | null> {
  const fromMemory = memoryGet<T>(key);
  if (fromMemory !== null) return fromMemory;
  const cache = edge();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Stores a JSON value under a key we made up.
 *
 * The key is a synthetic GET Request rather than the caller's real one, which is
 * necessary as well as convenient: the Cache API refuses to store a response to
 * a POST, and the endpoints worth caching here are POSTs only because their
 * filter does not fit in a query string.
 */
export async function putJson(key: Request, value: unknown, maxAgeSeconds: number): Promise<void> {
  memoryPut(key, value, maxAgeSeconds);
  const cache = edge();
  if (!cache) return;
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${maxAgeSeconds}`,
        },
      })
    );
  } catch {
    // Out of space, an unsupported body, a transient edge failure — none of it
    // is the caller's problem. The value was already computed and is on its way.
  }
}
