// Data layer: api() with a session GET cache and abortable requests, the people store,
// and the single source of truth for roles (roleOf / stripOf / chipsOf / howMet).

const cache = new Map();
export class NetError extends Error {}

export async function api(url, { signal, fresh = false } = {}) {
  if (!fresh && cache.has(url)) return cache.get(url);
  let res;
  try { res = await fetch(url, { signal }); }
  catch (e) { if (e.name === "AbortError") throw e; throw new NetError("The archive server isn't running."); }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (data && data.error && !Array.isArray(data))) throw new Error(data.error || `HTTP ${res.status}`);
  cache.set(url, data);
  return data;
}
export async function post(url, body) {
  let res;
  try { res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new NetError("The archive server isn't running."); }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export const invalidate = (prefix) => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

// A request slot: starting a new request aborts the previous one.
export function slot() {
  let ctl;
  return (url, opts) => { ctl?.abort(); ctl = new AbortController(); return api(url, { ...opts, signal: ctl.signal }); };
}

export const store = {
  stats: null,
  people: [],
  byId: new Map(),
  teammates: [],
  tmById: new Map(),
  channels: null,
  introByUser: null,
};

export async function boot() {
  const [stats, people, teammates] = await Promise.all([api("/api/stats"), api("/api/people"), api("/api/teammates")]);
  store.stats = stats;
  store.people = people;
  for (const p of people) store.byId.set(p.id, p);
  store.teammates = teammates;
  for (const t of teammates) store.tmById.set(t.id, t);
}
export async function channels() {
  if (!store.channels) store.channels = await api("/api/channels");
  return store.channels;
}
export async function intros() {
  if (!store.introByUser) {
    const rows = await api("/api/collection?key=mentor_intro").catch(() => []);
    store.introByUser = new Map();
    for (const r of [...rows].reverse()) if (!store.introByUser.has(r.user_id)) store.introByUser.set(r.user_id, r);
  }
  return store.introByUser;
}

// ---------- names ----------
export const cleanName = (n, handle) =>
  String(n || "").replace(/\s*[\[(][^\])]{2,40}[\])]/g, "").replace(/\s{2,}/g, " ").trim() || handle || "Unknown";
