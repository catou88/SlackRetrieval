// Small DOM helpers: element lookup, markup insertion, debouncing and screen-reader announcements.

/** First element matching `selector` under `root` (querySelector). */
export function findElement(selector, root = document) {
  return root.querySelector(selector);
}

/** Every element matching `selector` under `root`, as an array. */
export function findAllElements(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/** Replace an element's content with html`` output. */
export function setHTML(element, markup) {
  element.innerHTML = String(markup);
  return element;
}

/** Trailing-edge debounce with a cancel() method. */
export function debounce(callback, waitMs) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), waitMs);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Speak a short message through the global polite live region. */
export function announce(message) {
  const region = document.getElementById("announcer");
  if (!region) return;
  // Clearing first makes screen readers repeat identical consecutive messages.
  region.textContent = "";
  requestAnimationFrame(() => (region.textContent = message));
}
