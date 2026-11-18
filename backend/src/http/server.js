// Composition root for the local website (http://localhost:3000, bound to
// 127.0.0.1 so it is only reachable from this computer): opens the database,
// rebuilds it from the JSON snapshot when missing or outdated, wires the cache
// and the router, and starts listening. Nothing runs at import time.
import http from "node:http";
import { CONFIG } from "../config.js";
import { isCacheEnabled, startCacheSweep } from "../lib/cache.js";
import { fileVersion } from "../data/jsonStore.js";
import { createIntelTables } from "../data/intelStore.js";
import { openDb, needsRebuild, rebuildDb, loadSnapshot } from "../data/db.js";
import { llmStoreFor, dataVersion as databaseVersion } from "../data/queries.js";
import { INDEX_FILES } from "../data/vectorIndex.js";
import { useLlmStore } from "../services/llmCache.js";
import { createResponseCache } from "./middleware/responseCache.js";
import { createRequestHandler } from "./router.js";
import { API_ROUTES } from "./routes/index.js";

// Files GET handlers read besides the database: semantic search reads the vector index.
const RESPONSE_INPUT_FILES = INDEX_FILES;

/**
 * Start the website.
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<http.Server>} resolves once listening
 */
export function startServer({ port = CONFIG.port, host = CONFIG.host } = {}) {
  const db = openDatabaseForServer();
  useLlmStore(llmStoreFor(db)); // prunes expired Claude answers now and on every sweep
  startCacheSweep(CONFIG.cache.ttl.sweepMs);

  // Our own writes bump writeGeneration; other processes' commits change the
  // database version; rebuilt snapshot / index files change their file stamps.
  let writeGeneration = 0;
  const currentDataVersion = () => `${databaseVersion(db)}:${writeGeneration}:${fileVersion(RESPONSE_INPUT_FILES)}`;
  const responseCache = createResponseCache({ currentDataVersion });
  const handleRequest = createRequestHandler({
    db,
    routes: API_ROUTES,
    responseCache,
    onDataWrite: () => writeGeneration++,
  });

  const server = http.createServer(handleRequest);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`Slack archive running at http://localhost:${port}${isCacheEnabled() ? "" : " (caching disabled)"}`);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------- private helpers
// First run before any sync (or after a schema change): build the Slack tables
// from the JSON snapshot so the site still loads.
function openDatabaseForServer() {
  const db = openDb();
  if (needsRebuild(db)) rebuildDb(db, loadSnapshot(), { log: () => {} });
  createIntelTables(db); // so /api/intel/* works before the first intel:ingest
  return db;
}
