// People export as CSV (spreadsheet) and vCard (contacts app), built in the browser so the
// contact list survives after workspace access ends. Also "copy all LinkedIn links".
import { announce } from "../utils/dom.js";
import { formatDate } from "../utils/format.js";
import { nameOf, roleChipsOf, howYouMet } from "../utils/people.js";
import { noteStatusOf } from "../utils/noteStatus.js";
import { preferences } from "../contexts/preferences.js";
import { store, teammateOf, offerCountOf, offerTypesOf } from "../contexts/appState.js";
import { copyText } from "./clipboard.js";
import { downloadTextFile } from "./download.js";

const CSV_HEADER = ["Name", "Slack handle", "Title", "Organization", "Roles", "How you met", "Offered help (posts)", "Offer types",
  "LinkedIn", "Other links", "Email", "Timezone", "Contacted", "Follow up", "Replied", "Notes", "Slack ID"];
// Exporting most of the list counts as "exported" for the Home ribbon; a filtered slice does not.
const FULL_EXPORT_SHARE = 0.9;
const VCARD_FOLD_AT = 74;
const LAST_EXPORT_PREFERENCE = "exported";

/** CSV text with a UTF-8 BOM and CRLF rows (what Excel expects). */
export function toCsv(people) {
  const rows = people.map(csvRow);
  return "\uFEFF" + [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** vCard 3.0 text, one card per person. */
export function toVCard(people) {
  return people.map((person) => vCardLines(person).map(foldVCardLine).join("\r\n")).join("\r\n") + "\r\n";
}

/** Download `people` as "csv" or "vcf" and announce it. */
export function exportPeople(people, format, label = "people") {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "vcf") downloadTextFile(`lanyard-${label}-${stamp}.vcf`, toVCard(people), "text/vcard;charset=utf-8");
  else downloadTextFile(`lanyard-${label}-${stamp}.csv`, toCsv(people), "text/csv;charset=utf-8");
  if (people.length >= store.people.length * FULL_EXPORT_SHARE) preferences.set(LAST_EXPORT_PREFERENCE, new Date().toISOString());
  announce(`Downloaded ${people.length} contacts as ${format === "vcf" ? "vCard" : "CSV"}`);
}

/** Date of the last full export, formatted, or "" if never. */
export function lastExportLabel() {
  const exportedAt = preferences.get(LAST_EXPORT_PREFERENCE, "");
  return exportedAt ? formatDate(exportedAt) : "";
}

/** Copy "Name<TAB>LinkedIn URL" lines. @returns {Promise<number>} how many were copied (0 on failure) */
export async function copyAllLinkedIns(people = store.people) {
  const lines = people.filter((person) => person.linkedin.length).map((person) => `${nameOf(person)}\t${person.linkedin[0]}`);
  const isCopied = await copyText(lines.join("\n"));
  announce(isCopied ? `Copied ${lines.length} LinkedIn links` : "Couldn't copy. Use Export instead.");
  return isCopied ? lines.length : 0;
}

// ---------- private helpers ----------

function csvRow(person) {
  const status = noteStatusOf(person);
  return [nameOf(person), person.handle, person.title, person.org, rolesText(person), howYouMet(person, teammateOf(person.id)),
    offerCountOf(person) || "", offerTypesOf(person).join("; "), person.linkedin.join(" "), (person.other_links || []).join(" "),
    person.email, person.timezone, dateOrYes(status.contacted, status.contactedOn), status.followUp || "",
    dateOrYes(status.replied, status.repliedOn), status.text.trim(), person.id];
}

function rolesText(person) {
  return roleChipsOf(person, teammateOf(person.id))
    .map((chip) => (chip.kind === "sponsor" ? `Sponsor (${chip.label})` : chip.label))
    .join("; ");
}

// "2026-11-05" when the date is known, "yes" when only the flag is set, "" otherwise.
function dateOrYes(isSet, isoDate) {
  if (!isSet) return "";
  return isoDate || "yes";
}

function vCardEscape(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

// RFC 6350 folds at 75 octets; characters are a close enough approximation here.
function foldVCardLine(line) {
  return line.length <= VCARD_FOLD_AT ? line : line.match(/.{1,73}/gu).join("\r\n ");
}

function csvCell(value) {
  let text = String(value ?? "");
  // A leading = + - @ makes spreadsheet apps evaluate the cell as a formula.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function vCardLines(person) {
  const name = nameOf(person);
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vCardEscape(name)}`, vCardNameLine(name)];
  if (person.org) lines.push(`ORG:${vCardEscape(person.org)}`);
  if (person.title) lines.push(`TITLE:${vCardEscape(person.title)}`);
  if (person.email) lines.push(`EMAIL;TYPE=INTERNET:${vCardEscape(person.email)}`);
  for (const url of person.linkedin) lines.push(`URL;TYPE=LinkedIn:${url}`);
  for (const url of person.other_links || []) lines.push(`URL:${url}`);
  if (person.handle) lines.push(`X-SOCIALPROFILE;TYPE=slack:@${vCardEscape(person.handle)}`);
  const note = vCardNote(person);
  if (note) lines.push(`NOTE:${vCardEscape(note)}`);
  lines.push("CATEGORIES:Cal Hacks 13.0", "END:VCARD");
  return lines;
}

// N:family;given;;; — the last word is the family name when there is more than one word.
function vCardNameLine(name) {
  const parts = name.split(/\s+/);
  const hasSurname = parts.length > 1;
  const familyName = hasSurname ? parts[parts.length - 1] : "";
  const givenName = hasSurname ? parts.slice(0, -1).join(" ") : name;
  return `N:${vCardEscape(familyName)};${vCardEscape(givenName)};;;`;
}

function vCardNote(person) {
  const roles = rolesText(person);
  return [roles && `Cal Hacks 13.0: ${roles}`, howYouMet(person, teammateOf(person.id)), noteStatusOf(person).text.trim()].filter(Boolean).join("\n");
}
