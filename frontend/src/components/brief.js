// A Claude reconnect brief: the lead paragraph as a pull quote, the rest muted, and the
// "Draft message" part (if any) split into its own copyable card.
import { html, rawHtml, icon } from "../utils/html.js";
import { renderMarkdown } from "../utils/markdown.js";

const DRAFT_HEADING_RE = /\*\*Draft message\*\*:?|^#+\s*Draft message.*$/im;

/** Split a brief answer at its "Draft message" heading. @returns {{brief: string, draft: string}} */
export function splitBrief(answer) {
  const text = String(answer || "");
  const heading = text.match(DRAFT_HEADING_RE);
  if (!heading) return { brief: text, draft: "" };
  const draft = text.slice(heading.index + heading[0].length).trim().replace(/^[:\-\s]+/, "");
  return { brief: text.slice(0, heading.index).trim(), draft };
}

/** Brief markup. `copy` adds a Copy draft button to the draft card. */
export function renderBrief(answer, { copy = false } = {}) {
  const { brief, draft } = splitBrief(answer);
  const paragraphs = brief.split(/\n\s*\n/);
  const lead = (paragraphs.shift() || "").replace(/^\*\*Brief\*\*:?\s*/i, "");
  const rest = paragraphs.length ? rawHtml(`<div class="brief__rest">${renderMarkdown(paragraphs.join("\n\n"))}</div>`) : "";
  return html`<div class="brief">
    <div class="brief__quote"><div class="brief__lead">${rawHtml(renderMarkdown(lead))}</div>${rest}</div>
    ${draft ? renderDraftCard(draft, copy) : ""}
  </div>`;
}

// ---------- private helpers ----------

function renderDraftCard(draft, hasCopyButton) {
  const copyButton = hasCopyButton
    ? html`<button class="btn btn--secondary btn--sm" type="button" data-copy="${draft.replace(/\*\*/g, "")}" data-copy-msg="Copied draft">${icon("copy")}<span class="btn__label">Copy draft</span></button>`
    : "";
  return html`<div class="draft"><div class="draft__head"><span class="eyebrow">Draft message</span>${copyButton}</div>
    <div class="draft__body">${rawHtml(renderMarkdown(draft))}</div></div>`;
}
