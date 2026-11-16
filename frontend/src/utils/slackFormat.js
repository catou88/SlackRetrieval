// Slack message text → safe HTML or plain excerpts.
// The ingester already resolved most <…> tokens ("label (url)", "@Name", "#chan") and decoded
// entities, then appended "[files: …]" and "[links: …]" lines. Leftover raw tokens
// (<mailto:…|…>, <#C…>, <!subteam…>) and stray &amp; still appear, so both forms are handled.
// Name lookups are passed in as a resolver so this module never reads app state:
//   { personName(id) → string|null, channelName(id) → string|null }
import { escapeHtml } from "./html.js";
import { emojiFor } from "./emoji.js";

const PLACEHOLDER_OPEN = "\uE000";
const PLACEHOLDER_CLOSE = "\uE001";
const LINKS_MARKER = "[links: ";
const FILES_MARKER = "[files: ";
const DEFAULT_SHORT_URL = 42;
const PLAIN_URL_LENGTH = 30;
// Links to other Slack messages point into the local archive (the workspace will be gone).
const SLACK_MESSAGE_URL_RE = /^https?:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()|"]*[^\s<>()|".,!?;:'’”\]]/g;
const NO_RESOLVER = { personName: () => null, channelName: () => null };

// Inline tokens on raw text, one alternative per kind. Group numbers are listed per line.
const TOKEN_RE = new RegExp([
  /<mailto:([^|>]+)\|([^>]+)>/.source,                       // 1 address, 2 label
  /<#C[A-Z0-9]+\|([^>]+)>/.source,                           // 3 channel name
  /<#C[A-Z0-9]+>/.source,                                    //   unnamed channel
  /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/.source,                 // 4 user id, 5 fallback label
  /<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/.source,              // 6 group label
  /<!(here|channel|everyone)(?:\|[^>]*)?>/.source,           // 7 broadcast
  /<(https?:\/\/[^|>\s]+)\|([^>]+)>/.source,                 // 8 url, 9 label
  /<(https?:\/\/[^>\s]+)>/.source,                           // 10 url
  /(\S+) \((https?:\/\/[^\s)]+)\)/.source,                   // 11 label, 12 url ("label (url)" from the ingester)
  /(https?:\/\/[^\s<>()"]*[^\s<>()".,!?;:'’”])/.source,      // 13 bare url
].join("|"), "g");

/** Shortened display form of a URL ("devpost.com/software/x…"). */
export function shortenUrl(url, maxLength = DEFAULT_SHORT_URL) {
  const display = stripProtocol(decodeEntities(url));
  return display.length > maxLength ? display.slice(0, maxLength - 1) + "…" : display;
}

/** Split off the ingester's trailing "[files: …]" / "[links: …]" lines. */
export function splitMessageExtras(text) {
  let body = String(text || "");
  let links = [];
  let files = [];
  const linksAt = body.lastIndexOf(LINKS_MARKER);
  if (isLineStart(body, linksAt)) {
    links = parseLinks(body.slice(linksAt + LINKS_MARKER.length).replace(/\]\s*$/, ""));
    body = body.slice(0, linksAt);
  }
  const filesAt = body.lastIndexOf(FILES_MARKER);
  if (isLineStart(body, filesAt)) {
    files = body.slice(filesAt + FILES_MARKER.length).replace(/\]\s*$/, "").split(", ").filter(Boolean);
    body = body.slice(0, filesAt);
  }
  return { body: body.replace(/\s+$/, ""), links, files };
}

/** Full block renderer (paragraphs, quotes, lists, code blocks) → HTML string. */
export function slackToHtml(text, resolver = NO_RESOLVER) {
  const kept = [];
  const codeBlocks = [];
  let source = String(text || "").replace(/\r/g, "");
  source = source.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code.replace(/^\n|\n$/g, ""));
    return `\n\uE004${codeBlocks.length - 1}\uE005\n`;
  });
  source = escapeHtml(decodeEntities(tokenize(source, kept, resolver)));
  const blocks = renderBlocks(source.split("\n"), codeBlocks);
  return blocks.replace(/\uE000(\d+)\uE001/g, (_, i) => kept[i]);
}

