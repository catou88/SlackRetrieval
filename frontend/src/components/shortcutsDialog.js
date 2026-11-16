// The keyboard shortcuts list ("?") and the app-wide keydown handler that implements them.
// Page-specific keys (L, C, X on a person) are forwarded to the page as a "viewkey" event.
import { html } from "../utils/html.js";
import { openDialog } from "./dialog.js";
import { openPalette } from "./commandPalette.js";
import { isAiStatusPopoverOpen, closeAiStatusPopover } from "./appShell.js";

const SHORTCUTS = [
  ["Ctrl K or /", "Search people, channels, messages"],
  ["Esc", "Close a dialog · go back from a person"],
  ["?", "Show this list"],
  ["L", "On a person: open LinkedIn"],
  ["C", "On a person: copy LinkedIn link"],
  ["X", "On a person: toggle contacted"],
];

/** Show the shortcuts dialog. @param {HTMLElement} [opener] focus returns here */
export function openShortcutsDialog(opener) {
  openDialog({ label: "Keyboard shortcuts", opener, cls: "dlg--sm", body: html`<h2 class="dlg__title">Keyboard shortcuts</h2>
    <dl class="keys">${SHORTCUTS.map(([keys, description]) => html`<div><dt>${renderKeys(keys)}</dt><dd>${description}</dd></div>`)}</dl>` });
}

/**
 * App-wide keydown handler.
 * @param {KeyboardEvent} event
 * @param {HTMLElement} pageContainer  #view; its current page root receives "viewkey" events
 */
export function handleGlobalKeydown(event, pageContainer) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette(document.activeElement);
    return;
  }
  // An open dialog owns the keyboard; single-letter shortcuts must not fire while typing.
  if (document.querySelector(".dlg-scrim")) return;
  if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "/") {
    event.preventDefault();
    openPalette(document.activeElement);
  } else if (event.key === "?") {
    event.preventDefault();
    openShortcutsDialog(document.activeElement);
  } else if (event.key === "Escape" && isAiStatusPopoverOpen()) {
    closeAiStatusPopover();
  } else {
    pageContainer.firstElementChild?.dispatchEvent(new CustomEvent("viewkey", { detail: event }));
  }
}

// ---------- private helpers ----------

// "Ctrl K or /" → <kbd>Ctrl</kbd><kbd>K</kbd> or <kbd>/</kbd>
function renderKeys(keys) {
  return keys.split(" or ").map((combo, i) => html`${i ? " or " : ""}${combo.split(" ").map((key) => html`<kbd>${key}</kbd>`)}`);
}

function isTypingTarget(element) {
  return element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}
