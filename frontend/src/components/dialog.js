// Modal dialog: focus trap, inert background, Esc and backdrop to close, focus return to the opener.
import { html, icon } from "../utils/html.js";
import { findElement, findAllElements, setHTML } from "../utils/dom.js";

const FOCUSABLE_SELECTOR = "a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex='-1'])";

/**
 * Open a modal dialog in #overlay-root.
 * @param {{label: string, opener?: HTMLElement, body: any, cls?: string, onClose?: () => void}} options
 *   body is html``; cls adds a size/variant class to the .dlg element
 * @returns {{dlg: HTMLElement, close: () => void}}
 */
export function openDialog({ label, opener, body, cls = "", onClose }) {
  const overlayRoot = findElement("#overlay-root");
  const scrim = document.createElement("div");
  scrim.className = "dlg-scrim";
  setHTML(scrim, html`<div class="dlg ${cls}" role="dialog" aria-modal="true" aria-label="${label}">
    <button class="btn btn--icon btn--ghost dlg__close" type="button" aria-label="Close">${icon("x")}</button>${body}</div>`);
  overlayRoot.append(scrim);
  setBackgroundInert(true);
  const dialog = scrim.firstElementChild;
  const close = () => {
    scrim.remove();
    // Dialogs can stack (palette → shortcuts); only the last one closing frees the page.
    if (!overlayRoot.children.length) setBackgroundInert(false);
    onClose?.();
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
  };
  scrim.addEventListener("mousedown", (event) => event.target === scrim && close());
  dialog.querySelector(".dlg__close").addEventListener("click", close);
  dialog.addEventListener("keydown", (event) => handleDialogKeydown(event, dialog, close));
  requestAnimationFrame(() => (dialog.querySelector("[autofocus]") || dialog.querySelector(".dlg__close")).focus());
  return { dlg: dialog, close };
}

// ---------- private helpers ----------

function setBackgroundInert(isInert) {
  for (const element of [findElement(".shell"), findElement(".skip")]) element.inert = isInert;
}

function handleDialogKeydown(event, dialog, close) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  if (event.key === "Tab") trapFocus(event, dialog);
}

// Tab from the last focusable element wraps to the first, Shift+Tab from the first to the last.
function trapFocus(event, dialog) {
  const focusable = findAllElements(FOCUSABLE_SELECTOR, dialog).filter((element) => element.offsetParent);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
