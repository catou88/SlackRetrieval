// Archive: channel index | channel reader | message search. The reader is windowed (at most
// MAX_RENDERED_MESSAGES message nodes) so very long channels stay fast.
import { html, icon } from "../utils/html.js";
import { formatNumber, pluralize } from "../utils/format.js";
import { findElement, findAllElements, setHTML, debounce } from "../utils/dom.js";
import { nameOf, companyNameFromSlug, sponsorSlugOf } from "../utils/people.js";
import { getJson, createRequestSlot, isAbortError } from "../services/api.js";
import { store, loadChannels } from "../contexts/appState.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { renderMessageList, renderMessage, finalizeClamps, toggleThread } from "../components/message.js";
import { emptyState, errorCard, loadingSkeleton } from "../components/states.js";

const PAGE_SIZE = 100;
const MAX_RENDERED_MESSAGES = 200;
const MAX_SEARCH_RESULTS = 100;
// Long, low-value groups start collapsed in the index.
const COLLAPSE_GROUP_OVER = 30;
const MAX_BUSIEST_CHANNELS = 6;
// Give up looking for a deep-linked message after this many older pages.
const MAX_PAGES_TO_FIND_TARGET = 40;
// Messages kept above a deep-linked message so it has context.
const CONTEXT_ABOVE_TARGET = 40;
const KEYWORD_SEARCH_DELAY_MS = 300;
// Lets the reader lay out before scrolling to (and flashing) a deep-linked message.
const SCROLL_TO_TARGET_DELAY_MS = 60;
const FLASH_DURATION_MS = 1600;

/** Document title: "Search" on #/archive/search, "Archive" otherwise. */
export function pageTitle(route) {
  return route.id === "search" ? "Search" : "Archive";
}

/** Render the archive index plus a channel, search results, or a welcome panel into `root`. */
export async function renderPage(root, { id, params }) {
  const channels = await loadChannels();
  const archive = {
    root,
    channelId: id,
    params,
    channels,
    isSearch: id === "search",
    searchMode: params.get("mode") === "keyword" ? "keyword" : "semantic",
  };
  setHTML(root, renderArchiveShell(archive, params.get("q") || ""));
  archive.reader = findElement("#reader", root);
  wireArchiveEvents(archive);
  await showInitialPanel(archive, params.get("q") || "");
}

// ---------- private helpers ----------

function isDirectMessage(channel) {
  return channel.type === "im" || channel.type === "mpim";
}

