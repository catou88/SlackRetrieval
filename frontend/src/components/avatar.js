// Person avatar: their saved Slack photo, or a monogram tinted by role (or by a stable hash of
// their id when they have no role). Broken images fall back to the monogram via main.js.
import { rawHtml, escapeHtml } from "../utils/html.js";
import { nameOf, cleanName, initials, roleStripOf } from "../utils/people.js";
import { teammateOf } from "../contexts/appState.js";

const HUES = ["stone", "indigo", "teal", "amber", "rose", "sky"];
// Role tints only where a single role is clear; mixed or guessed roles use a neutral hue.
const UNTINTED_STRIPS = new Set(["none", "likely", "dual"]);

/**
 * Avatar markup.
 * @param {object|null} person
 * @param {number} [size]  px (matches an .avatar--N class)
 * @param {string} [fallbackName]  for messages from people not in the people list
 */
export function personAvatar(person, size = 40, fallbackName) {
  const name = person ? nameOf(person) : cleanName(fallbackName);
  const strip = person ? roleStripOf(person, teammateOf(person.id)) : "none";
  const hueClass = UNTINTED_STRIPS.has(strip) ? `hue-${HUES[stableHash(person?.id || name) % HUES.length]}` : `role-${strip}`;
  const monogram = escapeHtml(initials(name));
  if (!person?.has_avatar) return rawHtml(`<span class="avatar avatar--${size} ${hueClass}" aria-hidden="true">${monogram}</span>`);
  return rawHtml(`<span class="avatar avatar--${size} ${hueClass}" aria-hidden="true" data-i="${monogram}"><img src="/avatars/${escapeHtml(person.id)}.jpg" width="${size}" height="${size}" loading="lazy" decoding="async" alt=""></span>`);
}

/** Replace a broken avatar image with its monogram (main.js listens for image errors). */
export function fallbackToMonogram(image) {
  const holder = image.parentElement;
  if (image.tagName === "IMG" && holder?.classList.contains("avatar")) holder.textContent = holder.dataset.i || "?";
}

// ---------- private helpers ----------

function stableHash(text) {
  return [...String(text)].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
}
