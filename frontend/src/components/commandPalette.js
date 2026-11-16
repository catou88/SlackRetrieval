// The Ctrl+K command palette: people (or recent people), channels, quick actions and keyword
// message matches in one keyboard-driven list.
import { html, icon } from "../utils/html.js";
import { findElement, setHTML, debounce, announce } from "../utils/dom.js";
import { formatDate } from "../utils/format.js";
import { nameOf, roleChipsOf, matchPeople, linkedInSlug } from "../utils/people.js";
import { createRequestSlot, isAbortError } from "../services/api.js";
import { copyText } from "../services/clipboard.js";
import { store, teammateOf, loadChannels } from "../contexts/appState.js";
import { recentPeople } from "../contexts/preferences.js";
import { navigateTo } from "../contexts/navigation.js";
import { cycleTheme } from "../contexts/theme.js";
import { personAvatar } from "./avatar.js";
import { openDialog } from "./dialog.js";
import { slackExcerpt } from "./slackText.js";

const ACTIONS = [
  { label: "Go to Home", href: "#/", icon: "home" },
  { label: "Go to People", href: "#/people", icon: "users" },
  { label: "Go to Mentors & judges", href: "#/people?f=mentors", icon: "users" },
  { label: "Go to Opportunities", href: "#/opportunities", icon: "briefcase" },
  { label: "Go to Teammates", href: "#/teammates", icon: "handshake" },
  { label: "Go to Archive", href: "#/archive", icon: "archive" },
  { label: "Ask your archive", href: "#/ask", icon: "sparkles" },
  { label: "Toggle theme", run: cycleTheme, icon: "sun" },
  { label: "Show shortcuts", run: () => document.querySelector("[data-open-shortcuts]").click(), icon: "command" },
];
const MAX_PEOPLE = 6;
const MAX_CHANNELS = 4;
const MAX_ACTIONS_WHILE_TYPING = 4;
const MAX_MESSAGES = 5;
const MIN_MESSAGE_QUERY = 2;
const MESSAGE_SEARCH_DELAY_MS = 250;
const MESSAGE_EXCERPT_LENGTH = 90;

let isPaletteOpen = false;

/** Open the palette (no-op if it is already open). @param {HTMLElement} [opener] focus returns here */
export function openPalette(opener) {
  if (isPaletteOpen) return;
  isPaletteOpen = true;
  const { dlg: dialog, close } = openDialog({
    label: "Search", opener, cls: "dlg--palette", onClose: () => (isPaletteOpen = false),
    body: paletteMarkup(),
  });
  const palette = {
    input: findElement(".pal__input", dialog),
    list: findElement("#pal-list", dialog),
    items: [],
    selectedIndex: 0,
    messages: [],
    channels: [],
    close,
  };
  loadChannels().then((channels) => {
    palette.channels = channels;
    drawPalette(palette);
  }).catch(() => {});
  wirePaletteEvents(palette);
  drawPalette(palette);
}

// ---------- private helpers ----------

function paletteMarkup() {
  return html`<div class="pal__bar">${icon("search")}
      <input class="pal__input" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Search people, channels, messages…" autofocus autocomplete="off" spellcheck="false">
      <kbd>Esc</kbd></div>
      <ul class="pal__list" id="pal-list" role="listbox" aria-label="Results"></ul>
      <footer class="pal__foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></footer>`;
}

function wirePaletteEvents(palette) {
  const fetchMessages = createRequestSlot();
  const searchMessages = debounce((query) => loadMessageMatches(palette, query, fetchMessages), MESSAGE_SEARCH_DELAY_MS);
  palette.input.addEventListener("input", () => {
    palette.selectedIndex = 0;
    drawPalette(palette);
    searchMessages(palette.input.value);
  });
  palette.input.addEventListener("keydown", (event) => handlePaletteKeydown(event, palette));
  palette.list.addEventListener("mousemove", (event) => {
    const row = event.target.closest("[data-i]");
    if (row && +row.dataset.i !== palette.selectedIndex) selectRow(palette, +row.dataset.i, false);
  });
  palette.list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-i]");
    if (row) activateItem(palette, palette.items[+row.dataset.i]);
  });
}

