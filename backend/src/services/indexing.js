// Owns turning the JSON snapshot into the derived stores: the vector index
// (local embeddings) and the SQLite database the website reads.
import { readJSON, FILES } from "../data/jsonStore.js";
import { buildIndex } from "../data/vectorIndex.js";
import { openDb, rebuildDb, loadSnapshot } from "../data/db.js";
import { embed, embedModel } from "../clients/embedder.js";

/**
 * Embed messages not yet indexed and write the index atomically.
 * @returns {Promise<{ count: number, added: number }>}
 */
export async function rebuildSearchIndex({ log = console.log } = {}) {
  return buildIndex({
    messages: readJSON(FILES.messages, []),
    people: readJSON(FILES.people, {}),
    embed,
    model: embedModel(),
    log,
  });
}

/** Replace the Slack tables in data/slack.db with the current snapshot (notes and briefs are kept). */
export function refreshDatabase({ log = console.log } = {}) {
  const db = openDb();
  try {
    rebuildDb(db, loadSnapshot(), { log });
  } finally {
    db.close();
  }
}
