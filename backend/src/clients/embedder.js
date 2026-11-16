// Owns the local embedding model (all-MiniLM-L6-v2 by default, ~23 MB,
// downloaded once into data/models and run on the CPU; no API key). The
// transformers library is imported lazily on first use, so importing this
// module (e.g. from tests) costs nothing. Query embeddings are cached.
import path from "node:path";
import { CONFIG } from "../config.js";
import { LRU, hashKey } from "../lib/cache.js";

const QUERY_CACHE_MAX_ENTRIES = 500;

let extractorPromise = null;
let queryVectors = null; // LRU, created on first query

/** @returns {string} the embedding model id (part of every cache key and the index meta) */
export function embedModel() {
  return CONFIG.embedModel;
}

/**
 * Embed texts as normalized vectors (so dot product == cosine similarity).
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function embed(texts) {
  const extractor = await loadExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const dims = output.dims[1];
  return texts.map((_, i) => output.data.slice(i * dims, (i + 1) * dims));
}

/**
 * Embed one search query, cached by [model, exact text] (no trimming or
 * lowercasing); identical concurrent queries share one model run.
 * Embeddings are deterministic per model, so the TTL only bounds memory.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedQuery(text) {
  queryVectors ??= new LRU("query-embeddings", { maxEntries: QUERY_CACHE_MAX_ENTRIES, ttlMs: CONFIG.cache.ttl.embedMs });
  const isUsable = (vector) => vector?.length > 0;
  return queryVectors.wrap(hashKey([CONFIG.embedModel, text]), async () => (await embed([text]))[0], isUsable);
}

// ---------------------------------------------------------------- private helpers
function loadExtractor() {
  extractorPromise ??= (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = path.join(CONFIG.dataDir, "models");
    return pipeline("feature-extraction", CONFIG.embedModel);
  })();
  // A failed load (e.g. offline first run) is not remembered.
  extractorPromise.catch(() => (extractorPromise = null));
  return extractorPromise;
}
