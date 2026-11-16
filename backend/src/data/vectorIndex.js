// Owns the on-disk vector index (data/index.bin + data/index.meta.json):
// what text is embedded per message, incremental atomic rebuilds, verified
// loads, and brute-force cosine search over it. The embedder is injected, so
// this module never loads the model itself.
import crypto from "node:crypto";
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { memoize } from "../lib/cache.js";
import { IndexUnavailableError } from "../lib/errors.js";
import { readJSON, writeJSON, writeFileAtomic, dataPath, fileVersion, FILES } from "./jsonStore.js";

/** Bump when chunkText() changes, so the next build re-embeds everything. */
export const CHUNK_VERSION = 1;
export const INDEX_FILES = [FILES.indexVectors, FILES.indexMeta];

const BYTES_PER_FLOAT = 4;
const DEFAULT_BATCH_SIZE = 32;
const PROGRESS_EVERY_BATCHES = 10;
const PARENT_PREVIEW_CHARS = 200;
const LOAD_ATTEMPTS = 5;
const LOAD_RETRY_DELAY_MS = 20; // a rebuild swaps bin then meta; give the second rename a moment

const loadIndexMemo = memoize("vector-index", () => fileVersion(INDEX_FILES), readVerifiedIndex, {
  ttlMs: CONFIG.cache.ttl.memoMs,
});

/**
 * What gets embedded for one message: who said it, where, and the thread it
 * belongs to, so "what did the Google mentor say about auth" works.
 * @param {object} message
 * @param {Record<string, object>} people
 * @param {Map<string, object>} messagesById
 * @returns {string}
 */
export function chunkText(message, people, messagesById) {
  const author = people[message.user_id];
  const role = author?.title ? ` (${author.title})` : "";
  const parent = message.thread_ts ? messagesById.get(`${message.channel_id}:${message.thread_ts}`) : null;
  const context = parent ? `\n[reply to ${parent.user_name}: ${parent.text.slice(0, PARENT_PREVIEW_CHARS)}]` : "";
  return `${message.channel} — ${message.user_name}${role}: ${message.text}${context}`;
}

/**
 * Embed messages not yet in the index and write the index atomically.
 * @param {{ messages: object[], people: object, embed: (texts: string[]) => Promise<Float32Array[]>,
 *   model: string, log?: (line: string) => void, batchSize?: number }} args
 * @returns {Promise<{ count: number, added: number }>}
 */
export async function buildIndex({ messages, people, embed, model, log = console.log, batchSize = DEFAULT_BATCH_SIZE }) {
  const withText = messages.filter((message) => message.text?.trim());
  const messagesById = new Map(withText.map((message) => [message.id, message]));
  const { meta, vectors } = reusableIndex(model);
  const known = new Set(meta.ids);
  const todo = withText.filter((message) => !known.has(message.id));
  log(`Embedding ${todo.length} new messages (${known.size} already indexed)…`);
  for (let start = 0; start < todo.length; start += batchSize) {
    const batch = todo.slice(start, start + batchSize);
    const batchVectors = await embed(batch.map((message) => chunkText(message, people, messagesById)));
    batch.forEach((message, i) => {
      meta.ids.push(message.id);
      vectors.push(batchVectors[i]);
    });
    meta.dims = batchVectors[0].length;
    if ((start / batchSize) % PROGRESS_EVERY_BATCHES === 0) log(`  ${Math.min(start + batchSize, todo.length)}/${todo.length}`);
  }
  writeIndex(meta, vectors);
  log(`Index has ${meta.ids.length} vectors.`);
  return { count: meta.ids.length, added: todo.length };
}

/**
 * The verified index, loaded once and reused until its files change.
 * @returns {{ ids: string[], dims: number, flat: Float32Array, model: string }}
 * @throws {IndexUnavailableError} no index yet, or a rebuild is mid-swap
 */
export function loadIndex() {
  return loadIndexMemo();
}