// What a channel is called in the index: the DM partner's name, the sponsor's company, or the
// channel name without "#" and the event's numeric ordering prefix.
function channelLabel(channel) {
  if (isDirectMessage(channel)) {
    const partner = store.peopleById.get(channel.dm_with);
    return partner ? nameOf(partner) : channel.name.replace(/^DM with /, "");
  }
  const sponsorSlug = sponsorSlugOf(channel.name);
  if (sponsorSlug) return companyNameFromSlug(sponsorSlug);
  return channel.name.replace(/^#/, "").replace(/^\d+-/, "");
}

function channelIconName(channel) {
  if (channel.type === "im") return "message";
  if (channel.type === "private") return "lock";
  return "hash";
}

/** @returns {Array<{key: string, title: string, channels: object[], isOpen: boolean}>} non-empty groups in display order */
function groupChannels(channels) {
  const groups = { dm: [], sponsors: [], event: [], travel: [], other: [] };
  for (const channel of channels) groups[channelGroupKey(channel)].push(channel);
  groups.sponsors.sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
  groups.event.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  groups.travel.sort((a, b) => b.message_count - a.message_count);
  return [
    { key: "dm", title: "Direct messages", channels: groups.dm, isOpen: true },
    { key: "event", title: "Event", channels: groups.event, isOpen: true },
    { key: "sponsors", title: "Sponsors", channels: groups.sponsors, isOpen: true },
    { key: "travel", title: "Travel", channels: groups.travel, isOpen: groups.travel.length <= COLLAPSE_GROUP_OVER },
    { key: "other", title: "Other", channels: groups.other, isOpen: groups.other.length <= COLLAPSE_GROUP_OVER },
  ].filter((group) => group.channels.length);
}

function channelGroupKey(channel) {
  if (isDirectMessage(channel)) return "dm";
  if (sponsorSlugOf(channel.name)) return "sponsors";
  if (/^#?\d+-travel/.test(channel.name)) return "travel";
  if (/^#?\d+-/.test(channel.name)) return "event";
  return "other";
}

function renderArchiveShell(archive, initialQuery) {
  const { isSearch, searchMode, channelId } = archive;
  return html`
    <header class="page-head arch-head"><h1 class="title">${isSearch ? "Search messages" : "Archive"}</h1>
      <form class="arch-search" id="asearch" role="search">
        <label class="field">${icon("search")}<span class="sr">Search messages</span><input class="input" id="aq" type="search" placeholder="Search all ${formatNumber(store.stats.messages)} messages…" value="${initialQuery}" autocomplete="off"></label>
        <div class="seg" role="group" aria-label="Search mode">
          <button type="button" data-mode="semantic" aria-pressed="${searchMode === "semantic"}">By meaning</button>
          <button type="button" data-mode="keyword" aria-pressed="${searchMode === "keyword"}">Exact words</button>
        </div>
      </form>
      <p class="faint small arch-help">By meaning finds related ideas; exact words finds the phrase.</p>
    </header>
    <div class="arch ${channelId ? "arch--open" : ""}">
      <nav class="arch__index" aria-label="Channels">${groupChannels(archive.channels).map((group) => renderChannelGroup(group, channelId))}</nav>
      <section class="arch__reader" id="reader" aria-live="polite"></section>
    </div>`;
}

function renderChannelGroup(group, activeChannelId) {
  return html`<details class="agroup" ${group.isOpen ? "open" : ""}>
        <summary><span class="eyebrow">${group.title}</span><span class="num faint">${group.channels.length}</span>${icon("chevron-down", "i i--12 agroup__chev")}</summary>
        <ul class="bare">${group.channels.map((channel) => html`<li><a class="aitem" href="#/archive/${channel.id}" ${channel.id === activeChannelId ? html`aria-current="page"` : ""} title="${channel.name}">
          ${icon(channelIconName(channel), "i i--12")}<span>${channelLabel(channel)}</span><span class="num">${formatNumber(channel.message_count)}</span></a></li>`)}</ul></details>`;
}

function wireArchiveEvents(archive) {
  const { root } = archive;
  const fetchSearch = createRequestSlot();
  archive.runSearch = (query) => runSearch(archive, query, fetchSearch);
  // Exact-word search is cheap, so it updates as you type; meaning search waits for Enter.
  const searchAfterTyping = debounce(() => archive.searchMode === "keyword" && archive.isSearch && archive.runSearch(findElement("#aq", root).value), KEYWORD_SEARCH_DELAY_MS);
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    archive.runSearch(findElement("#aq", root).value);
  });
  root.addEventListener("input", (event) => event.target.id === "aq" && searchAfterTyping());
  root.addEventListener("click", (event) => handleArchiveClick(event, archive));
}

function handleArchiveClick(event, archive) {
  const { root } = archive;
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    archive.searchMode = modeButton.dataset.mode;
    for (const button of findAllElements("[data-mode]", root)) button.setAttribute("aria-pressed", String(button === modeButton));
    if (findElement("#aq", root).value.trim() && archive.isSearch) archive.runSearch(findElement("#aq", root).value);
  }
  if (event.target.closest("[data-switch]")) findElement(`[data-mode="${otherSearchMode(archive.searchMode)}"]`, root).click();
  if (event.target.closest("[data-earlier]")) showEarlierMessages(archive);
  if (event.target.closest("[data-newer]")) showNewerMessages(archive);
}

function otherSearchMode(mode) {
  return mode === "semantic" ? "keyword" : "semantic";
}

async function showInitialPanel(archive, initialQuery) {
  const { reader, root } = archive;
  if (archive.isSearch) {
    if (initialQuery) archive.runSearch(initialQuery);
    else setHTML(reader, emptyState({ icon: "search", title: "Search the whole workspace", body: "Type a question or a phrase. By meaning works offline using the local index." }));
    findElement(".arch", root).classList.add("arch--open");
  } else if (archive.channelId) {
    await openChannel(archive);
  } else {
    setHTML(reader, renderWelcome(archive.channels));
  }
}

