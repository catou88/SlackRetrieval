// Opportunities: sponsor posts grouped into company "booths" (reps hang on a lanyard cord), plus
// offers of help. Intent chips filter client-side; the text filter is server-side.
import { html, rawHtml, icon, NEW_TAB_NOTICE } from "../utils/html.js";
import { formatNumber, formatDate, pluralize } from "../utils/format.js";
import { findElement, setHTML, debounce } from "../utils/dom.js";
import { nameOf, cleanName, companyOf } from "../utils/people.js";
import { splitMessageExtras, findLinkUrls, shortenUrl } from "../utils/slackFormat.js";
import { getJson, createRequestSlot, isAbortError } from "../services/api.js";
import { store, loadChannels } from "../contexts/appState.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { personAvatar } from "../components/avatar.js";
import { roleChips } from "../components/chips.js";
import { emptyState, commandSnippet, errorCard } from "../components/states.js";
import { finalizeClamps, archiveLinkFor } from "../components/message.js";
import { renderSlackText } from "../components/slackText.js";

const INTENTS = [
  { id: "jobs", label: "Jobs", pattern: /\b(intern(ship)?s?|hiring|roles?|apply|applications?|careers?|full[- ]time|new grad|recruit\w*|positions?)\b/i },
  { id: "events", label: "Events", pattern: /\b(events?|rsvp|meetups?|happy hour|workshops?|dinner|talks?|panel|webinar)\b|lu\.ma|luma\.com|partiful/i },
  { id: "forms", label: "Forms & links", pattern: /forms\.gle|docs\.google|typeform|airtable|tally\.so|\bform\b/i },
  { id: "perks", label: "Perks", pattern: /\b(credits?|promo|code|coupon|free tier|discount|swag|merch|api keys?)\b/i },
];
const OFFERS_PAGE_SIZE = 20;
const BOOTH_INITIAL_POSTS = 4;
const BOOTH_FOCUSED_POSTS = 24;
const BOOTH_PAGE_SIZE = 20;
const MAX_CORD_REPS = 7;
const MAX_POST_LINKS = 3;
// The server caps collection responses at this many rows.
const SERVER_ROW_CAP = 500;
const FILTER_DELAY_MS = 250;
// Wait for the router's own scroll reset before jumping to a focused company.
const FOCUS_SCROLL_DELAY_MS = 60;

/** Document title for Opportunities. */
export function pageTitle() {
  return "Opportunities";
}

/** Render Opportunities into `root`. */
export async function renderPage(root, { params }) {
  const focusedCompany = params.get("co");
  const counts = Object.fromEntries((store.collections || (await getJson("/api/collections"))).map((collection) => [collection.key, collection.messages]));
  const channels = await loadChannels().catch(() => []);
  const view = {
    root,
    tab: params.get("tab") === "offers" ? "offers" : "sponsors",
    query: params.get("q") || "",
    intents: new Set((params.get("i") || "").split(",").filter(Boolean)),
    postsShownByCompany: new Map(focusedCompany ? [[focusedCompany, BOOTH_FOCUSED_POSTS]] : []),
    offersShown: OFFERS_PAGE_SIZE,
    rows: [],
    channelIdByName: Object.fromEntries(channels.map((channel) => [channel.name, channel.id])),
    fetchRows: createRequestSlot(),
  };
  setHTML(root, renderOpportunitiesShell(view, counts));
  view.panel = findElement("#opp-panel", root);
  wireOpportunityEvents(view);
  await loadRows(view);
  if (focusedCompany) {
    setTimeout(() => document.getElementById(`co-${encodeURIComponent(focusedCompany)}`)?.scrollIntoView({ block: "start" }), FOCUS_SCROLL_DELAY_MS);
  }
}

// ---------- private helpers ----------

function renderOpportunitiesShell(view, counts) {
  return html`
    <header class="page-head"><h1 class="title">Opportunities</h1>
      <p class="lede">Jobs, events and offers people shared during the hackathon. Sponsor posts are grouped by company, so you know who to contact.</p></header>
    <div class="opp-bar">
      <div class="tabs" role="tablist" aria-label="Opportunities">
        <button class="tab" role="tab" id="t-sp" data-tab="sponsors" aria-controls="opp-panel">From sponsors <span class="num">${formatNumber(counts.sponsor_opportunity)}</span></button>
        <button class="tab" role="tab" id="t-of" data-tab="offers" aria-controls="opp-panel">Offers of help <span class="num">${formatNumber(counts.offer)}</span></button>
      </div>
      <label class="field opp-filter">${icon("search")}<span class="sr">Filter posts</span><input class="input" id="oq" type="search" placeholder="Filter by words, company or person" value="${view.query}" autocomplete="off"></label>
    </div>
    <div class="fchips intents" role="group" aria-label="Kind of post" id="intents"></div>
    <div id="opp-panel" role="tabpanel"></div>`;
}