/** One-line plain-text excerpt (rows, palette, quotes). Escape it on output. */
export function slackToPlainText(text, maxLength = 160, resolver = NO_RESOLVER) {
  const personLabel = (id) => "@" + (resolver.personName(id) || "someone");
  let excerpt = splitMessageExtras(text).body
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id) => personLabel(id))
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1").replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, (_, url) => shortenUrl(url, PLAIN_URL_LENGTH))
    .replace(/(\S+) \((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (isSameTarget(label, url) ? shortenUrl(url, PLAIN_URL_LENGTH) : label))
    .replace(/https?:\/\/\S+/g, (url) => shortenUrl(url, PLAIN_URL_LENGTH))
    .replace(/```/g, "").replace(/[*_~`]/g, "")
    .replace(/:([a-z0-9_+-]+):(?::skin-tone-\d:)?/g, (_, name) => emojiFor(name) || "")
    .replace(/^&gt;\s?|^>\s?/gm, "");
  excerpt = decodeEntities(excerpt).replace(/\s+/g, " ").trim();
  return excerpt.length > maxLength ? excerpt.slice(0, maxLength - 1).trimEnd() + "…" : excerpt;
}

/** URLs in a message for link chips; skips Slack-internal and LinkedIn links (they have their own buttons). */
export function findLinkUrls(text, maxCount = 3) {
  const seen = new Set();
  const urls = [];
  for (const match of String(text || "").matchAll(URL_IN_TEXT_RE)) {
    const url = decodeEntities(match[0]);
    const key = stripProtocol(url).toLowerCase();
    if (seen.has(key) || /slack\.com\/|linkedin\.com\//i.test(url)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= maxCount) break;
  }
  return urls;
}

// ---------- private helpers ----------

const decodeEntities = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripProtocol = (url) => url.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/\/+$/, "");
const isLineStart = (text, index) => index >= 0 && (index === 0 || text[index - 1] === "\n");
const isSameTarget = (label, url) => stripProtocol(label).toLowerCase() === stripProtocol(url).toLowerCase() || /^https?:/.test(label);
// Unfurl text is sometimes double-encoded ("&amp;#39;").
const decodeTwice = (text) => decodeEntities(decodeEntities(text)).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(+code));

function parseLinks(part) {
  return part.split(/(?<=https?:\/\/\S+) \| /).map((segment) => {
    const bits = segment.split(" — ");
    const url = /^https?:\/\//.test(bits[bits.length - 1]) ? bits.pop().trim() : "";
    return { title: decodeTwice(bits[0] || ""), desc: decodeTwice(bits.slice(1).join(" — ")), url };
  }).filter((link) => link.title || link.url);
}

function linkHtml(url, label, resolver) {
  const decoded = decodeEntities(url);
  const slackMessage = decoded.match(SLACK_MESSAGE_URL_RE);
  if (slackMessage) {
    const channelName = resolver.channelName(slackMessage[1]);
    const text = channelName ? `Message in ${channelName}` : "Linked Slack message";
    return `<a class="slacklink" href="#/archive/${slackMessage[1]}?ts=${slackMessage[2]}.${slackMessage[3]}">↪ ${escapeHtml(text)}</a>`;
  }
  return `<a href="${escapeHtml(decoded)}" target="_blank" rel="noreferrer">${escapeHtml(label ?? shortenUrl(url))}<span class="sr"> (opens in new tab)</span></a>`;
}

function personHtml(id, fallback, resolver) {
  return `<a class="mention" href="#/people/${escapeHtml(id)}">@${escapeHtml(resolver.personName(id) || fallback || "someone")}</a>`;
}

// Each token becomes a placeholder holding finished HTML, so later escaping can't touch it.
function tokenize(text, kept, resolver) {
  return text.replace(TOKEN_RE, (match, ...groups) => {
    const tokenHtml = tokenToHtml(match, groups, resolver);
    if (tokenHtml == null) return match;
    kept.push(tokenHtml);
    return PLACEHOLDER_OPEN + (kept.length - 1) + PLACEHOLDER_CLOSE;
  });
}