function renderWelcome(channels) {
  const busiest = [...channels].filter((channel) => channel.type !== "im").sort((a, b) => b.message_count - a.message_count).slice(0, MAX_BUSIEST_CHANNELS);
  return html`<div class="arch-welcome">${emptyState({ icon: "archive", title: "Pick a channel", body: `${formatNumber(channels.length)} channels and DMs are saved on this computer. The busiest ones:` })}
      <ul class="bare arch-top">${busiest.map((channel) => html`<li><a href="#/archive/${channel.id}"><span>${channel.name}</span><span class="num faint">${formatNumber(channel.message_count)}</span></a></li>`)}</ul></div>`;
}

// ---------- search ----------

async function runSearch(archive, rawQuery, fetchSearch) {
  const query = rawQuery.trim();
  if (!query) return;
  const mode = archive.searchMode;
  // Searching from a channel page moves to the search page, which then runs the query.
  if (!archive.isSearch) {
    location.hash = `#/archive/search?mode=${mode}&q=${encodeURIComponent(query)}`;
    return;
  }
  replaceHashParams({ q: query, mode });
  setHTML(archive.reader, loadingSkeleton("rows", 5));
  try {
    const rows = await fetchSearch(`/api/search?mode=${mode}&q=${encodeURIComponent(query)}`);
    setHTML(archive.reader, rows.length ? renderSearchResults(rows, mode) : renderNoMatches(query, mode));
    if (rows.length) finalizeClamps(archive.reader);
  } catch (error) {
    if (isAbortError(error)) return;
    // Meaning search needs the local vector index; when it fails, exact words still works.
    if (mode === "semantic") setHTML(archive.reader, emptyState({ icon: "info", title: "Search by meaning isn't available", body: "Try exact words.", actions: html`<button class="btn btn--secondary" type="button" data-switch>Search exact words</button>` }));
    else setHTML(archive.reader, errorCard(error));
  }
}

function renderSearchResults(rows, mode) {
  return html`<p class="meta-line rhead">${pluralize(rows.length, "result")} · ${mode === "semantic" ? "by meaning" : "exact words"}</p>
        <div class="msgs">${rows.slice(0, MAX_SEARCH_RESULTS).map((message) => renderMessage(message, { channel: true, jump: true, thread: false }))}</div>`;
}

function renderNoMatches(query, mode) {
  const otherModeName = mode === "semantic" ? "exact words" : "by meaning";
  return emptyState({ icon: "search", title: `No messages match “${query}”`, body: `Try fewer words or switch to ${otherModeName}.`, actions: html`<button class="btn btn--secondary" type="button" data-switch>Search ${otherModeName}</button>` });
}

// ---------- channel reader (windowed) ----------
// `loaded` holds every fetched message, oldest first; [windowStart, windowEnd) is what is rendered.

async function openChannel(archive) {
  const { reader, params } = archive;
  Object.assign(archive, { channelInfo: null, loaded: [], fetchedCount: 0, isExhausted: false, windowStart: 0, windowEnd: 0 });
  setHTML(reader, loadingSkeleton("rows", 6));
  const linkedTs = params.get("ts");
  const linkedThreadTs = params.get("thread");
  const targetTs = linkedThreadTs || linkedTs;
  try {
    await fetchOlderPage(archive);
    for (let page = 0; targetTs && !isLoaded(archive, targetTs) && !archive.isExhausted && page < MAX_PAGES_TO_FIND_TARGET; page++) await fetchOlderPage(archive);
    archive.windowEnd = archive.loaded.length;
    archive.windowStart = Math.max(0, archive.windowEnd - PAGE_SIZE);
    const targetIndex = targetTs ? archive.loaded.findIndex((message) => message.ts === targetTs) : -1;
    if (targetIndex >= 0) {
      archive.windowStart = Math.max(0, targetIndex - CONTEXT_ABOVE_TARGET);
      archive.windowEnd = Math.min(archive.loaded.length, archive.windowStart + MAX_RENDERED_MESSAGES);
    }
    drawReader(archive);
    setTimeout(() => revealLinkedMessage(archive, targetIndex >= 0 ? targetTs : null, linkedTs, linkedThreadTs), SCROLL_TO_TARGET_DELAY_MS);
  } catch (error) {
    setHTML(reader, errorCard(error));
  }
}

