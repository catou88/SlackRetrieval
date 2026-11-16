// Light markdown for Claude output (briefs and Ask). The text is escaped first, so only the
// markup produced here can appear: bold, italics, code, headings, lists, links and [n] citations.
import { escapeHtml } from "./html.js";

const HEADING_RE = /^\s*#{1,4}\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-•*]|(\d+)\.)\s+(.*)$/;

/**
 * Markdown → HTML string.
 * @param {string} text
 * @param {{cite?: boolean}} [options]  cite turns "[3]" into a link to #src-3
 */
export function renderMarkdown(text, { cite = false } = {}) {
  const lines = escapeHtml(String(text || "").replace(/\r/g, "")).split("\n");
  const out = [];
  const pending = { paragraph: [], list: null };
  const formatInline = (line) => formatInlineMarkdown(line, cite);
  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    const item = line.match(LIST_ITEM_RE);
    if (heading) {
      flushParagraph(out, pending, formatInline);
      flushList(out, pending, formatInline);
      out.push(`<h4>${formatInline(heading[1].replace(/\*\*/g, ""))}</h4>`);
    } else if (item) {
      addListItem(out, pending, item, formatInline);
    } else if (!line.trim()) {
      flushParagraph(out, pending, formatInline);
      flushList(out, pending, formatInline);
    } else {
      flushList(out, pending, formatInline);
      pending.paragraph.push(line);
    }
  }
  flushParagraph(out, pending, formatInline);
  flushList(out, pending, formatInline);
  return out.join("");
}

// ---------- private helpers ----------

function formatInlineMarkdown(line, cite) {
  return line
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,!?:;])/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[(\d{1,2})\]/g, (match, n) => (cite ? `<a class="cite" href="#src-${n}" aria-label="Source ${n}">${n}</a>` : match));
}

function addListItem(out, pending, item, formatInline) {
  flushParagraph(out, pending, formatInline);
  const tag = item[1] ? "ol" : "ul";
  if (pending.list && pending.list.tag !== tag) flushList(out, pending, formatInline);
  (pending.list ||= { tag, items: [] }).items.push(item[2]);
}

function flushParagraph(out, pending, formatInline) {
  if (pending.paragraph.length) out.push(`<p>${pending.paragraph.map(formatInline).join("<br>")}</p>`);
  pending.paragraph = [];
}

function flushList(out, pending, formatInline) {
  if (pending.list) out.push(`<${pending.list.tag}>${pending.list.items.map((item) => `<li>${formatInline(item)}</li>`).join("")}</${pending.list.tag}>`);
  pending.list = null;
}