function tokenToHtml(match, groups, resolver) {
  const [mailto, mailLabel, channelName, userId, userLabel, groupLabel, broadcast, labelledUrl, urlLabel, angleUrl, ingestLabel, ingestUrl, bareUrl] = groups;
  if (mailto) return linkHtml("mailto:" + mailto, decodeEntities(mailLabel), resolver);
  if (channelName) return `<span class="mention">#${escapeHtml(decodeEntities(channelName))}</span>`;
  if (match.startsWith("<#")) return `<span class="mention">#channel</span>`;
  if (userId) return personHtml(userId, userLabel, resolver);
  if (match.startsWith("<!subteam")) return `<span class="mention">${escapeHtml(decodeEntities(groupLabel || "@team"))}</span>`;
  if (broadcast) return `<span class="mention">@${broadcast}</span>`;
  if (labelledUrl) return linkHtml(labelledUrl, decodeEntities(urlLabel), resolver);
  if (angleUrl) return linkHtml(angleUrl, undefined, resolver);
  // Same target twice ("devpost.com/x (http://devpost.com/x)") → one link.
  if (ingestUrl) return isSameTarget(ingestLabel, ingestUrl) ? linkHtml(ingestUrl, undefined, resolver) : `${escapeHtml(decodeEntities(ingestLabel))} ${linkHtml(ingestUrl, undefined, resolver)}`;
  if (bareUrl) return linkHtml(bareUrl, undefined, resolver);
  return null;
}

// Emphasis, strikethrough and emoji on already-escaped text; inline code is protected first.
function formatInlineSlack(text) {
  const codes = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\uE002${codes.length - 1}\uE003`;
  });
  out = out.replace(/(^|[\s(“"'>_~])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;'”"_~<])/g, "$1<b>$2</b>");
  out = out.replace(/(^|[\s(“"'>*~])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,!?:;'”"*~<])/g, "$1<i>$2</i>");
  out = out.replace(/(^|[\s(>*_])~(?=\S)([^~\n]*?\S)~(?=$|[\s).,!?:;*_<])/g, "$1<s>$2</s>");
  out = out.replace(/:([a-z0-9_+-]+):(?::skin-tone-\d:)?/g, (_, name) => {
    const glyph = emojiFor(name);
    return glyph ? `<span class="emo" title=":${name}:">${glyph}</span>` : `<span class="emo-txt">:${name}:</span>`;
  });
  out = out.replace(/::?skin-tone-\d:/g, "");
  return out.replace(/\uE002(\d+)\uE003/g, (_, i) => codes[i]);
}

function renderBlocks(lines, codeBlocks) {
  const out = [];
  const pending = { paragraph: [], list: null, quote: null };
  for (const line of lines) {
    const codeRef = line.match(/^\uE004(\d+)\uE005$/);
    const bullet = line.match(/^\s*(?:•|◦|▪|-|\*)\s+(.*)$/);
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (codeRef) {
      flushAll(out, pending);
      out.push(`<pre>${escapeHtml(decodeEntities(codeBlocks[codeRef[1]]))}</pre>`);
    } else if (bullet && !/^\s*\*[^*\s]/.test(line)) {
      flushParagraph(out, pending);
      if (pending.quote) flushGroups(out, pending);
      (pending.list ||= []).push(bullet[1]);
    } else if (quote) {
      flushParagraph(out, pending);
      if (pending.list) flushGroups(out, pending);
      (pending.quote ||= []).push(quote[1]);
    } else {
      flushGroups(out, pending);
      if (line.trim()) pending.paragraph.push(line);
      else flushParagraph(out, pending);
    }
  }
  flushAll(out, pending);
  return out.join("");
}

function flushParagraph(out, pending) {
  if (pending.paragraph.length) out.push(`<p>${pending.paragraph.map(formatInlineSlack).join("<br>")}</p>`);
  pending.paragraph = [];
}

function flushGroups(out, pending) {
  if (pending.list) out.push(`<ul>${pending.list.map((item) => `<li>${formatInlineSlack(item)}</li>`).join("")}</ul>`);
  if (pending.quote) out.push(`<blockquote>${pending.quote.map(formatInlineSlack).join("<br>")}</blockquote>`);
  pending.list = null;
  pending.quote = null;
}

function flushAll(out, pending) {
  flushParagraph(out, pending);
  flushGroups(out, pending);
}