function isLoaded(archive, ts) {
  return archive.loaded.some((message) => message.ts === ts);
}

// Pages come newest first from the server, so each fetch prepends older messages.
async function fetchOlderPage(archive) {
  const page = await getJson(`/api/channel?id=${encodeURIComponent(archive.channelId)}&limit=${PAGE_SIZE}&offset=${archive.fetchedCount}`);
  archive.channelInfo = page.channel;
  archive.fetchedCount += PAGE_SIZE;
  if (page.messages.length < PAGE_SIZE) archive.isExhausted = true;
  archive.loaded = [...page.messages, ...archive.loaded];
  return page.messages.length;
}

// Scroll to the deep-linked message, opening its thread (and flashing the reply) when the link
// points into one. Without a target, wide screens start at the newest message.
async function revealLinkedMessage(archive, targetTs, linkedTs, linkedThreadTs) {
  const target = targetTs && archive.reader.querySelector(`[data-ts="${CSS.escape(targetTs)}"]`);
  if (!target) {
    if (matchMedia("(min-width:768px)").matches) scrollTo(0, document.body.scrollHeight);
    return;
  }
  target.scrollIntoView({ block: "center" });
  const threadButton = target.querySelector("[data-thread]");
  if (linkedThreadTs && threadButton) {
    toggleThread(threadButton, linkedTs);
  } else {
    target.classList.add("flash");
    if (threadButton) toggleThread(threadButton);
  }
  setTimeout(() => target.classList.remove("flash"), FLASH_DURATION_MS);
}

function drawReader(archive) {
  const { reader, loaded, windowStart, windowEnd } = archive;
  const channel = archive.channels.find((candidate) => candidate.id === archive.channelId) || archive.channelInfo;
  const canShowEarlier = windowStart > 0 || !archive.isExhausted;
  setHTML(reader, html`<header class="rhead">
        <a class="back back--reader" href="#/archive">${icon("arrow-left")}Archive</a>
        <h2 class="rhead__name">${channel.type === "im" ? channelLabel(channel) : channel.name}</h2>
        <p class="num faint">${formatNumber(channel.message_count)} messages${archive.channelInfo?.topic ? html`<span class="rhead__topic"> · ${archive.channelInfo.topic}</span>` : ""}</p></header>
      ${canShowEarlier ? html`<div class="showmore showmore--top"><button class="btn btn--ghost" type="button" data-earlier>${icon("chevron-down", "i i--12 flipy")}Load earlier messages</button></div>` : ""}
      ${loaded.length ? html`<div class="msgs" id="msgs">${renderMessageList(loaded.slice(windowStart, windowEnd), { lines: 8 })}</div>`
        : emptyState({ icon: "message", title: "This channel has no saved messages" })}
      ${windowEnd < loaded.length ? html`<div class="showmore"><button class="btn btn--ghost" type="button" data-newer>Show newer messages</button></div>` : ""}`);
  finalizeClamps(reader);
}

// Older messages render above, so keep the first visible message where it was on screen.
async function showEarlierMessages(archive) {
  const anchor = findElement("#msgs .msg", archive.reader);
  const anchorTop = anchor?.getBoundingClientRect().top;
  if (archive.windowStart === 0 && !archive.isExhausted) {
    const fetchedCount = await fetchOlderPage(archive);
    archive.windowStart += fetchedCount;
    archive.windowEnd += fetchedCount;
  }
  archive.windowStart = Math.max(0, archive.windowStart - PAGE_SIZE);
  archive.windowEnd = Math.min(archive.loaded.length, archive.windowStart + MAX_RENDERED_MESSAGES);
  drawReader(archive);
  const sameMessage = anchor && archive.reader.querySelector(`[data-ts="${anchor.dataset.ts}"]`);
  if (sameMessage) scrollBy(0, sameMessage.getBoundingClientRect().top - anchorTop);
}

function showNewerMessages(archive) {
  archive.windowEnd = Math.min(archive.loaded.length, archive.windowEnd + PAGE_SIZE);
  archive.windowStart = Math.max(0, archive.windowEnd - MAX_RENDERED_MESSAGES);
  drawReader(archive);
}
