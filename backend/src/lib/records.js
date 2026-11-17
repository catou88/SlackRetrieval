// Validates the normalized record every adapter must emit, so a buggy adapter
// fails loudly at the boundary instead of corrupting the store.
// Shape: { kind, source, sourceUrl, data }.
import { RECORD_KINDS } from "../data/intelStore.js";

const REQUIRED_DATA = {
  hackathon: ["name"],
  project: ["title"],
  person: ["name"],
  contribution: ["projectUrl", "personUrl", "summary"],
  sponsor: ["name"],
  job: ["title"],
};

/**
 * @param {unknown} record
 * @returns {string[]} problems; empty when the record is valid
 */
export function validateRecord(record) {
  if (!record || typeof record !== "object") return ["record is not an object"];
  const problems = [];
  if (!RECORD_KINDS.includes(record.kind)) problems.push(`unknown kind "${record.kind}"`);
  if (!isNonEmptyString(record.source)) problems.push("missing source");
  if (!isNonEmptyString(record.sourceUrl)) problems.push("missing sourceUrl");
  if (!record.data || typeof record.data !== "object") return [...problems, "missing data"];
  for (const field of REQUIRED_DATA[record.kind] ?? []) {
    if (!isNonEmptyString(record.data[field])) problems.push(`data.${field} is required for ${record.kind}`);
  }
  return problems;
}

/**
 * Build a record. Keeps adapters terse and shape-consistent.
 * @returns {{ kind: string, source: string, sourceUrl: string, data: object }}
 */
export function makeRecord(kind, source, sourceUrl, data) {
  return { kind, source, sourceUrl, data };
}

// ---------------------------------------------------------------- private helpers
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
