// Behaviour for every [data-copy] button: copy its value, announce it, and briefly show "Copied"
// on the button's .btn__label (or tell the user to press Ctrl+C when the clipboard is blocked).
import { announce } from "../utils/dom.js";
import { copyText } from "../services/clipboard.js";

const COPIED_FEEDBACK_MS = 1500;

/** Copy a [data-copy] button's value with visible and spoken feedback. */
export async function handleCopyButton(button) {
  const isCopied = await copyText(button.dataset.copy);
  const label = button.querySelector(".btn__label");
  if (!isCopied) {
    announce("Press Ctrl+C to copy");
    if (label) label.textContent = "Press Ctrl+C";
    return;
  }
  announce(button.dataset.copyMsg || "Copied");
  button.classList.add("is-copied");
  if (label) {
    label.dataset.was ??= label.textContent;
    label.textContent = "Copied";
  }
  setTimeout(() => {
    button.classList.remove("is-copied");
    if (label) label.textContent = label.dataset.was;
  }, COPIED_FEEDBACK_MS);
}
