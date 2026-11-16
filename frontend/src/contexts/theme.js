// Theme preference: system → light → dark. index.html applies the stored theme before CSS loads
// (no flash); this module keeps the rail and topbar toggle buttons' icon and label in sync.
import { findElement, announce } from "../utils/dom.js";
import { preferences } from "./preferences.js";

const THEMES = ["system", "light", "dark"];
const THEME_ICONS = { system: "monitor", light: "sun", dark: "moon" };
const THEME_BUTTON_SELECTORS = ["#theme-btn", "#theme-btn-m"];
const THEME_PREFERENCE_KEY = "theme";

/** Apply a theme to the document and the rail/topbar buttons. */
export function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const label = `Theme: ${theme[0].toUpperCase() + theme.slice(1)}`;
  for (const selector of THEME_BUTTON_SELECTORS) {
    const button = findElement(selector);
    if (button) syncThemeButton(button, theme, label);
  }
}

/** The stored theme ("system" when unset). */
export function currentTheme() {
  return preferences.get(THEME_PREFERENCE_KEY, "system");
}

/** Advance to the next theme, persist it and announce it. */
export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  preferences.set(THEME_PREFERENCE_KEY, next);
  applyTheme(next);
  announce(`Theme: ${next}`);
}

// ---------- private helpers ----------

function syncThemeButton(button, theme, label) {
  button.querySelector("use").setAttribute("href", `#i-${THEME_ICONS[theme]}`);
  button.setAttribute("aria-label", label);
  const text = button.querySelector(".rail__label");
  if (text) text.textContent = label;
}