function wireOpportunityEvents(view) {
  const { root } = view;
  const saveToHash = () => replaceHashParams({ tab: view.tab === "sponsors" ? "" : view.tab, q: view.query, i: [...view.intents].join(","), co: "" });
  const filterAfterTyping = debounce(() => {
    saveToHash();
    loadRows(view);
  }, FILTER_DELAY_MS);
  root.addEventListener("input", (event) => {
    if (event.target.id !== "oq") return;
    view.query = event.target.value.trim();
    filterAfterTyping();
  });
  root.addEventListener("click", (event) => handleOpportunityClick(event, view, saveToHash));
  // Left/Right on a tab switches to the other tab, as the ARIA tabs pattern expects.
  root.addEventListener("keydown", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    const otherTab = root.querySelector(`[role=tab]:not([data-tab="${tab.dataset.tab}"])`);
    otherTab.focus();
    otherTab.click();
  });
}

function handleOpportunityClick(event, view, saveToHash) {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton && tabButton.dataset.tab !== view.tab) {
    view.tab = tabButton.dataset.tab;
    view.offersShown = OFFERS_PAGE_SIZE;
    saveToHash();
    loadRows(view);
  }
  const intentButton = event.target.closest("[data-intent]");
  if (intentButton) {
    const intentId = intentButton.dataset.intent;
    if (view.intents.has(intentId)) view.intents.delete(intentId);
    else view.intents.add(intentId);
    saveToHash();
    drawPanel(view);
  }
  const expandButton = event.target.closest("[data-expand]");
  if (expandButton) {
    const companyKey = expandButton.dataset.expand;
    view.postsShownByCompany.set(companyKey, (view.postsShownByCompany.get(companyKey) || BOOTH_INITIAL_POSTS) + BOOTH_PAGE_SIZE);
    drawPanel(view);
  }
  if (event.target.closest("[data-more-offers]")) {
    view.offersShown += OFFERS_PAGE_SIZE;
    drawPanel(view);
  }
  if (event.target.closest("[data-clear]")) {
    view.query = "";
    findElement("#oq", view.root).value = "";
    view.intents.clear();
    saveToHash();
    loadRows(view);
  }
}

async function loadRows(view) {
  const collectionKey = view.tab === "offers" ? "offer" : "sponsor_opportunity";
  try {
    view.rows = await view.fetchRows(`/api/collection?key=${collectionKey}${view.query ? `&q=${encodeURIComponent(view.query)}` : ""}`);
    drawPanel(view);
  } catch (error) {
    if (!isAbortError(error)) setHTML(view.panel, errorCard(error));
  }
}

function matchesSelectedIntents(view, row) {
  return !view.intents.size || [...view.intents].some((intentId) => INTENTS.find((intent) => intent.id === intentId).pattern.test(row.text));
}

function drawTabsAndIntents(view) {
  for (const tab of view.root.querySelectorAll("[role=tab]")) {
    const isSelected = tab.dataset.tab === view.tab;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }
  view.panel.setAttribute("aria-labelledby", view.tab === "sponsors" ? "t-sp" : "t-of");
  setHTML(findElement("#intents", view.root), html`${INTENTS.map((intent) => html`<button class="fchip" type="button" data-intent="${intent.id}" aria-pressed="${view.intents.has(intent.id)}">${intent.label}<span class="num">${view.rows.filter((row) => intent.pattern.test(row.text)).length}</span></button>`)}`);
}

function drawPanel(view) {
  drawTabsAndIntents(view);
  const visibleRows = view.rows.filter((row) => matchesSelectedIntents(view, row));
  if (!view.rows.length && !view.query) {
    setHTML(view.panel, emptyState({ icon: "briefcase", title: "Nothing sorted yet", body: html`Run ${commandSnippet("npm run categorize")} to gather sponsor posts and offers. It runs locally and needs no API key.`, actions: html`<a class="btn btn--secondary" href="#/archive">Browse sponsor channels ${icon("arrow-right")}</a>` }));
    return;
  }
  if (!visibleRows.length) {
    setHTML(view.panel, emptyState({ icon: "search", title: view.query ? `No posts mention “${view.query}”` : "No posts of this kind", actions: html`<button class="btn btn--secondary" type="button" data-clear>Clear</button>` }));
    return;
  }
  const capNotice = view.rows.length === SERVER_ROW_CAP ? html`<p class="meta-line">Showing the latest 500. Use the filter to narrow.</p>` : "";
  const content = view.tab === "offers" ? renderOfferList(view, visibleRows) : renderCompanyBooths(view, visibleRows);
  setHTML(view.panel, html`${capNotice}${content}`);
  finalizeClamps(view.panel);
}

