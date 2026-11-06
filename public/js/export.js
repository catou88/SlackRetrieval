// Client-side export of people as CSV and vCard (no backend). Bold idea #1 / S2.
import { download, copyText, announce, date } from "./html.js";
import { store, nameOf, chipsOf, howMet, pref } from "./store.js";
import { statusOf } from "./notes.js";

const roles = (p) => chipsOf(p).map((c) => (c.kind === "sponsor" ? `Sponsor (${c.label})` : c.label)).join("; ");
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheet apps from evaluating cells
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(people) {
  const head = ["Name", "Slack handle", "Title", "Organization", "Roles", "How you met", "LinkedIn", "Other links", "Email", "Timezone", "Contacted", "Follow up", "Notes", "Slack ID"];
  const rows = people.map((p) => {
    const s = statusOf(p);
    return [nameOf(p), p.handle && "@" + p.handle, p.title, p.org, roles(p), howMet(p), p.linkedin.join(" "), (p.other_links || []).join(" "), p.email, p.timezone,
      s.contacted ? s.contactedOn || "yes" : "", s.followUp || "", s.text.trim(), p.id];
  });
  return "\uFEFF" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

const vEsc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
// RFC 6350 line folding at 75 octets (approximate by chars).
const fold = (line) => line.length <= 74 ? line : line.match(/.{1,73}/gu).join("\r\n ");
export function toVCard(people) {
  return people.map((p) => {
    const n = nameOf(p);
    const parts = n.split(/\s+/);
    const s = statusOf(p);
    const note = [roles(p) && `Cal Hacks 13.0: ${roles(p)}`, howMet(p), s.text.trim()].filter(Boolean).join("\n");
    const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vEsc(n)}`,
      `N:${vEsc(parts.length > 1 ? parts.slice(-1)[0] : "")};${vEsc(parts.length > 1 ? parts.slice(0, -1).join(" ") : n)};;;`];
    if (p.org) lines.push(`ORG:${vEsc(p.org)}`);
    if (p.title) lines.push(`TITLE:${vEsc(p.title)}`);
    if (p.email) lines.push(`EMAIL;TYPE=INTERNET:${vEsc(p.email)}`);
    for (const u of p.linkedin) lines.push(`URL;TYPE=LinkedIn:${u}`);
    for (const u of p.other_links || []) lines.push(`URL:${u}`);
    if (p.handle) lines.push(`X-SOCIALPROFILE;TYPE=slack:@${vEsc(p.handle)}`);
    if (note) lines.push(`NOTE:${vEsc(note)}`);
    lines.push("CATEGORIES:Cal Hacks 13.0", "END:VCARD");
    return lines.map(fold).join("\r\n");
  }).join("\r\n") + "\r\n";
}

const stamp = () => new Date().toISOString().slice(0, 10);
export function exportPeople(people, kind, label = "people") {
  if (kind === "vcf") download(`lanyard-${label}-${stamp()}.vcf`, toVCard(people), "text/vcard;charset=utf-8");
  else download(`lanyard-${label}-${stamp()}.csv`, toCSV(people), "text/csv;charset=utf-8");
  if (people.length >= store.people.length * 0.9) pref.set("exported", new Date().toISOString());
  announce(`Downloaded ${people.length} contacts as ${kind === "vcf" ? "vCard" : "CSV"}`);
}
export const lastExport = () => pref.get("exported", "");
export const lastExportLabel = () => (lastExport() ? date(lastExport()) : "");

export async function copyAllLinkedIns(people = store.people) {
  const lines = people.filter((p) => p.linkedin.length).map((p) => `${nameOf(p)}\t${p.linkedin[0]}`);
  const ok = await copyText(lines.join("\n"));
  announce(ok ? `Copied ${lines.length} LinkedIn links` : "Couldn't copy. Use Export instead.");
  return ok ? lines.length : 0;
}
