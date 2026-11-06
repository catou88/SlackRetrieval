// Escaping tagged template + formatting helpers. Every interpolation is escaped
// unless it is wrapped in raw() or is itself the result of html``.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ""));
const val = (v) =>
  v == null || v === false ? "" : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join("") : esc(v);
export const html = (strings, ...vals) =>
  raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? val(vals[i]) : ""), ""));

export const icon = (name, cls = "i") => raw(`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);
export const NEWTAB = raw(`<span class="sr"> (opens in new tab)</span>`);

// ---------- Intl formatting ----------
const nf = new Intl.NumberFormat("en-US");
export const num = (n) => nf.format(n || 0);
const NOW_YEAR = new Date().getFullYear();
const dShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dLong = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });
const tShort = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const toDate = (d) => (d instanceof Date ? d : typeof d === "string" && /^\d+(\.\d+)?$/.test(d) ? new Date(+d * 1000) : new Date(d));
export const date = (d) => {
  if (!d) return "";
  const x = toDate(d);
  if (isNaN(x)) return "";
  return (x.getFullYear() === NOW_YEAR ? dShort : dLong).format(x);
};
export const dayLabel = (d) => dDay.format(toDate(d));
export const time = (d) => tShort.format(toDate(d));
export const dayKey = (d) => { const x = toDate(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };
// ISO date "2026-11-20" (local) → "Nov 20"
export const isoDate = (s) => (s ? date(new Date(s + "T12:00:00")) : "");
export const ago = (d) => {
  const s = Math.round((Date.now() - toDate(d)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return date(d);
};
export const plural = (n, one, many = one + "s") => `${num(n)} ${n === 1 ? one : many}`;

// ---------- DOM helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const setHTML = (el, h) => { el.innerHTML = String(h); return el; };
export const frag = (h) => document.createRange().createContextualFragment(String(h));
export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export const announce = (msg) => {
  const a = document.getElementById("announcer");
  a.textContent = "";
  requestAnimationFrame(() => (a.textContent = msg));
};

// Hash params: "#/people?f=a,b&q=x" → { path: ["people"], params: URLSearchParams }
export function parseHash(h = location.hash) {
  const s = h.replace(/^#\/?/, "");
  const [p, q = ""] = s.split("?");
  return { path: p.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(q) };
}
// Write UI state into the hash without a navigation (no hashchange, no focus move).
export function replaceParams(obj) {
  const { path, params } = parseHash();
  for (const [k, v] of Object.entries(obj)) (v == null || v === "" ? params.delete(k) : params.set(k, v));
  const qs = params.toString();
  history.replaceState(history.state, "", `#/${path.map(encodeURIComponent).join("/")}${qs ? "?" + qs : ""}`);
}

// ---------- Downloads / clipboard ----------
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); return ok;
  }
}