export const nameOf = (p) => cleanName(p?.name, p?.handle);
export const firstName = (p) => nameOf(p).split(/\s+/)[0];
export const initials = (name) => {
  const w = cleanName(name).replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || "?") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
};
export const liSlug = (u) => String(u).replace(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in\/)?/i, "").replace(/\?.*$/, "").replace(/\/+$/, "");
export const liSearch = (p) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nameOf(p))}`;
export const shortChan = (c) => String(c || "").replace(/^#\d+-/, "#");
export const channelLabel = (n) => String(n || "").replace(/^#/, "");

// ---------- roles (the one place) ----------
export function roleOf(p) {
  if (!p) return { any: false };
  const r = new Set(p.roles || []);
  const judge = r.has("judge");
  const mentor = !!p.is_mentor && (r.has("mentor") || !judge);
  const tm = store.tmById.get(p.id);
  const teammate = !!tm && tm.shared_groups.length > 0;
  const seeking = !!tm && !teammate && tm.team_posts.length > 0;
  const likely = (!!p.likely_mentor || r.has("mentor?")) && !p.is_mentor;
  const o = { mentor, judge, sponsor: !!p.is_sponsor, organizer: !!p.is_organizer, teammate, seeking, likely, org: p.org || "" };
  o.any = mentor || judge || o.sponsor || o.organizer || teammate || seeking || likely;
  return o;
}
export function stripOf(p) {
  const r = roleOf(p);
  if ((r.mentor || r.judge) && r.sponsor) return "dual";
  if (r.mentor || r.judge) return "mentor";
  if (r.sponsor) return "sponsor";
  if (r.organizer) return "organizer";
  if (r.teammate || r.seeking) return "teammate";
  if (r.likely) return "likely";
  return "none";
}
// Ordered by priority: Mentor > Judge > Sponsor > Organizer > Teammate > Likely mentor.
export function chipsOf(p) {
  const r = roleOf(p), out = [];
  if (r.mentor) out.push({ kind: "mentor", label: "Mentor" });
  if (r.judge) out.push({ kind: "mentor", label: "Judge" });
  if (r.sponsor) out.push({ kind: "sponsor", label: r.org || "Sponsor", aria: `Sponsor: ${r.org || "unknown company"}` });
  if (r.organizer) out.push({ kind: "organizer", label: "Cal Hacks team" });
  if (r.teammate) out.push({ kind: "teammate", label: "Teammate" });
  if (r.seeking) out.push({ kind: "teammate", label: "Looking for team" });
  if (r.likely) out.push({ kind: "likely", label: "Likely mentor", tip: "Answered questions in a mentor channel. Not confirmed." });
  return out;
}
// "How you met": the first line that applies.
export function howMet(p) {
  const r = roleOf(p), tm = store.tmById.get(p.id);
  if (p.dm_count > 0) return `DMed ${p.dm_count}×`;
  if (tm?.shared_groups.length) return `In ${tm.shared_groups[0]} with you`;
  if (r.judge) return "Judged at Cal Hacks";
  if (r.sponsor && r.org) return `${r.org} booth`;
  if (r.mentor) { const c = p.channels?.find((c) => /mentor/.test(c)); return c ? `Mentor in ${shortChan(c)}` : "Mentor at Cal Hacks"; }
  if (r.organizer) return "Ran Cal Hacks 13.0";
  if (tm?.team_posts.length) return `Posted in ${shortChan(tm.team_posts[0].channel)}`;
  return p.channels?.[0] ? `Active in ${shortChan(p.channels[0])}` : "";
}
// Card subtitle: title → org → nothing (howMet covers the channel).
export const lineOf = (p) => [p.title && p.title.toLowerCase() !== "mentor" ? p.title : "", p.pronouns].filter(Boolean).join(" · ") || (p.org ? `${p.org}` : "");

// Palette / picker matcher: prefix > word-start > substring, then mentors and DMs.
export function matchPeople(q, limit = 6) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const p of store.people) {
    const name = nameOf(p).toLowerCase();
    const hay = `${name} ${(p.handle || "").toLowerCase()} ${(p.title || "").toLowerCase()} ${(p.org || "").toLowerCase()}`;
    let s = name.startsWith(q) ? 3 : new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay) ? 2 : hay.includes(q) ? 1 : 0;
    if (s) out.push([s + (p.is_mentor ? 0.5 : 0) + Math.min(p.dm_count, 20) / 100, p]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

// Recents (palette empty state)
export const recents = {
  get() { try { return JSON.parse(localStorage.getItem("lanyard.recent") || "[]"); } catch { return []; } },
  add(id) {
    try { localStorage.setItem("lanyard.recent", JSON.stringify([id, ...this.get().filter((x) => x !== id)].slice(0, 6))); } catch {}
  },
};
export const pref = {
  get(k, d) { try { return localStorage.getItem("lanyard." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lanyard." + k, v); } catch {} },
};

// ---------- companies (sponsor grouping) ----------
const UPPER = new Set(["ai", "yc", "mlh", "api", "crs", "si", "dev", "ibm", "aws"]);
export const titleCase = (s) => String(s).split(/[-_\s]+/).filter(Boolean)
  .map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ")
  .replace(/^Spacexsi$/i, "SpaceX SI").replace(/^A16z$/i, "a16z").replace(/ Dev$/, ".dev");
export const sponsorSlug = (ch) => String(ch || "").match(/^#?(?:spons|cohost|partner)[-_](.+)$/i)?.[1] || "";
// → { key, label, channel } for a collection row.
export function companyOf(r) {
  if (r.channel_type === "im" || r.channel_type === "mpim") return { key: "dm", label: "Private messages", channel: "" };
  if (r.author_is_sponsor && r.author_org) { const label = titleCase(r.author_org); return { key: label.toLowerCase(), label, channel: r.channel }; }
  const slug = sponsorSlug(r.channel);
  if (slug) { const label = titleCase(slug); return { key: label.toLowerCase(), label, channel: r.channel }; }
  return { key: r.channel, label: r.channel, channel: "" };
}
