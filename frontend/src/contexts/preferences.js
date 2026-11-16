// Per-browser preferences in localStorage (theme, layout, your name for drafts, recent people).
// Every access is wrapped: storage can throw in private windows or when site data is blocked,
// and the app must keep working with defaults.

const KEY_PREFIX = "lanyard.";
const RECENTS_KEY = "recent";
const MAX_RECENTS = 6;

/** String preferences with a default. Keys are stored as "lanyard.<key>". */
export const preferences = {
  /** @returns {string} the stored value, or `fallback` when missing or unreadable */
  get(key, fallback) {
    try { return localStorage.getItem(KEY_PREFIX + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(KEY_PREFIX + key, value); } catch { /* storage blocked: keep the in-memory default */ }
  },
};

/** Recently opened people (palette empty state), newest first. */
export const recentPeople = {
  /** @returns {string[]} person ids */
  get() {
    try { return JSON.parse(preferences.get(RECENTS_KEY, "[]")); } catch { return []; }
  },
  add(personId) {
    const next = [personId, ...this.get().filter((id) => id !== personId)].slice(0, MAX_RECENTS);
    preferences.set(RECENTS_KEY, JSON.stringify(next));
  },
};
