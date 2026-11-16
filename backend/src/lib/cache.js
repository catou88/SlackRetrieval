// Generic caching primitives: collision-safe keys, single-flight, the one
// in-memory LRU+TTL implementation, version-checked memoization and a stats
// registry. Knows nothing about files, HTTP or models; callers inject versions
// and TTLs. No import-time side effects (caches register their stats when
// they are first constructed or used).
//
// Escape hatch: setCacheEnabled(false) (main.js calls it for CACHE=0 or
// `--no-cache`) turns off every app-level cache. A TTL of 0 turns off just one.
import crypto from "node:crypto";

const DEFAULT_MAX_ENTRIES = 500;

const registry = new Map(); // cache name -> stats record (see registerStats)
let isEnabled = true;
let sweepTimer = null;

/** @returns {boolean} whether app-level caches are on */
export function isCacheEnabled() {
  return isEnabled;
}

/** Turn every app-level cache on or off. */
export function setCacheEnabled(shouldEnable) {
  isEnabled = !!shouldEnable;
}

/**
 * Collision-safe cache key: the fields are JSON-encoded as an array (so
 * ["a|b","c"] and ["a","b|c"] differ) and hashed. Nothing is normalized.
 * @param {unknown[]} fields
 * @returns {string} sha256 hex
 */
export function hashKey(fields) {
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * Register a named cache for cacheStats().
 * @param {string} name
 * @param {{ size?: () => object, clear?: () => void, sweep?: (nowMs?: number) => void }} [hooks]
 * @returns {{ hits: number, misses: number, expired: number, evicted: number, shared: number }} counters to update
 */
export function registerStats(name, { size = () => ({}), clear = () => {}, sweep = () => {} } = {}) {
  const stats = { hits: 0, misses: 0, expired: 0, evicted: 0, shared: 0, size, clear, sweep };
  registry.set(name, stats);
  return stats;
}

/** @returns {object} { enabled, [cache]: { hits, misses, expired, evicted, hit_rate, entries, ttl_s, ... } } */
export function cacheStats() {
  const out = { enabled: isEnabled };
  for (const [name, stats] of registry) out[name] = describeStats(stats);
  return out;
}

/** Clear the named in-memory caches (all when omitted). Persistent stores are not cleared. */
export function clearCaches(names) {
  for (const [name, stats] of registry) if (!names || names.includes(name)) stats.clear();
}

/** Drop expired entries from every cache (also happens lazily on reads). */
export function sweepCaches(nowMs) {
  for (const stats of registry.values()) stats.sweep(nowMs);
}

/**
 * Start the periodic expiry sweep. The timer is unref'd so it never keeps a
 * CLI process alive. Idempotent.
 * @param {number} intervalMs  0 or Infinity disables it
 */
export function startCacheSweep(intervalMs) {
  if (sweepTimer || !(intervalMs > 0) || intervalMs === Infinity) return;
  sweepTimer = setInterval(() => sweepCaches(), intervalMs);
  sweepTimer.unref();
}

/** @returns {number | "inf"} a TTL in seconds for stats output */
export function ttlSeconds(ttlMs) {
  return ttlMs === Infinity ? "inf" : ttlMs / 1000;
}

/**
 * Share one in-flight Promise per key between identical concurrent requests.
 * The entry is removed when it settles, so a rejection is never remembered
 * and the next caller retries.
 * @template T
 * @param {Map<string, Promise<T>>} inflight
 * @param {string} key
 * @param {() => T | Promise<T>} compute
 * @param {{ shared: number }} [stats]
 * @returns {Promise<T>}
 */
export function singleFlight(inflight, key, compute, stats) {
  const running = inflight.get(key);
  if (running) {
    if (stats) stats.shared++;
    return running;
  }
  const promise = Promise.resolve()
    .then(compute)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * The single in-memory cache implementation: bounded LRU + TTL. Each entry
 * stores expiresAt; an expired entry is a miss on read (and removed), and
 * sweep() prunes the rest. ttlMs = 0 disables the cache; Infinity means no
 * expiry (still LRU-bounded). `now` is injectable for tests.
 */
export class LRU {
  /**
   * @param {string} name  shown in cacheStats()
   * @param {{ maxEntries?: number, maxBytes?: number, sizeOf?: (value) => number, ttlMs?: number, now?: () => number }} [opts]
   */
  constructor(name, { maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = Infinity, sizeOf = () => 0, ttlMs = Infinity, now = Date.now } = {}) {
    this.map = new Map();
    this.inflight = new Map();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.ttlMs = ttlMs;
    this.now = now;
    this.bytes = 0;
    this.stats = registerStats(name, {
      size: () => this.describe(),
      clear: () => this.clear(),
      sweep: (nowMs) => this.sweep(nowMs),
    });
  }

  /** @returns {boolean} false when caching is off globally or this TTL is 0 */
  get isEnabled() {
    return isEnabled && this.ttlMs > 0;
  }

  get(key) {
    if (!this.isEnabled) return undefined;
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.stats.expired++;
      this.stats.misses++;
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // most recently used goes last
    this.stats.hits++;
    return entry.value;
  }

  set(key, value) {
    if (!this.isEnabled) return;
    this.delete(key);
    const bytes = this.sizeOf(value);
    if (bytes > this.maxBytes) return;
    this.map.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.map.keys().next().value);
      this.stats.evicted++;
    }
  }

  delete(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  sweep(nowMs = this.now()) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt > nowMs) continue;
      this.delete(key);
      this.stats.expired++;
    }
  }

  /** get-or-compute with single-flight; `shouldStore(value)` decides whether it is kept. */
  async wrap(key, compute, shouldStore = () => true) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (!this.isEnabled) return compute();
    const computeAndStore = async () => {
      const value = await compute();
      if (shouldStore(value)) this.set(key, value);
      return value;
    };
    return singleFlight(this.inflight, key, computeAndStore, this.stats);
  }

  describe() {
    const bytes = this.maxBytes < Infinity ? { bytes: this.bytes, max_bytes: this.maxBytes } : {};
    return { entries: this.map.size, max_entries: this.maxEntries, ttl_s: ttlSeconds(this.ttlMs), ...bytes };
  }
}

