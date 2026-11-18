// Runs data-source adapters and stores what they return. Adapters only fetch
// and normalize; this service is the single place that validates each record
// and writes it to the intel store, so one bad record never aborts a run.
import { getAdapter, adapterNames } from "../adapters/registry.js";
import { validateRecord } from "../lib/records.js";
import { createIntelTables, upsertRecord, intelCounts, listProjects } from "../data/intelStore.js";

const MAX_REPORTED_PROBLEMS = 20;

/**
 * Run one adapter and store its records.
 * @param {import("better-sqlite3").Database} db
 * @param {string} adapterName  a name from the adapter registry
 * @param {object} options  adapter-specific options (e.g. maxHackathons)
 * @param {object} deps  adapter dependencies (e.g. { http })
 * @returns {Promise<{ adapter: string, fetched: number, stored: number, problems: string[], counts: Record<string, number> }>}
 */
export async function ingestFromAdapter(db, adapterName, options = {}, deps = {}) {
  createIntelTables(db);
  const adapter = getAdapter(adapterName);
  // Adapters that enrich existing rows (github) read them from `projects`.
  const records = await adapter.fetchRecords(options, { projects: listProjects(db), ...deps });
  const problems = [];
  let stored = 0;
  for (const record of records) {
    const error = storeRecord(db, record);
    if (error) problems.push(error);
    else stored++;
  }
  return {
    adapter: adapter.name,
    fetched: records.length,
    stored,
    problems: problems.slice(0, MAX_REPORTED_PROBLEMS),
    counts: intelCounts(db),
  };
}

/**
 * Run several adapters in order; a failing adapter is reported, not fatal,
 * because a blocked site must not stop the other sources.
 * @param {string[]} names  empty means every registered adapter
 * @returns {Promise<object[]>} one summary per adapter (with `error` when it threw)
 */
export async function ingestAll(db, names, options = {}, deps = {}) {
  const selected = names.length ? names : adapterNames();
  const summaries = [];
  for (const adapterName of selected) {
    try {
      summaries.push(await ingestFromAdapter(db, adapterName, options, deps));
    } catch (err) {
      summaries.push({ adapter: adapterName, fetched: 0, stored: 0, problems: [], error: err.message });
    }
  }
  return summaries;
}

// ---------------------------------------------------------------- private helpers
/** @returns {string | null} an error description, or null when stored */
function storeRecord(db, record) {
  const invalid = validateRecord(record);
  if (invalid.length) return `invalid ${record?.kind}: ${invalid.join("; ")}`;
  try {
    upsertRecord(db, record);
    return null;
  } catch (err) {
    return `store failed for ${record.sourceUrl}: ${err.message}`;
  }
}
