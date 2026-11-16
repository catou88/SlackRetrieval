// Owns the persistent Claude answer cache policy: look up a validated answer
// by key, otherwise call the model once (identical concurrent calls share it),
// and store only answers that are safe to reuse. Storage is injected (an
// llmStore from data/queries.js), so this module never opens the database.
import { CONFIG } from "../config.js";
import { isCacheEnabled, registerStats, singleFlight } from "../lib/cache.js";

const STATS_NAME = "claude-answers";

const inflight = new Map();
let stats = null;
let activeStore = null; // the store cacheStats() reports on (see useLlmStore)

/**
 * Get-or-call with a TTL'd persistent store.
 * @param {{ store: ReturnType<import("../data/queries.js").llmStore>, key: string, kind: string, model: string,
 *   call: () => Promise<{ answer: string, ok: boolean, usage?: object }>, fresh?: boolean, ttlMs?: number,
 *   now?: () => number }} args  ttlMs 0 disables the cache; `fresh` skips the lookup but still stores
 * @returns {Promise<{ answer: string, ok: boolean, cached: boolean }>}
 */
export async function cachedLLM({ store, key, kind, model, call, fresh = false, ttlMs = CONFIG.cache.ttl.llmMs, now = Date.now }) {
  ensureStatsRegistered(now);
  const isEnabled = isCacheEnabled() && ttlMs > 0;
  if (isEnabled && !fresh) {
    const hit = readFresh(store, key, now());
    if (hit) {
      stats.hits++;
      return { answer: hit.answer, ok: true, cached: true };
    }
  }
  stats.misses++;
  const result = await singleFlight(inflight, key, call, stats);
  if (isEnabled && result.ok) store.put(answerRow({ key, kind, model, result, nowMs: now(), ttlMs }));
  return { answer: result.answer, ok: result.ok, cached: false };
}

/**
 * Make `store` the one cacheStats() reports on, and drop its expired rows now.
 * The HTTP server calls this once at startup.
 * @param {ReturnType<import("../data/queries.js").llmStore>} store
 * @param {number} [nowMs]
 * @returns {number} rows pruned
 */
export function useLlmStore(store, nowMs = Date.now()) {
  activeStore = store;
  ensureStatsRegistered();
  return store.prune(nowMs);
}

// ---------------------------------------------------------------- private helpers
// The periodic cache sweep (lib/cache.js) also prunes expired stored answers.
function ensureStatsRegistered(now = Date.now) {
  stats ??= registerStats(STATS_NAME, {
    size: () => describeStore(now),
    sweep: (nowMs = now()) => activeStore?.prune(nowMs),
  });
}

function readFresh(store, key, nowMs) {
  const row = store.get(key);
  if (!row) return null;
  if (row.expires_at === null || row.expires_at <= nowMs) {
    store.remove(key);
    stats.expired++;
    return null;
  }
  store.touch(key, nowMs);
  return row;
}

function answerRow({ key, kind, model, result, nowMs, ttlMs }) {
  return {
    key, kind, model,
    answer: result.answer,
    usage: result.usage,
    created_at: new Date(nowMs).toISOString(),
    expires_at: ttlMs === Infinity ? Number.MAX_SAFE_INTEGER : nowMs + ttlMs,
  };
}

function describeStore(now) {
  return activeStore ? activeStore.size(now()) : {};
}
