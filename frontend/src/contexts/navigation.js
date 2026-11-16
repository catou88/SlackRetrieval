// Navigation state shared by the router and pages: the current hash route and its query params,
// the route the user came from, and whether the next hashchange came from a link or navigateTo(),
// so the router scrolls to the top for links and restores the position for back/forward.

let isLinkNavigation = false;
let previousHash = null;

/** Navigate to `hash` as a link would (scroll to top on arrival). */
export function navigateTo(hash) {
  isLinkNavigation = true;
  location.hash = hash;
}

/** Mark the coming hashchange as link-driven (called from the app's click listener). */
export function markLinkNavigation() {
  isLinkNavigation = true;
}

/** Read and reset the link-navigation flag. */
export function consumeLinkNavigation() {
  const wasLink = isLinkNavigation;
  isLinkNavigation = false;
  return wasLink;
}

/** The hash the user was on before the current route ("" on first load). */
export function previousRoute() {
  return previousHash || "";
}

/** Record the route being left (the router calls this before rendering the next page). */
export function setPreviousRoute(hash) {
  previousHash = hash;
}

/** "#/people?f=a,b&q=x" → { path: ["people"], params: URLSearchParams }. */
export function parseHash(hash = location.hash) {
  const [pathPart, query = ""] = hash.replace(/^#\/?/, "").split("?");
  return { path: pathPart.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

/**
 * Write page UI state (filters, search text) into the hash without navigating: no hashchange
 * fires and focus stays put. Empty or null values remove the param.
 */
export function replaceHashParams(updates) {
  const { path, params } = parseHash();
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  history.replaceState(history.state, "", `#/${path.map(encodeURIComponent).join("/")}${query ? "?" + query : ""}`);
}