/** @returns {number} dot product of vector `row` of the index with `vector` (cosine: vectors are normalized) */
export function dot(flat, row, dims, vector) {
  let sum = 0;
  const offset = row * dims;
  for (let d = 0; d < dims; d++) sum += flat[offset + d] * vector[d];
  return sum;
}

/** @returns {number} best similarity of index row `row` to any of `vectors` (-1 when none) */
export function maxSimilarity(index, row, vectors) {
  let best = -1;
  for (const vector of vectors) best = Math.max(best, dot(index.flat, row, index.dims, vector));
  return best;
}

/**
 * Top-k cosine similarity.
 * @param {{ ids: string[], dims: number, flat: Float32Array }} index
 * @param {Float32Array} queryVector
 * @param {{ k?: number, filter?: (id: string) => boolean }} [opts]  filter restricts the search
 * @returns {{ id: string, score: number }[]}
 */
export function searchIndex(index, queryVector, { k = 12, filter } = {}) {
  const { flat, dims, ids } = index;
  const vectorCount = Math.min(ids.length, Math.floor(flat.length / dims)); // guards a caller-supplied index
  const scored = [];
  for (let row = 0; row < vectorCount; row++) {
    if (filter && !filter(ids[row])) continue;
    scored.push({ id: ids[row], score: dot(flat, row, dims, queryVector) });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

/**
 * Read index.bin + index.meta.json and verify they belong together.
 * @returns {object | null} null when the pair does not verify (count, size or checksum)
 * @throws {IndexUnavailableError} when there is no index at all
 */
export function readIndexPair() {
  const meta = readJSON(FILES.indexMeta, null);
  if (!meta || !fs.existsSync(dataPath(FILES.indexVectors))) throw new IndexUnavailableError();
  const bytes = fs.readFileSync(dataPath(FILES.indexVectors));
  const hasExpectedSize = bytes.byteLength === meta.ids.length * meta.dims * BYTES_PER_FLOAT;
  const hasExpectedCount = meta.count === undefined || meta.count === meta.ids.length;
  const hasExpectedChecksum = meta.checksum === undefined || meta.checksum === sha1(bytes); // older indexes have none
  if (!hasExpectedSize || !hasExpectedCount || !hasExpectedChecksum) return null;
  return { ...meta, flat: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / BYTES_PER_FLOAT) };
}

// ---------------------------------------------------------------- private helpers
function readVerifiedIndex() {
  for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
    const index = readIndexPair();
    if (index) return index;
    sleepSync(LOAD_RETRY_DELAY_MS);
  }
  throw new IndexUnavailableError("The search index is being rebuilt — try again in a moment.");
}

function reusableIndex(model) {
  const meta = readJSON(FILES.indexMeta, null);
  const chunkVersion = meta?.chunkVersion ?? 1; // indexes from before CHUNK_VERSION used version 1
  const isReusable = meta && meta.model === model && meta.dims && chunkVersion === CHUNK_VERSION
    && fs.existsSync(dataPath(FILES.indexVectors));
  if (!isReusable) return { meta: { model, dims: 0, ids: [] }, vectors: [] };
  const bytes = fs.readFileSync(dataPath(FILES.indexVectors));
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / BYTES_PER_FLOAT);
  const vectors = meta.ids.map((_, row) => all.slice(row * meta.dims, (row + 1) * meta.dims));
  return { meta: { ...meta, ids: [...meta.ids] }, vectors };
}

// Vectors first and meta last, each tmp + rename; the meta records the count
// and a checksum of index.bin so readers can verify the pair.
function writeIndex(meta, vectors) {
  const flat = new Float32Array(vectors.length * (meta.dims || 0));
  vectors.forEach((vector, row) => flat.set(vector, row * meta.dims));
  const bytes = Buffer.from(flat.buffer);
  writeFileAtomic(dataPath(FILES.indexVectors), bytes);
  writeJSON(FILES.indexMeta, { ...meta, chunkVersion: CHUNK_VERSION, count: meta.ids.length, checksum: sha1(bytes) });
}

function sha1(bytes) {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
