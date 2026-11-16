// Owns exporting the contact book as data/contacts.csv for spreadsheets.
import fs from "node:fs";
import { readJSON, dataPath, FILES } from "../data/jsonStore.js";

const CSV_FILE = "contacts.csv";
// Spreadsheets run a cell starting with one of these as a formula; names and
// titles come from Slack, so anyone in the workspace controls them.
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const CSV_COLUMNS = ["name", "handle", "title", "roles", "linkedin", "other_links", "email", "dm_count", "message_count", "last_seen", "channels"];

/**
 * @returns {{ file: string, count: number }} where it was written and how many contacts
 */
export function exportContactsCsv() {
  const people = Object.values(readJSON(FILES.people, {})).filter((person) => !person.is_me);
  const rows = [CSV_COLUMNS, ...people.map(contactRow)];
  const file = dataPath(CSV_FILE);
  fs.writeFileSync(file, rows.map((row) => row.map(quoteCsvField).join(",")).join("\n"));
  return { file, count: people.length };
}

// ---------------------------------------------------------------- private helpers
function contactRow(person) {
  return [
    person.name, person.handle, person.title, person.roles.join("; "), person.linkedin.join(" "),
    person.other_links.join(" "), person.email, person.dm_count, person.message_count, person.last_seen,
    person.channels.join("; "),
  ];
}

function quoteCsvField(value) {
  const text = String(value ?? "");
  const safeText = FORMULA_TRIGGER_RE.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}
