// Adapter for hand-supplied data: JSON (array of normalized records) or CSV
// (a `kind` and `sourceUrl` column, every other column becomes a data field).
// This is the sanctioned route for LinkedIn URLs, extra hackathons and jobs.
import fs from "node:fs";
import { makeRecord } from "../lib/records.js";

export const name = "manual";

/**
 * @param {{ file: string }} options  path to a .json or .csv file
 * @param {object} [deps]  `readFile` overrides fs for tests
 * @returns {Promise<object[]>}
 */
export async function fetchRecords(options, deps = {}) {
  if (!options.file) throw new Error("manual adapter needs --file <path.json|csv>");
  const text = (deps.readFile ?? ((f) => fs.readFileSync(f, "utf8")))(options.file);
  return options.file.toLowerCase().endsWith(".csv") ? parseCsvRecords(text) : parseJsonRecords(text);
}

/** @returns {object[]} records re-tagged with source "manual" */
export function parseJsonRecords(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("manual JSON must be an array of records");
  return rows.map((r) => makeRecord(r.kind, "manual", r.sourceUrl, r.data ?? {}));
}

/** @returns {object[]} one record per CSV row; empty cells are dropped */
export function parseCsvRecords(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.filter((row) => row.some((cell) => cell !== "")).map((row) => {
    const fields = Object.fromEntries(header.map((column, i) => [column.trim(), row[i] ?? ""]).filter(([, v]) => v !== ""));
    const { kind, sourceUrl, ...data } = fields;
    return makeRecord(kind, "manual", sourceUrl, data);
  });
}

// ---------------------------------------------------------------- private helpers
// Minimal RFC 4180 parser: quoted fields, "" escapes, commas/newlines in quotes.
function parseCsv(text) {
  const rows = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { rows.at(-1).push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rows.at(-1).push(cell); cell = ""; rows.push([]);
    } else cell += ch;
  }
  if (cell !== "" || rows.at(-1).length) rows.at(-1).push(cell);
  return rows.filter((row) => row.length);
}