function handlePaletteKeydown(event, palette) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = palette.items.length;
    if (!count) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    selectRow(palette, (palette.selectedIndex + step + count) % count);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activateItem(palette, palette.items[palette.selectedIndex]);
  }
}

async function loadMessageMatches(palette, query, fetchMessages) {
  if (query.trim().length < MIN_MESSAGE_QUERY) {
    palette.messages = [];
    drawPalette(palette);
    return;
  }
  try {
    palette.messages = await fetchMessages(`/api/search?mode=keyword&q=${encodeURIComponent(query.trim())}`);
  } catch (error) {
    if (!isAbortError(error)) palette.messages = [];
  }
  // A slower answer for an older query must not repaint over what the user typed since.
  if (palette.input.value === query) drawPalette(palette);
}

function buildGroups(query, palette) {
  const needle = query.trim().toLowerCase();
  const groups = [];
  const people = needle
    ? matchPeople(query, store.people, MAX_PEOPLE)
    : recentPeople.get().map((id) => store.peopleById.get(id)).filter(Boolean);
  if (people.length) groups.push({ title: needle ? "People" : "Recent", items: people.map((person) => ({ kind: "person", person, href: `#/people/${person.id}` })) });
  if (needle) {
    const channels = palette.channels.filter((channel) => channel.name.toLowerCase().includes(needle)).slice(0, MAX_CHANNELS);
    if (channels.length) groups.push({ title: "Channels", items: channels.map((channel) => ({ kind: "channel", channel, href: `#/archive/${channel.id}` })) });
  }
  const actions = matchingActions(needle, people[0]);
  if (actions.length) groups.push({ title: "Actions", items: actions.map((action) => ({ kind: "action", action, href: action.href })) });
  if (needle.length >= MIN_MESSAGE_QUERY && palette.messages.length) {
    groups.push({ title: "Messages", items: palette.messages.slice(0, MAX_MESSAGES).map((message) => ({ kind: "message", message, href: messageHref(message) })) });
  }
  if (needle.length >= MIN_MESSAGE_QUERY) groups.push({ title: "", items: [{ kind: "searchAll", href: `#/archive/search?mode=keyword&q=${encodeURIComponent(query.trim())}` }] });
  return groups;
}

// While typing, the best person match also gets "copy / open their LinkedIn" shortcuts on top.
function matchingActions(needle, topPerson) {
  const actions = ACTIONS.filter((action) => !needle || action.label.toLowerCase().includes(needle))
    .slice(0, needle ? MAX_ACTIONS_WHILE_TYPING : ACTIONS.length);
  if (needle && topPerson?.linkedin.length) {
    actions.unshift(
      { label: `Copy LinkedIn of ${nameOf(topPerson)}`, copy: topPerson.linkedin[0], icon: "copy" },
      { label: `Open LinkedIn of ${nameOf(topPerson)}`, external: topPerson.linkedin[0], icon: "linkedin" },
    );
  }
  return actions;
}

function messageHref(message) {
  const isReply = message.thread_ts && message.thread_ts !== message.ts;
  return `#/archive/${message.channel_id}?ts=${message.ts}${isReply ? "&thread=" + message.thread_ts : ""}`;
}

