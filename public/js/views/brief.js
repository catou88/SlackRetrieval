// Light markdown for Claude output (briefs + Ask). Escapes first; only bold, italics,
// code, headings, lists, links and [n] citations are produced.
import { html, raw, esc, icon } from "../html.js";

export function md(text, { cite } = {}) {
  const lines = esc(String(text || "").replace(/\r/g, "")).split("\n");
  const out = [];
  let list = null, para = [];
  const inl = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,!?:;])/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[(\d{1,2})\]/g, (m, n) => (cite ? `<a class="cite" href="#src-${n}" aria-label="Source ${n}">${n}</a>` : m));
  const flushP = () => { if (para.length) out.push(`<p>${para.map(inl).join("<br>")}</p>`); para = []; };
  const flushL = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inl(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s*#{1,4}\s+(.*)$/))) { flushP(); flushL(); out.push(`<h4>${inl(m[1].replace(/\*\*/g, ""))}</h4>`); continue; }
    if ((m = line.match(/^\s*(?:[-•*]|(\d+)\.)\s+(.*)$/))) {
      flushP();
      const tag = m[1] ? "ol" : "ul";
      if (list && list.tag !== tag) flushL();
      (list ||= { tag, items: [] }).items.push(m[2]);
      continue;
    }
    if (!line.trim()) { flushP(); flushL(); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();
  return out.join("");
}

// Split a brief answer at the "Draft message" heading.
export function splitBrief(answer) {
  const s = String(answer || "");
  const m = s.match(/\*\*Draft message\*\*:?|^#+\s*Draft message.*$/im);
  if (!m) return { brief: s, draft: "" };
  return { brief: s.slice(0, m.index).trim(), draft: s.slice(m.index + m[0].length).trim().replace(/^[:\-\s]+/, "") };
}

export function renderBrief(answer, { copy = false } = {}) {
  const { brief, draft } = splitBrief(answer);
  const paras = brief.split(/\n\s*\n/);
  const first = paras.shift() || "";
  return html`<div class="brief">
    <div class="brief__quote"><div class="brief__lead">${raw(md(first.replace(/^\*\*Brief\*\*:?\s*/i, "")))}</div>${paras.length ? raw(`<div class="brief__rest">${md(paras.join("\n\n"))}</div>`) : ""}</div>
    ${draft ? html`<div class="draft"><div class="draft__head"><span class="eyebrow">Draft message</span>
      ${copy ? html`<button class="btn btn--secondary btn--sm" type="button" data-copy="${draft.replace(/\*\*/g, "")}" data-copy-msg="Copied draft">${icon("copy")}<span class="btn__label">Copy draft</span></button>` : ""}</div>
      <div class="draft__body">${raw(md(draft))}</div></div>` : ""}
  </div>`;
}
