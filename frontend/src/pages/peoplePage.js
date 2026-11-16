// People: list (default) or badge grid with client-side role/attribute filters, sort, search and
// export. Filter, sort, search and layout live in the hash so the view survives reloads.
import { html, icon } from "../utils/html.js";
import { formatNumber, pluralize } from "../utils/format.js";
import { findElement, setHTML, debounce } from "../utils/dom.js";
import { nameOf, linkedInSlug, subtitleOf, howYouMet } from "../utils/people.js";
import { noteStatusOf } from "../utils/noteStatus.js";
import { exportPeople } from "../services/contactExport.js";
import { store, teammateOf, offerCountOf } from "../contexts/appState.js";
import { preferences } from "../contexts/preferences.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { personAvatar } from "../components/avatar.js";
import { roleChips, offerChip } from "../components/chips.js";
import { nameTagBadge } from "../components/personCards.js";
import { emptyState } from "../components/states.js";

const ROLE_FILTERS = [
  { id: "mentors", label: "Mentors & judges", test: (person) => person.is_mentor, color: "var(--mentor)" },
  { id: "sponsors", label: "Sponsors", test: (person) => person.is_sponsor, color: "var(--sponsor)" },
  { id: "organizers", label: "Organizers", test: (person) => person.is_organizer, color: "var(--organizer)" },
  { id: "likely", label: "Likely mentors", test: (person) => (person.likely_mentor || person.roles.includes("mentor?")) && !person.is_mentor, color: "transparent" },
];
const ATTRIBUTE_FILTERS = [
  { id: "offered", label: "Offered help", phrase: "offered help", test: (person) => offerCountOf(person) > 0 },
  { id: "linkedin", label: "Has LinkedIn", phrase: "with LinkedIn", test: (person) => person.linkedin.length > 0 },
  { id: "contacted", label: "Contacted", phrase: "contacted", test: (person) => noteStatusOf(person).contacted },
  { id: "due", label: "Follow-up due", phrase: "follow-up due", test: (person) => noteStatusOf(person).due },
];
const SORTS = {
  talked: { label: "Most talked-to", compare: (a, b) => b.dm_count - a.dm_count || b.message_count - a.message_count },
  offered: { label: "Offered help first", compare: (a, b) => offerCountOf(b) - offerCountOf(a) || b.is_mentor - a.is_mentor || b.message_count - a.message_count },
  name: { label: "Name A–Z", compare: (a, b) => nameOf(a).localeCompare(nameOf(b)) },
  recent: { label: "Recently active", compare: (a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")) },
};
const DEFAULT_SORT = "talked";
const LAYOUT_PREFERENCE = "peopleView";
const GRID_BATCH_SIZE = 60;
const LIST_BATCH_SIZE = 100;
const SEARCH_DELAY_MS = 120;
// Start rendering the next batch well before the user reaches the end of the list.
const INFINITE_SCROLL_MARGIN = "600px";

/** Document title for People. */
export function pageTitle() {
  return "People";
}

/** Render People into `root`. @returns {() => void} cleanup that stops infinite scrolling */
export async function renderPage(root, { params }) {
  const view = {
    root,
    filters: new Set((params.get("f") || "").split(",").filter(Boolean)),
    query: params.get("q") || "",
    sort: SORTS[params.get("sort")] ? params.get("sort") : DEFAULT_SORT,
    layout: params.get("view") || preferences.get(LAYOUT_PREFERENCE, "list"),
    rows: [],
    shownCount: 0,
    scrollObserver: null,
  };
  setHTML(root, renderPeopleShell(view));
  view.results = findElement("#presults", root);
  view.countLine = findElement("#pcount", root);
  wirePeopleEvents(view);
  drawResults(view);
  return () => view.scrollObserver?.disconnect();
}

// ---------- private helpers ----------

function renderPeopleShell(view) {
  const counts = Object.fromEntries([...ROLE_FILTERS, ...ATTRIBUTE_FILTERS].map((filter) => [filter.id, store.people.filter(filter.test).length]));
  return html`
    <header class="page-head"><h1 class="title">People</h1>
      <p class="lede">Everyone who posted or DMed in the workspace. Mentors, judges and sponsor reps are tagged from their name tags and intros.</p></header>
    <div class="toolbar">
      <label class="field">${icon("search")}<span class="sr">Search people</span><input class="input" id="pq" type="search" placeholder="Search name, title, company, handle" value="${view.query}" autocomplete="off"></label>
      <div class="toolbar__end">
        <label class="sr" for="psort">Sort</label>
        <select class="select" id="psort">${Object.entries(SORTS).map(([key, sort]) => html`<option value="${key}" ${key === view.sort ? "selected" : ""}>${sort.label}</option>`)}</select>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" data-mode="list" aria-pressed="${view.layout === "list"}" aria-label="List">${icon("list")}</button>
          <button type="button" data-mode="grid" aria-pressed="${view.layout === "grid"}" aria-label="Badges">${icon("grid")}</button>
        </div>
        <details class="menu"><summary class="btn btn--secondary">${icon("download")}Export</summary>
          <div class="menu__pop" role="group" aria-label="Export"><p class="menu__head" id="xcount"></p>
            <button class="menu__item" type="button" data-export="csv">CSV spreadsheet</button>
            <button class="menu__item" type="button" data-export="vcf">vCard contacts</button></div></details>
      </div>
    </div>
    <div class="fchips" role="group" aria-label="Filters">
      <button class="fchip" type="button" data-f="" aria-pressed="false">All</button>
      ${ROLE_FILTERS.map((filter) => html`<button class="fchip" type="button" data-f="${filter.id}" aria-pressed="false"><span class="fchip__dot${filter.id === "likely" ? " fchip__dot--likely" : ""}" style="background:${filter.color}"></span>${filter.label}<span class="num">${formatNumber(counts[filter.id])}</span></button>`)}
      <span class="fsep" aria-hidden="true"></span>
      ${ATTRIBUTE_FILTERS.map((filter) => html`<button class="fchip" type="button" data-f="${filter.id}" aria-pressed="false">${filter.label}<span class="num">${formatNumber(counts[filter.id])}</span></button>`)}
    </div>
    <p class="meta-line people-count" id="pcount" aria-live="polite"></p>
    <div id="presults"></div>`;
}

function wirePeopleEvents(view) {
  const { root } = view;
  const saveToHash = () => replaceHashParams({ f: [...view.filters].join(","), q: view.query.trim(), sort: view.sort === DEFAULT_SORT ? "" : view.sort, view: view.layout });
  const redraw = () => {
    saveToHash();
    drawResults(view);
  };
  const searchAfterTyping = debounce(redraw, SEARCH_DELAY_MS);
  root.addEventListener("input", (event) => {
    if (event.target.id !== "pq") return;
    view.query = event.target.value;
    searchAfterTyping();
  });
  root.addEventListener("change", (event) => {
    if (event.target.id !== "psort") return;
    view.sort = event.target.value;
    redraw();
  });
  root.addEventListener("click", (event) => handlePeopleClick(event, view, redraw));
  // The export menu is a <details>; close it on any click outside, and stop listening once the page is gone.
  document.addEventListener("click", function closeExportMenu(event) {
    if (!root.isConnected) return document.removeEventListener("click", closeExportMenu);
    const openMenu = root.querySelector("details.menu[open]");
    if (openMenu && !openMenu.contains(event.target)) openMenu.open = false;
  });
}

function handlePeopleClick(event, view, redraw) {
  const filterButton = event.target.closest("[data-f]");
  if (filterButton) {
    toggleFilter(view.filters, filterButton.dataset.f);
    redraw();
    return;
  }
  const layoutButton = event.target.closest("[data-mode]");
  if (layoutButton) {
    view.layout = layoutButton.dataset.mode;
    preferences.set(LAYOUT_PREFERENCE, view.layout);
    redraw();
    return;
  }
  if (event.target.closest("[data-more]")) appendNextBatch(view);
  if (event.target.closest("[data-clear]")) {
    view.filters.clear();
    view.query = "";
    findElement("#pq", view.root).value = "";
    redraw();
  }
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) {
    const label = [...view.filters].join("-") || (view.query ? "search" : "all");
    exportPeople(view.rows, exportButton.dataset.export, label);
    exportButton.closest("details").open = false;
  }
}

// "All" (empty id) clears every filter; any other chip toggles itself.
function toggleFilter(filters, filterId) {
  if (!filterId) filters.clear();
  else if (filters.has(filterId)) filters.delete(filterId);
  else filters.add(filterId);
}

function applyFiltersAndSort(view) {
  const activeRoles = ROLE_FILTERS.filter((filter) => view.filters.has(filter.id));
  const activeAttributes = ATTRIBUTE_FILTERS.filter((filter) => view.filters.has(filter.id));
  const needle = view.query.trim().toLowerCase();
  // Roles widen (any of them); attributes narrow (all of them).
  view.rows = store.people.filter((person) =>
    (!activeRoles.length || activeRoles.some((filter) => filter.test(person))) &&
    activeAttributes.every((filter) => filter.test(person)) &&
    (!needle || `${nameOf(person)} ${person.name} ${person.handle} ${person.title} ${person.org}`.toLowerCase().includes(needle)));
  view.rows.sort(SORTS[view.sort].compare);
  renderCountLine(view, activeRoles, activeAttributes, needle);
}

function renderCountLine(view, activeRoles, activeAttributes, needle) {
  const descriptions = [activeRoles.map((filter) => filter.label).join(" or "), activeAttributes.map((filter) => filter.phrase).join(" · ")].filter(Boolean);
  setHTML(view.countLine, html`<span>${pluralize(view.rows.length, "person", "people")}</span>${descriptions.map((description) => html`<span class="sep">·</span><span>${description}</span>`)}${needle ? html`<span class="sep">·</span><span>matching “${view.query.trim()}”</span>` : ""}`);
  findElement("#xcount", view.root).textContent = `${pluralize(view.rows.length, "person", "people")} in this view`;
}

function drawResults(view) {
  const { root, results } = view;
  view.scrollObserver?.disconnect();
  for (const button of root.querySelectorAll("[data-f]")) button.setAttribute("aria-pressed", String(button.dataset.f ? view.filters.has(button.dataset.f) : !view.filters.size));
  for (const button of root.querySelectorAll("[data-mode]")) button.setAttribute("aria-pressed", String(button.dataset.mode === view.layout));
  applyFiltersAndSort(view);
  view.shownCount = 0;
  if (!view.rows.length) {
    setHTML(results, noResultsState(view));
    return;
  }
  setHTML(results, view.layout === "grid" ? html`<div class="badges" id="pitems"></div>` : html`<ul class="plist card" role="list" id="pitems"></ul>`);
  results.insertAdjacentHTML("beforeend", `<div class="showmore"><button class="btn btn--secondary" type="button" data-more>Show more</button></div>`);
  appendNextBatch(view);
  view.scrollObserver = new IntersectionObserver((entries) => entries[0].isIntersecting && appendNextBatch(view), { rootMargin: INFINITE_SCROLL_MARGIN });
  view.scrollObserver.observe(results.querySelector(".showmore"));
}

function noResultsState(view) {
  const onlyFilter = view.filters.size === 1 && !view.query ? [...view.filters][0] : "";
  if (onlyFilter === "offered") {
    return emptyState({ icon: "handshake", title: "No offers found yet", body: "Offers and LinkedIn shares come from npm run categorize. Run it after a sync." });
  }
  if (onlyFilter === "contacted") {
    return emptyState({ icon: "check", title: "You haven't marked anyone as contacted yet", body: "Open a person and press Mark contacted." });
  }
  return emptyState({
    icon: "search",
    title: view.query ? `No one matches “${view.query.trim()}”` : "No one matches these filters",
    actions: html`<button class="btn btn--secondary" type="button" data-clear>Clear search and filters</button>`,
  });
}

function appendNextBatch(view) {
  const isGrid = view.layout === "grid";
  const batch = view.rows.slice(view.shownCount, view.shownCount + (isGrid ? GRID_BATCH_SIZE : LIST_BATCH_SIZE));
  view.shownCount += batch.length;
  const markup = html`${batch.map((person) => (isGrid ? nameTagBadge(person, { offers: offerCountOf(person) }) : renderListRow(person)))}`;
  findElement("#pitems", view.results).insertAdjacentHTML("beforeend", String(markup));
  const showMore = view.results.querySelector(".showmore");
  if (showMore) showMore.hidden = view.shownCount >= view.rows.length;
}

function renderListRow(person) {
  const status = noteStatusOf(person);
  const offerCount = offerCountOf(person);
  return html`<li class="prow">
    ${personAvatar(person, 40)}
    <div class="prow__id"><span class="prow__name"><a href="#/people/${person.id}">${nameOf(person)}</a>${roleChips(person)}${offerCount ? offerChip(offerCount) : ""}</span>
      <span class="prow__line">${subtitleOf(person) || howYouMet(person, teammateOf(person.id))}</span></div>
    <div class="prow__li">${renderLinkedInCell(person)}</div>
    <div class="prow__status">${renderStatusIcons(status)}</div>
    <div class="prow__counts num">${formatNumber(person.message_count)} msgs${person.dm_count ? html`<br>${formatNumber(person.dm_count)} DMs` : ""}</div>
  </li>`;
}

function renderLinkedInCell(person) {
  const url = person.linkedin[0];
  if (!url) return html`<span class="faint small">No LinkedIn</span>`;
  return html`<a class="mono" href="${url}" target="_blank" rel="noreferrer" aria-label="Open ${nameOf(person)}'s LinkedIn">in/${linkedInSlug(url)}</a>
      <button class="btn btn--icon btn--ghost btn--sm" type="button" data-copy="${url}" data-copy-msg="Copied LinkedIn link" aria-label="Copy ${nameOf(person)}'s LinkedIn link">${icon("copy")}</button>`;
}

function renderStatusIcons(status) {
  const contactedIcon = status.contacted ? html`<span class="ok-ico" role="img" aria-label="Contacted" data-tip="Contacted">${icon("check")}</span>` : "";
  const followUpClass = status.due ? "due-ico" : "faint";
  const followUpIcon = status.followUp
    ? html`<span class="${followUpClass}" role="img" aria-label="Follow up ${status.followUp}" data-tip="Follow up ${status.followUp}">${icon("calendar")}</span>`
    : "";
  return html`${contactedIcon}
      ${followUpIcon}`;
}
