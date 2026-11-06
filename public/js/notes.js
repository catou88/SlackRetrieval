// "@status" line convention inside a person's note, plus a serial save queue.
//   @status contacted 2026-11-05 · follow-up 2026-11-20
//   free text…
import { post, store } from "./store.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validISO = (s) => ISO.test(s) && !isNaN(new Date(s + "T12:00:00"));
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function parseNote(body) {
  const s = { contacted: false, contactedOn: null, followUp: null, extra: [], text: "" };
  if (!body) return s;
  const lines = String(body).replace(/^\s+/, "").split("\n");
  if (!/^@status\b/i.test(lines[0])) { s.text = String(body); return s; }
  for (const tok of lines[0].replace(/^@status\b/i, "").split(/\s*[·|,]\s*/).map((t) => t.trim()).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^contacted(?:\s+(\S+))?$/i))) {
      if (m[1] && !validISO(m[1])) s.extra.push(tok);
      else { s.contacted = true; s.contactedOn = m[1] || null; }
    } else if ((m = tok.match(/^follow[- ]?up\s+(\S+)$/i)) && validISO(m[1])) s.followUp = m[1];
    else if (/^(★|star)$/i.test(tok)) { /* star was cut from v1; drop silently */ }
    else s.extra.push(tok);
  }
  s.text = lines.slice(1).join("\n");
  return s;
}

export function serializeNote(s) {
  const t = [];
  if (s.contacted) t.push(s.contactedOn ? `contacted ${s.contactedOn}` : "contacted");
  if (s.followUp) t.push(`follow-up ${s.followUp}`);
  t.push(...(s.extra || []));
  return t.length ? `@status ${t.join(" · ")}\n${s.text || ""}` : s.text || "";
}

export const statusOf = (p) => {
  const s = parseNote(p?.note);
  const today = todayISO();
  s.due = !!s.followUp && s.followUp <= today;
  s.overdue = !!s.followUp && s.followUp < today;
  return s;
};

// One queue per person: if a save is in flight, only the latest pending body goes next.
const queues = new Map();
export function saveNote(id, body, onState) {
  const q = queues.get(id) || { busy: false, next: null };
  queues.set(id, q);
  q.next = body;
  const p = store.byId.get(id);
  if (p) p.note = body;
  const run = async () => {
    if (q.busy || q.next == null) return;
    q.busy = true;
    const b = q.next; q.next = null;
    onState?.("saving");
    try { await post("/api/note", { person_id: id, body: b }); onState?.(q.next == null ? "saved" : "saving"); }
    catch (e) { onState?.("error", e); if (q.next == null) q.next = b; q.busy = false; return; }
    q.busy = false;
    run();
  };
  run();
  return { retry: run };
}
