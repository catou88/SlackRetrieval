// Slack messages: one message, day-grouped lists, attachments and link previews, thread
// expansion and the "Show more" clamp toggles.
import { html, rawHtml, icon, NEW_TAB_NOTICE } from "../utils/html.js";
import { formatDate, formatTime, calendarDayKey, formatDayLabel, pluralize } from "../utils/format.js";
import { setHTML } from "../utils/dom.js";
import { nameOf, cleanName } from "../utils/people.js";
import { splitMessageExtras, shortenUrl } from "../utils/slackFormat.js";
import { emojiFor } from "../utils/emoji.js";
import { getJson } from "../services/api.js";
import { store } from "../contexts/appState.js";
import { personAvatar } from "./avatar.js";
import { roleChips } from "./chips.js";
import { errorCard } from "./states.js";
import { renderSlackText } from "./slackText.js";

const DEFAULT_LINES = 6;
const GROUP_WINDOW_SECONDS = 300;
const MAX_UNFURLS = 2;
const MAX_REACTIONS = 8;
const MAX_THREAD_REPLIES = 150;
const THREAD_LINES = 8;
// Allow a few px of rounding before deciding text really overflows its clamp.
const CLAMP_TOLERANCE_PX = 4;
const PREVIEWABLE_IMAGE_RE = /^image\/(png|jpe?g|gif|webp)/;

/** Archive deep link for a message (opens its thread when it is a reply). */
export function archiveLinkFor(message) {
  const isReply = message.thread_ts && message.thread_ts !== message.ts;
  return `#/archive/${message.channel_id}?ts=${message.ts}${isReply ? `&thread=${message.thread_ts}` : ""}`;
}

/** Attachments and link previews for a message whose body is rendered elsewhere. */
export function messageAttachments(message) {
  const { links, files } = splitMessageExtras(message.text);
  return html`${renderFiles(message, files)}${renderUnfurls(links)}`;
}

/**
 * One message.
 * @param {{grouped?: boolean, channel?: boolean, clamp?: boolean, lines?: number, thread?: boolean,
 *   jump?: boolean, noChips?: boolean}} [options]
 */
export function renderMessage(item, options = {}) {
  const person = store.peopleById.get(item.user_id);
  const { body, links, files } = splitMessageExtras(item.text);
  const gutter = options.grouped ? html`<time class="msg__hover-time">${formatTime(item.date)}</time>` : personAvatar(person, 28, item.user_name);
  const textClass = options.clamp === false ? "msg__text" : "msg__text clamp";
  return html`<article class="msg${options.grouped ? " msg--grouped" : ""}" data-ts="${item.ts}" id="m-${item.ts.replace(".", "-")}" tabindex="-1">
    <div class="msg__gutter">${gutter}</div>
    <div class="msg__main">
      ${options.grouped ? "" : renderHead(item, person, options)}
      ${body ? html`<div class="${textClass}" style="--lines:${options.lines || DEFAULT_LINES}">${rawHtml(renderSlackText(body))}</div>` : ""}
      ${renderFiles(item, files)}${renderUnfurls(links)}${renderReactions(item)}
      ${options.thread !== false && item.reply_count > 0 ? renderThreadToggle(item) : ""}
      ${options.jump ? html`<a class="msg__jump" href="${archiveLinkFor(item)}">Jump to message ${icon("arrow-right", "i i--12")}</a>` : ""}
    </div>
  </article>`;
}

/** Messages with day dividers, grouping one author's messages within 5 minutes. */
export function renderMessageList(items, options = {}) {
  let previous = null;
  let currentDay = null;
  const out = [];
  for (const item of items) {
    const day = calendarDayKey(item.date);
    if (options.days !== false && day !== currentDay) {
      out.push(html`<div class="dayrule" role="separator"><span>${formatDayLabel(item.date)}</span></div>`);
      currentDay = day;
      previous = null;
    }
    out.push(renderMessage(item, { ...options, grouped: isGroupedWith(previous, item, options) }));
    previous = item;
  }
  return out;
}

/** Add "Show more" toggles to clamped text that actually overflows. Call after inserting. */
export function finalizeClamps(root) {
  requestAnimationFrame(() => {
    for (const element of root.querySelectorAll(".clamp:not([data-checked])")) {
      element.dataset.checked = "1";
      if (element.scrollHeight > element.clientHeight + CLAMP_TOLERANCE_PX) {
        element.insertAdjacentHTML("afterend", `<button class="linkbtn more" type="button" data-unclamp aria-expanded="false">Show more</button>`);
      }
    }
  });
}

/** Toggle a "Show more" button's clamp. */
export function toggleClamp(button) {
  const text = button.previousElementSibling;
  const isOpen = button.getAttribute("aria-expanded") === "true";
  text.classList.toggle("clamp", isOpen);
  button.setAttribute("aria-expanded", String(!isOpen));
  button.textContent = isOpen ? "Show more" : "Show less";
}

