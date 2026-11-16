// Owns the in-memory cache of read-only GET responses: keyed by the exact URL
// (path + raw query string) and valid only for the data version it was
// computed under, so any write (ours, or `npm run sync` in another process)
// invalidates it immediately. Identical concurrent requests compute once.
import { CONFIG } from "../../config.js";
import { LRU, hashKey, singleFlight } from "../../lib/cache.js";
import { etagOf } from "./respond.js";

const MAX_ENTRIES = 300;
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * @param {{ currentDataVersion: () => string }} deps  cheap stamp of everything GET handlers read
 * @returns {{ getOrCompute: Function, invalidate: () => void }}
 */
export function createResponseCache({ currentDataVersion }) {
  const responses = new LRU("api-responses", {
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    sizeOf: (entry) => entry.body.length,
    ttlMs: CONFIG.cache.ttl.apiMs, // data changes still invalidate immediately
  });
  const inflight = new Map();

  /**
   * @param {URL} url
   * @param {() => Promise<unknown>} compute  the route handler
   * @param {{ isCacheable: boolean }} opts
   * @returns {Promise<{ body: Buffer, etag: string, status: "HIT" | "MISS" | "BYPASS" }>}
   */
  async function getOrCompute(url, compute, { isCacheable }) {
    if (!responses.isEnabled || !isCacheable) return { ...(await serialize(compute)), status: "BYPASS" };
    const key = hashKey(["GET", url.pathname, url.search]);
    const version = currentDataVersion();
    const hit = responses.get(key);
    if (hit && hit.version === version) return { ...hit, status: "HIT" };
    if (hit) responses.delete(key); // computed under older data
    const entry = await singleFlight(inflight, hashKey([key, version]), async () => {
      const computed = { ...(await serialize(compute)), version };
      // Never keep a response computed while a write happened.
      if (currentDataVersion() === version) responses.set(key, computed);
      return computed;
    });
    return { ...entry, status: "MISS" };
  }

  return { getOrCompute, invalidate: () => responses.clear() };
}

// ---------------------------------------------------------------- private helpers
async function serialize(compute) {
  const body = Buffer.from(JSON.stringify(await compute()));
  return { body, etag: etagOf(body) };
}
