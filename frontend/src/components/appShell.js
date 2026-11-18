// The app shell around every page: the side rail and phone tab bar (with live counts), and the
// "AI on/off" status pill with its explanatory popover.
import { html, icon } from "../utils/html.js";
import { findElement, setHTML } from "../utils/dom.js";
import { formatNumber } from "../utils/format.js";
import { store } from "../contexts/appState.js";

const NAV_ITEMS = [
  { id: "home", href: "#/", label: "Home", icon: "home" },
  { id: "people", href: "#/people", label: "People", icon: "users", count: () => store.people.length },
  { id: "opportunities", href: "#/opportunities", label: "Opportunities", short: "Opps", icon: "briefcase", count: () => store.opportunityCount },
  { id: "teammates", href: "#/teammates", label: "Teammates", short: "Team", icon: "handshake", count: () => store.teammates.length },
  { id: "winners", href: "#/winners", label: "Winners", icon: "sparkles" },
  { id: "archive", href: "#/archive", label: "Archive", icon: "archive" },
  // Ask lives in the topbar on phones, so the tab bar skips it.
  { id: "ask", href: "#/ask", label: "Ask", icon: "sparkles", isRailOnly: true },
];

/** Draw the rail and tab bar with `activeId` marked as the current page. */
export function renderNavigation(activeId) {
  setHTML(findElement("#rail-nav"), html`${NAV_ITEMS.map((item) => renderRailItem(item, activeId))}`);
  setHTML(findElement("#tabbar"), html`${NAV_ITEMS.filter((item) => !item.isRailOnly).map((item) => renderTabItem(item, activeId))}`);
}

/** Wire the AI status pill: click toggles the popover, clicking elsewhere closes it. */
export function wireAiStatusPopover() {
  const popover = findElement("#ai-pop");
  const pill = findElement("#ai-pill");
  pill.addEventListener("click", () => {
    const willOpen = popover.hidden;
    popover.hidden = !willOpen;
    pill.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) popover.focus?.();
  });
  document.addEventListener("click", (event) => {
    if (!popover.hidden && !event.target.closest("#ai-pop, #ai-pill")) closeAiStatusPopover();
  });
}

/** Is the AI status popover showing? */
export function isAiStatusPopoverOpen() {
  return !findElement("#ai-pop").hidden;
}

/** Hide the AI status popover (on navigation, Esc, or a click elsewhere). */
export function closeAiStatusPopover() {
  findElement("#ai-pop").hidden = true;
  findElement("#ai-pill").setAttribute("aria-expanded", "false");
}

/** Show whether Claude features are available, from /api/stats. */
export function renderAiStatus(isClaudeOn) {
  findElement("#ai-pill").classList.toggle("is-on", isClaudeOn);
  findElement("#ai-label").textContent = isClaudeOn ? "AI on" : "AI off";
  setHTML(findElement("#ai-pop"), isClaudeOn
    ? html`<p><b>Claude is connected.</b> Reconnect briefs and Ask use your API key. Message search and everything else run on this computer.</p>`
    : html`<p><b>AI is off.</b> Reconnect briefs and Ask need a Claude API key. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart. Everything else works offline.</p>`);
}

// ---------- private helpers ----------

function currentPageAttribute(item, activeId) {
  return item.id === activeId ? html`aria-current="page"` : "";
}

function renderRailItem(item, activeId) {
  const count = item.count?.();
  return html`<li><a class="rail__item" href="${item.href}" data-tip-rail="${item.label}" aria-label="${item.label}" ${currentPageAttribute(item, activeId)}>
      ${icon(item.icon)}<span class="rail__label">${item.label}</span>${count ? html`<span class="rail__count">${formatNumber(count)}</span>` : ""}</a></li>`;
}

function renderTabItem(item, activeId) {
  return html`<a href="${item.href}" ${currentPageAttribute(item, activeId)}>${icon(item.icon)}<span>${item.short || item.label}</span></a>`;
}