function renderOfferList(view, rows) {
  return html`<div class="opps opps--flat">${rows.slice(0, view.offersShown).map(renderPostCard)}</div>
        ${view.offersShown < rows.length ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more-offers>Show more</button></div>` : ""}`;
}

function renderCompanyBooths(view, rows) {
  const booths = groupIntoBooths(rows);
  return html`<p class="meta-line">${pluralize(booths.length, "company", "companies")}<span class="sep">·</span>${pluralize(rows.length, "post")}</p>
      ${booths.map((booth) => renderBooth(view, booth))}`;
}

// One booth per company, newest activity first; private messages go last.
function groupIntoBooths(rows) {
  const booths = new Map();
  for (const row of rows) {
    const company = companyOf(row);
    const booth = booths.get(company.key) || { ...company, rows: [], reps: new Map(), channels: new Set() };
    booth.rows.push(row);
    if (row.channel) booth.channels.add(row.channel);
    const author = store.peopleById.get(row.user_id);
    // Organizers and mentors posting in a sponsor channel are not that company's reps.
    if (author && (row.author_is_sponsor || (!row.author_is_organizer && !row.author_is_mentor))) booth.reps.set(author.id, author);
    booths.set(company.key, booth);
  }
  return [...booths.values()].sort((a, b) => (a.key === "dm") - (b.key === "dm") || b.rows[0].ts - a.rows[0].ts);
}

function renderBooth(view, booth) {
  const shownCount = view.postsShownByCompany.get(booth.key) || BOOTH_INITIAL_POSTS;
  const channels = [...booth.channels];
  const homeChannel = channels.find((channel) => view.channelIdByName[channel] && /spons|cohost|partner/.test(channel)) || channels[0];
  const homeChannelId = homeChannel && view.channelIdByName[homeChannel];
  return html`<section class="booth" id="co-${encodeURIComponent(booth.key)}" aria-label="${booth.label}">
          <header class="booth__head">
            <div class="booth__id"><h2 class="booth__name">${booth.label}</h2>
              <span class="num faint">${booth.channel ? html`${channels.slice(0, 2).join(" ")} · ` : ""}${pluralize(booth.rows.length, "post")}</span></div>
            ${renderRepsCord([...booth.reps.values()].slice(0, MAX_CORD_REPS))}
            ${homeChannelId ? html`<a class="lane__more booth__open" href="#/archive/${homeChannelId}">Open channel ${icon("arrow-right", "i i--12")}</a>` : ""}
          </header>
          <div class="opps">${booth.rows.slice(0, shownCount).map(renderPostCard)}</div>
          ${booth.rows.length > shownCount ? html`<button class="linkbtn booth__more" type="button" data-expand="${booth.key}">${icon("chevron-down", "i i--12")}Show ${Math.min(BOOTH_PAGE_SIZE, booth.rows.length - shownCount)} more of ${booth.rows.length}</button>` : ""}
        </section>`;
}

function renderPostCard(row) {
  const author = store.peopleById.get(row.user_id);
  const { body } = splitMessageExtras(row.text);
  const urls = findLinkUrls(row.text, MAX_POST_LINKS);
  const linkedInUrl = row.author_linkedin?.[0];
  return html`<article class="opp">
    <header class="opp__head">${personAvatar(author, 28, row.user_name)}
      <span class="opp__who">${author ? html`<a href="#/people/${author.id}">${nameOf(author)}</a>` : html`<b>${cleanName(row.user_name)}</b>`}${author ? roleChips(author, 1) : ""}</span>
      <time class="num faint" datetime="${row.date}">${formatDate(row.date)}</time></header>
    <div class="msg__text clamp opp__text" style="--lines:5">${rawHtml(renderSlackText(body))}</div>
    ${urls.length ? html`<div class="opp__links">${urls.map((url) => html`<a class="linkchip" href="${url}" target="_blank" rel="noreferrer">${icon("link", "i i--12")}${shortenUrl(url, 30)}${NEW_TAB_NOTICE}</a>`)}</div>` : ""}
    <footer class="opp__foot">
      ${linkedInUrl ? html`<a class="linkbtn" href="${linkedInUrl}" target="_blank" rel="noreferrer">${icon("linkedin", "i i--12")}Open LinkedIn${NEW_TAB_NOTICE}</a>` : ""}
      <a class="linkbtn" href="${archiveLinkFor(row)}">${icon("message", "i i--12")}View in thread</a>
      <span class="opp__chan num faint">${row.channel}</span>
    </footer></article>`;
}

// The company's reps hang from one shared cord: avatars spaced evenly along a shallow parabola.
function renderRepsCord(reps) {
  if (!reps.length) return "";
  return html`<div class="cord" aria-label="People from this company">
    <svg class="cord__line" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 2 Q50 14 100 2" vector-effect="non-scaling-stroke"/></svg>
    ${reps.map((rep, index) => renderCordTag(rep, index, reps.length))}
  </div>`;
}

function renderCordTag(rep, index, repCount) {
  const position = (index + 0.5) / repCount;
  const sag = 2 + 12 * 2 * position * (1 - position) * 0.83;
  return html`<a class="cord__tag" href="#/people/${rep.id}" style="left:${(position * 100).toFixed(2)}%;top:${(sag * 0.9).toFixed(1)}px" data-tip="${nameOf(rep)}" aria-label="${nameOf(rep)}">${personAvatar(rep, 28)}</a>`;
}