function drawPalette(palette) {
  const groups = buildGroups(palette.input.value, palette);
  palette.items = groups.flatMap((group) => group.items);
  if (palette.selectedIndex >= palette.items.length) palette.selectedIndex = 0;
  let rowIndex = 0;
  const renderGroup = (group) => html`<li role="presentation" class="pal__group">${group.title ? html`<span class="pal__gh" id="pg-${group.title}">${group.title}</span>` : ""}
          <ul role="group" ${group.title ? html`aria-labelledby="pg-${group.title}"` : html`aria-label="More"`}>${group.items.map((item) => renderRow(palette, item, rowIndex++))}</ul></li>`;
  setHTML(palette.list, palette.items.length
    ? html`${groups.map(renderGroup)}`
    : html`<li class="pal__empty" role="presentation">No matches. Try a first name or a channel.</li>`);
  palette.input.setAttribute("aria-activedescendant", palette.items.length ? `pal-${palette.selectedIndex}` : "");
  palette.list.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
}

function renderRow(palette, item, index) {
  const isSelected = index === palette.selectedIndex;
  const attributes = html`id="pal-${index}" role="option" aria-selected="${isSelected}" data-i="${index}" class="pal__row${isSelected ? " is-sel" : ""}"`;
  if (item.kind === "person") return renderPersonRow(attributes, item.person);
  if (item.kind === "channel") return html`<li ${attributes}>${icon(item.channel.type === "im" ? "message" : "hash")}<span class="pal__label">${item.channel.name.replace(/^#/, "")}</span><span class="pal__hint">${item.channel.message_count} msgs</span></li>`;
  if (item.kind === "action") return html`<li ${attributes}>${icon(item.action.icon)}<span class="pal__label">${item.action.label}</span><span class="pal__hint">${item.action.external ? "↗" : ""}</span></li>`;
  if (item.kind === "message") return renderMessageRow(attributes, item.message);
  return html`<li ${attributes}>${icon("search")}<span class="pal__label">Search all messages for “${palette.input.value.trim()}”</span><span class="pal__hint">↵</span></li>`;
}

function renderPersonRow(attributes, person) {
  const firstChip = roleChipsOf(person, teammateOf(person.id))[0];
  const subLabel = firstChip ? firstChip.label : person.title || "@" + person.handle;
  const hint = person.linkedin.length ? "in/" + linkedInSlug(person.linkedin[0]) : "";
  return html`<li ${attributes}>${personAvatar(person, 28)}<span class="pal__label">${nameOf(person)}<span class="pal__sub">${subLabel}</span></span><span class="pal__hint">${hint}</span></li>`;
}

function renderMessageRow(attributes, message) {
  const knownName = nameOf(store.peopleById.get(message.user_id));
  const authorName = knownName !== "Unknown" ? knownName : message.user_name;
  return html`<li ${attributes}>${icon("message")}<span class="pal__label"><span class="pal__msg">${authorName}<span class="pal__sub">${message.channel} · ${formatDate(message.date)}</span></span><span class="pal__excerpt">${slackExcerpt(message.text, MESSAGE_EXCERPT_LENGTH)}</span></span></li>`;
}

// Moves the selection without redrawing, so hovering never rebuilds the list under the pointer.
function selectRow(palette, index, shouldScroll = true) {
  palette.list.querySelector(".is-sel")?.classList.remove("is-sel");
  palette.list.querySelector("[aria-selected=true]")?.setAttribute("aria-selected", "false");
  palette.selectedIndex = index;
  const row = palette.list.querySelector(`#pal-${index}`);
  if (row) {
    row.classList.add("is-sel");
    row.setAttribute("aria-selected", "true");
    if (shouldScroll) row.scrollIntoView({ block: "nearest" });
  }
  palette.input.setAttribute("aria-activedescendant", `pal-${index}`);
}

async function activateItem(palette, item) {
  if (!item) return;
  const action = item.kind === "action" ? item.action : null;
  if (action?.copy) {
    const isCopied = await copyText(action.copy);
    announce(isCopied ? "Copied LinkedIn link" : "Couldn't copy");
    palette.close();
    return;
  }
  if (action?.external) {
    open(action.external, "_blank", "noreferrer");
    palette.close();
    return;
  }
  palette.close();
  if (action?.run) {
    action.run();
    return;
  }
  navigateTo(item.href);
}