/**
 * Load once and reuse until `versionOf()` changes or the TTL passes. A throw
 * is never cached. Stats register on the first call, not at import.
 * @template T
 * @param {string} name  shown in cacheStats()
 * @param {() => string} versionOf  cheap version stamp of the inputs
 * @param {() => T} load
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 * @returns {() => T}
 */
export function memoize(name, versionOf, load, { ttlMs = Infinity, now = Date.now } = {}) {
  let slot = null; // { version, value, expiresAt }
  let stats = null;
  const register = () =>
    registerStats(name, {
      size: () => ({ entries: slot ? 1 : 0, ttl_s: ttlSeconds(ttlMs) }),
      clear: () => (slot = null),
      sweep: (nowMs = now()) => {
        if (!slot || slot.expiresAt > nowMs) return;
        slot = null;
        stats.expired++;
      },
    });
  return () => {
    stats ??= register();
    if (!isEnabled || !(ttlMs > 0)) return load();
    const version = versionOf();
    if (slot && slot.version === version && slot.expiresAt > now()) {
      stats.hits++;
      return slot.value;
    }
    stats.misses++;
    const value = load();
    slot = { version, value, expiresAt: now() + ttlMs };
    return value;
  };
}

// ---------------------------------------------------------------- private helpers
function describeStats(stats) {
  const total = stats.hits + stats.misses;
  return {
    hits: stats.hits,
    misses: stats.misses,
    expired: stats.expired,
    evicted: stats.evicted,
    ...(stats.shared ? { single_flight_shared: stats.shared } : {}),
    hit_rate: total ? +(stats.hits / total).toFixed(3) : null,
    ...stats.size(),
  };
}
