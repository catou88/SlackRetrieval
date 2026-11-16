// Safe HTML building: the escaping html`` tagged template, trusted-markup wrapper and sprite icons.
// Every html`` interpolation is escaped unless it is wrapped in rawHtml() or is itself an html``
// result, so markup built from archive text can never inject elements.

// Declared before the constants because NEW_TAB_NOTICE is built from it at import time.
class RawHtml {
  constructor(markup) { this.markup = markup; }
  toString() { return this.markup; }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Screen-reader suffix for links that open a new tab. */
export const NEW_TAB_NOTICE = new RawHtml(`<span class="sr"> (opens in new tab)</span>`);

/** Escape a value for HTML text or attribute context. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Mark a string as trusted HTML (only for markup this app produced). */
export function rawHtml(markup) {
  return new RawHtml(String(markup ?? ""));
}

/** Tagged template that escapes every interpolation; arrays are joined, null/false render nothing. */
export function html(strings, ...values) {
  return rawHtml(strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? interpolate(values[i]) : ""), ""));
}

/** Inline SVG icon from the sprite in index.html. */
export function icon(name, className = "i") {
  return rawHtml(`<svg class="${escapeHtml(className)}" aria-hidden="true"><use href="#i-${escapeHtml(name)}"/></svg>`);
}

// ---------- private helpers ----------

function interpolate(value) {
  if (value == null || value === false) return "";
  if (value instanceof RawHtml) return value.markup;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHtml(value);
}