/**
 * Expand (or collapse) a message's replies, loading them once.
 * @param {HTMLButtonElement} button  the [data-thread] toggle
 * @param {string} [highlightTs]  a reply to flash and scroll to (forces the thread open)
 */
export async function toggleThread(button, highlightTs) {
  const box = button.nextElementSibling;
  const isOpen = button.getAttribute("aria-expanded") === "true";
  if (isOpen && !highlightTs) {
    box.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }
  button.setAttribute("aria-expanded", "true");
  box.hidden = false;
  if (!box.dataset.loaded) await loadReplies(button, box);
  if (highlightTs) flashReply(box, highlightTs);
}

// ---------- private helpers ----------

function renderHead(item, person, options) {
  const authorName = person ? nameOf(person) : cleanName(item.user_name) || "Unknown";
  return html`<header class="msg__head">
      ${person ? html`<a class="msg__who" href="#/people/${person.id}">${authorName}</a>` : html`<span class="msg__who">${authorName}</span>`}
      ${person && !options.noChips ? roleChips(person, 1, false) : ""}
      <time class="msg__time" datetime="${item.date}">${options.channel ? formatDate(item.date) + " · " : ""}${formatTime(item.date)}</time>
      ${options.channel ? html`<a class="msg__chan" href="${archiveLinkFor(item)}">${item.channel}</a>` : ""}
    </header>`;
}

function renderThreadToggle(item) {
  return html`<button class="msg__thread" type="button" data-thread="${item.channel_id}|${item.ts}" aria-expanded="false">${icon("message", "i i--12")}${pluralize(item.reply_count, "reply", "replies")}</button><div class="thread" hidden></div>`;
}

function isGroupedWith(previous, item, options) {
  if (options.channel || !previous || previous.reply_count) return false;
  return previous.user_id === item.user_id && +item.ts - +previous.ts < GROUP_WINDOW_SECONDS;
}

function renderFiles(item, fileNames) {
  const files = item.files?.length ? item.files : fileNames.map((name) => ({ name }));
  if (!files.length) return "";
  return html`<div class="msg__files">${files.map(renderFile)}</div>`;
}

function renderFile(file) {
  const href = file.local_path ? `/${file.local_path}` : file.permalink;
  const isPreviewable = file.local_path && PREVIEWABLE_IMAGE_RE.test(file.mimetype || "");
  if (isPreviewable) return html`<a class="msg__img" href="${href}" target="_blank" rel="noreferrer"><img src="${href}" alt="${file.title || file.name}" loading="lazy" decoding="async">${NEW_TAB_NOTICE}</a>`;
  if (href) return html`<a class="filechip" href="${href}" target="_blank" rel="noreferrer">${icon("paperclip", "i i--12")}${file.name}${NEW_TAB_NOTICE}</a>`;
  return html`<span class="filechip">${icon("paperclip", "i i--12")}${file.name}</span>`;
}

function renderUnfurls(links) {
  const shown = links.filter((link) => link.url && !/slack\.com\/archives/.test(link.url)).slice(0, MAX_UNFURLS);
  if (!shown.length) return "";
  return html`<div class="msg__unfurls">${shown.map(renderUnfurl)}</div>`;
}

function renderUnfurl(link) {
  return html`<a class="unfurl" href="${link.url}" target="_blank" rel="noreferrer">
      <span class="unfurl__host">${shortenUrl(link.url, 36)}</span><span class="unfurl__title">${link.title}</span>${link.desc ? html`<span class="unfurl__desc">${link.desc}</span>` : ""}${NEW_TAB_NOTICE}</a>`;
}

function renderReactions(item) {
  if (!item.reactions?.length) return "";
  return html`<div class="msg__reacts">${item.reactions.slice(0, MAX_REACTIONS).map(renderReaction)}</div>`;
}

function renderReaction(reaction) {
  const glyph = emojiFor(reaction.name.replace(/::skin-tone-\d$/, ""));
  return html`<span class="react" title=":${reaction.name}:">${glyph || html`<span class="react__txt">:${reaction.name}:</span>`}<span class="react__n">${reaction.count}</span></span>`;
}

async function loadReplies(button, box) {
  box.innerHTML = `<p class="muted small">Loading replies…</p>`;
  const [channelId, ts] = button.dataset.thread.split("|");
  try {
    const rows = await getJson(`/api/thread?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(ts)}`);
    const replies = rows.filter((row) => row.ts !== ts).slice(0, MAX_THREAD_REPLIES);
    setHTML(box, html`${renderMessageList(replies, { days: false, thread: false, lines: THREAD_LINES })}`);
    box.dataset.loaded = "1";
    finalizeClamps(box);
  } catch (error) {
    setHTML(box, errorCard(error));
  }
}

function flashReply(box, ts) {
  const reply = box.querySelector(`[data-ts="${CSS.escape(ts)}"]`);
  if (!reply) return;
  reply.classList.add("flash");
  reply.scrollIntoView({ block: "center" });
}
