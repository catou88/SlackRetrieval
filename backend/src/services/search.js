// Owns message search: semantic (local embeddings over the vector index) and
// keyword (SQLite FTS5). Callers get message ids + scores (semantic) or full
// rows (keyword); turning hits into rows for the API is done here too.
import { embedQuery } from "../clients/embedder.js";
import { loadIndex, searchIndex } from "../data/vectorIndex.js";
import { ftsSearch, messagesByIds } from "../data/queries.js";

const DEFAULT_K = 12;
const API_SEMANTIC_K = 50;
const API_KEYWORD_LIMIT = 100;

/**
 * Top-k messages by cosine similarity to `query`.
 * @param {string} query
 * @param {{ k?: number, filter?: (id: string) => boolean, index?: object }} [opts]  index defaults to the on-disk one
 * @returns {Promise<{ id: string, score: number }[]>}
 * @throws {import("../lib/errors.js").IndexUnavailableError}
 */
export async function semanticSearch(query, { k = DEFAULT_K, filter, index } = {}) {
  const searchable = index ?? loadIndex();
  return searchIndex(searchable, await embedQuery(query), { k, filter });
}

/**
 * Search for the archive page.
 * @param {import("better-sqlite3").Database} db
 * @param {string} text  validated, non-blank
 * @param {"semantic" | "keyword"} mode
 * @returns {Promise<object[]>} message rows (semantic rows carry `score`)
 */
export async function searchMessages(db, text, mode) {
  if (mode === "keyword") return keywordSearch(db, text);
  const hits = await semanticSearch(text, { k: API_SEMANTIC_K });
  const scoreById = new Map(hits.map((hit) => [hit.id, hit.score]));
  return messagesByIds(db, hits.map((hit) => hit.id)).map((row) => ({ ...row, score: scoreById.get(row.id) }));
}

// ---------------------------------------------------------------- private helpers
// Every word becomes a quoted FTS5 term, so user text can never be FTS syntax.
function keywordSearch(db, text) {
  const words = text.split(/\s+/).map((word) => word.replace(/"/g, "")).filter(Boolean);
  if (!words.length) return [];
  return ftsSearch(db, words.map((word) => `"${word}"`).join(" "), { limit: API_KEYWORD_LIMIT });
}
