// Hash router: maps "#/people/U123" style hashes to lazily loaded page modules, renders them into
// #view, and handles the cross-page chores (cleanup, scroll restore, focus, document title).
// Each page module exports renderPage(root, route) → optional cleanup fn, and pageTitle(route).
import { html } from "./utils/html.js";
import { findElement, setHTML, announce } from "./utils/dom.js";
import { isAbortError } from "./services/api.js";
import { parseHash, consumeLinkNavigation, setPreviousRoute } from "./contexts/navigation.js";
import { renderNavigation, closeAiStatusPopover } from "./components/appShell.js";
import { errorCard } from "./components/states.js";
import { finalizeClamps } from "./components/message.js";

const PAGE_LOADERS = {
  home: () => import("./pages/homePage.js"),
  people: () => import("./pages/peoplePage.js"),
  person: () => import("./pages/personPage.js"),
  opportunities: () => import("./pages/opportunitiesPage.js"),
  teammates: () => import("./pages/teammatesPage.js"),
  archive: () => import("./pages/archivePage.js"),
  ask: () => import("./pages/askPage.js"),
  winners: () => import("./pages/winnersPage.js"),
  project: () => import("./pages/projectPage.js"),
  jobs: () => import("./pages/jobsPage.js"),
  builders: () => import("./pages/buildersPage.js"),
  practice: () => import("./pages/practicePage.js"),
  askWinners: () => import("./pages/askWinnersPage.js"),
};
const SCROLL_KEY_PREFIX = "lanyard.scroll:";

let navigationToken = 0;
let cleanupCurrentPage = null;
let currentHash = null;

/**
 * Which page a hash shows. `nav` is the rail item to highlight; `id` is the person or channel id.
 * @returns {{name: string, nav: string, id?: string, params: URLSearchParams}}
 */
export function resolveRoute() {
  const { path, params } = parseHash();
  const [section, id] = path;
  if (section === "people" && id) return { name: "person", nav: "people", id, params };
  if (section === "winners" && id) return { name: "project", nav: "winners", id, params };
  if (section === "ask-winners") return { name: "askWinners", nav: "askWinners", params };
  if (section === "archive") return { name: "archive", nav: "archive", id, params };
  if (PAGE_LOADERS[section]) return { name: section, nav: section, params };
  return { name: "home", nav: "home", params };
}

/** Render the page for the current hash (call on load and on every hashchange). */
export async function showCurrentRoute() {
  const token = ++navigationToken;
  const leavingHash = currentHash;
  if (leavingHash != null) saveScrollPosition(leavingHash);
  currentHash = location.hash || "#/";
  setPreviousRoute(leavingHash);
  const route = resolveRoute();
  renderNavigation(route.nav);
  cleanupCurrentPage?.();
  cleanupCurrentPage = null;
  closeAiStatusPopover();
  const isFromLink = consumeLinkNavigation();
  const pageContainer = findElement("#view");
  try {
    const page = await PAGE_LOADERS[route.name]();
    // A newer navigation started while this page module was loading.
    if (token !== navigationToken) return;
    await renderPageInto(pageContainer, page, route);
  } catch (error) {
    if (isAbortError(error)) return;
    console.warn(error);
    setHTML(pageContainer, html`<div class="page">${errorCard(error)}</div>`);
  }
  finalizeClamps(pageContainer);
  restoreScroll(isFromLink, leavingHash);
  // Focus the h1 only on a real navigation (never on replaceState filter writes or first load).
  if (leavingHash != null) focusPageHeading(pageContainer);
}

// ---------- private helpers ----------

async function renderPageInto(pageContainer, page, route) {
  pageContainer.className = `view view--${route.name}`;
  // Fresh root per route so page-level listeners never accumulate.
  const pageRoot = document.createElement("div");
  pageRoot.className = "page";
  pageContainer.replaceChildren(pageRoot);
  cleanupCurrentPage = (await page.renderPage(pageRoot, route)) || null;
  const title = page.pageTitle?.(route) || route.nav[0].toUpperCase() + route.nav.slice(1);
  document.title = `${title} · Lanyard`;
}

function saveScrollPosition(hash) {
  try { sessionStorage.setItem(SCROLL_KEY_PREFIX + hash, String(scrollY)); } catch { /* storage blocked: back/forward starts at the top */ }
}

// Link navigation starts at the top; back/forward returns to where the user was.
function restoreScroll(isFromLink, leavingHash) {
  let top = 0;
  if (!isFromLink && leavingHash != null) {
    try { top = +sessionStorage.getItem(SCROLL_KEY_PREFIX + currentHash) || 0; } catch { /* storage blocked: start at the top */ }
  }
  requestAnimationFrame(() => scrollTo(0, top));
}

function focusPageHeading(pageContainer) {
  const heading = findElement("h1", pageContainer);
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  announce(heading.textContent);
}
