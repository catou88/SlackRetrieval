// Profile "Outreach" section: a mentor/judge/sponsor's original messages offering to connect,
// review resumes, refer, etc. (shown in full), plus a template draft that needs no API key.
import { html, rawHtml, icon, NEW_TAB_NOTICE } from "../utils/html.js";
import { formatDate, pluralize } from "../utils/format.js";
import { findElement, findAllElements, setHTML, announce } from "../utils/dom.js";
import { nameOf, firstName, shortChannelName, linkedInSearchUrl } from "../utils/people.js";
import { splitMessageExtras } from "../utils/slackFormat.js";
import { copyText } from "../services/clipboard.js";
import { roleFor } from "../contexts/appState.js";
import { preferences } from "../contexts/preferences.js";
import { archiveLinkFor, messageAttachments } from "./message.js";
import { emptyState } from "./states.js";
import { renderSlackText, slackExcerpt } from "./slackText.js";

// Highlight categories in display priority: offers and LinkedIn shares come first.
const HIGHLIGHT_KINDS = {
  offer: { label: "Offer", chipClass: "tint-mentor", order: 0 },
  linkedin: { label: "LinkedIn", chipClass: "chip--li", order: 1 },
  mentor_intro: { label: "Intro", chipClass: "chip--quiet", order: 2 },
  sponsor_opportunity: { label: "Opportunity", chipClass: "chip--quiet tint-sponsor", order: 3 },
  mention: { label: "Mention", chipClass: "chip--quiet", order: 4 },
};
// Keyword rules for what someone offered. Order matters: the first match is the primary offer
// (a "DM me your resume" post is a resume offer, not generic advice).
const OFFER_RULES = [
  { id: "resume", label: "resume", pattern: /\bresumes?\b|résumé|\bcv\b/i, summary: "look over resumes", ask: "resume" },
  { id: "referral", label: "referral", pattern: /\brefer(r(al|als|ing))?\b/i, summary: "refer people", ask: "referral" },
  { id: "interview", label: "mock interviews", pattern: /mock interviews?|interview prep/i, summary: "help with interview prep", ask: "advice" },
  { id: "mentorship", label: "mentorship", pattern: /\bmentor(ing|ship)\b/i, summary: "mentor people", ask: "advice" },
  { id: "coffee", label: "coffee chat", pattern: /coffee|calendly|grab (some )?time|hop on a call|\bchat\b/i, summary: "chat", ask: "coffee" },
  { id: "advice", label: "advice", pattern: /\badvice\b|ask me|feedback|happy to help|help (with|you|out)|\bdm me\b|reach out|ping me|questions?/i, summary: "help with questions and advice", ask: "advice" },
  { id: "hiring", label: "hiring", pattern: /\bhiring\b|\bintern(s|ship|ships)?\b|new grads?|open roles?|\bapply\b|recruit/i, summary: "talk about open roles", ask: "referral" },
  { id: "connect", label: "connect", pattern: /linkedin\.com\/in\/|\bconnect\b/i, summary: "connect", ask: "stay" },
];
const ASK_LABELS = { resume: "Resume review", coffee: "Coffee chat", advice: "Career advice", referral: "Referral", stay: "Stay in touch" };
const LINKEDIN_PROFILE_RE = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s|>)]+/i;
const INITIAL_SHOWN = 8;
// Filter chips only help once there are more highlights than fit on a screen.
const FILTER_MIN = 5;
const NO_KIND_RANK = 9;
const FULL_QUOTE_LENGTH = 1e5;
const MY_NAME_PREFERENCE = "myName";

/** Should this profile get the Outreach section? Helpers always do; anyone else only with highlights. */
export function shouldShowOutreach(person, highlights) {
  const role = roleFor(person);
  return highlights.length > 0 || role.mentor || role.judge || role.likely || role.sponsor || role.organizer;
}

/**
 * Offers first, then LinkedIn, intros, opportunities, keyword mentions; within a rank, posts that
 * are both an offer and a LinkedIn share first, then newest.
 */
export function sortHighlights(highlights) {
  return [...highlights].sort((a, b) => kindRank(a) - kindRank(b) || strongKindCount(b) - strongKindCount(a) || +b.ts - +a.ts);
}

/** Section markup; the list itself is filled by wireOutreachSection(). */
export function renderOutreachSection(person, highlights) {
  const first = firstName(person);
  const body = highlights.length
    ? renderHighlightListShell(highlights, first)
    : emptyState({ icon: "handshake", title: `No offers or LinkedIn shares from ${first} in the archive`, body: "You can still reach out: search LinkedIn above, or write a brief under Reconnect." });
  return html`<section class="psec outreach" aria-labelledby="h-out">
    <p class="eyebrow">Outreach</p>
    <h2 class="h2" id="h-out">How ${first} offered to help</h2>
    ${body}
  </section>`;
}

/**
 * Fill and wire the section: filters, show more, drafts, copy and logging.
 * @param {HTMLElement} root  the profile page
 * @param {{person: object, highlights: object[], onLog: (summary: string) => void}} context  highlights already sorted
 */
export function wireOutreachSection(root, { person, highlights, onLog }) {
  const list = findElement("#hl-list", root);
  if (!list) return;
  const section = { root, list, person, highlights, onLog, filter: "", isShowingAll: false };
  drawHighlightList(section);
  root.addEventListener("click", (event) => handleOutreachClick(event, section));
  root.addEventListener("change", (event) => {
    const draftBox = event.target.closest(".hl__draft");
    if (!draftBox || !event.target.matches("[data-ask]")) return;
    rewriteDraft(draftBox, section);
    findElement(".odraft__status", draftBox).textContent = "Draft rewritten.";
  });
  root.addEventListener("input", (event) => {
    const draftBox = event.target.closest(".hl__draft");
    if (!draftBox || !event.target.matches("[data-me]")) return;
    preferences.set(MY_NAME_PREFERENCE, event.target.value.trim());
    rewriteDraft(draftBox, section);
  });
}

// ---------- private helpers ----------

// Collections arrive as plain keys ("offer") or, from newer servers, as {key, confidence, …}.
function kindsOf(message) {
  return (message.collections || []).map((collection) => collection?.key ?? collection).filter((key) => HIGHLIGHT_KINDS[key]);
}

function kindRank(message) {
  return Math.min(...kindsOf(message).map((key) => HIGHLIGHT_KINDS[key].order), NO_KIND_RANK);
}

function strongKindCount(message) {
  return kindsOf(message).filter((key) => key === "offer" || key === "linkedin").length;
}

function draftIndexOf(draftBox) {
  return +draftBox.id.replace("hl-d-", "");
}

/** What a message offers. @returns {{primary: object|null, all: object[]}} */
function detectOffer(text) {
  const body = splitMessageExtras(text).body;
  const matches = OFFER_RULES.filter((rule) => rule.pattern.test(body));
  return { primary: matches[0] || null, all: matches };
}

// "connect" only says they shared a profile, so it is not a concrete offer to build a draft around.
function concreteOfferOf(message) {
  const offer = detectOffer(message.text).primary;
  return offer && offer.id !== "connect" ? offer : null;
}

// Plain-text quote with line breaks kept, ready for the clipboard.
function quoteForClipboard(message, person) {
  const lines = splitMessageExtras(message.text).body.split("\n").map((line) => slackExcerpt(line, FULL_QUOTE_LENGTH));
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return `“${body}”\n— ${nameOf(person)}, ${shortChannelName(message.channel)}, ${formatDate(message.date)}`;
}

// Editable outreach template that references their original message.
function templateDraft(person, message, ask, myName) {
  const signature = myName?.trim() || "[your name]";
  const org = person.org || "";
  const askLines = {
    resume: `I'd love to take you up on that. Would you be open to looking over my resume? I'm applying for [type of role] roles and would really value your eyes on it.`,
    coffee: `Would you be up for a quick 15-minute coffee chat in the next couple of weeks? I'd love to hear more about your work${org ? ` at ${org}` : ""}.`,
    advice: `I'd really value your advice on [your question]. Even a couple of lines would mean a lot.`,
    referral: `I'm applying for [role] at ${org || "[company]"} and wondered if you'd be open to referring me. I'm happy to send my resume and a short summary.`,
    stay: `I'd love to stay in touch and follow what you're working on.`,
  };
  const opening = `Hi ${firstName(person)}, I'm ${signature}. We were both at Cal Hacks 13.0. ${referenceLine(person, message)}`;
  return `${opening}\n\n${askLines[ask] || askLines.stay}\n\nThanks so much!\n${signature}`;
}

// The sentence that ties the draft to what they actually posted.
function referenceLine(person, message) {
  const channel = shortChannelName(message.channel);
  const org = person.org || "";
  const offer = concreteOfferOf(message);
  const kinds = kindsOf(message);
  const isOfferPost = kinds.includes("offer") || kinds.includes("mention");
  if (offer && isOfferPost) return `You mentioned in ${channel} that you were happy to ${offer.summary}.`;
  if (kinds.includes("linkedin")) return `You shared your LinkedIn in ${channel}, so I wanted to reach out and connect.`;
  if (kinds.includes("sponsor_opportunity")) return `I saw your post in ${channel}${org ? ` about ${org}` : ""}.`;
  if (kinds.includes("mentor_intro")) return `I saw your intro in ${channel}${org ? ` and your work at ${org}` : ""}.`;
  return `I saw your message in ${channel}.`;
}

// Pick the ask that matches their offer, so the first draft is usually right.
function defaultAskFor(message) {
  const offer = concreteOfferOf(message);
  const kinds = kindsOf(message);
  if (offer) return offer.ask;
  if (kinds.includes("sponsor_opportunity")) return "referral";
  if (kinds.includes("mentor_intro")) return "coffee";
  return "stay";
}

function renderKindChips(message) {
  const offer = concreteOfferOf(message);
  return kindsOf(message).sort((a, b) => HIGHLIGHT_KINDS[a].order - HIGHLIGHT_KINDS[b].order).map((key) => {
    const offerSuffix = offer && (key === "offer" || key === "mention") ? `: ${offer.label}` : "";
    return html`<span class="chip ${HIGHLIGHT_KINDS[key].chipClass}">${key === "linkedin" ? icon("linkedin", "i i--12") : ""}${HIGHLIGHT_KINDS[key].label}${offerSuffix}</span>`;
  });
}

function renderHighlightListShell(highlights, first) {
  const filters = highlights.length > FILTER_MIN ? renderFilters(highlights) : "";
  return html`<p class="muted small outreach__lede">${pluralize(highlights.length, "original message")} where ${first} offered help, shared LinkedIn or posted an opportunity. Offers and LinkedIn shares come first.</p>
      ${filters}
      <ol class="bare hl-list" id="hl-list"></ol>
      <div class="showmore" id="hl-more" hidden><button class="btn btn--secondary" type="button" data-hl-more></button></div>`;
}

function renderFilters(highlights) {
  const counts = {};
  for (const message of highlights) for (const key of kindsOf(message)) counts[key] = (counts[key] || 0) + 1;
  return html`<div class="fchips outreach__filters" role="group" aria-label="Filter by category">
    <button class="fchip" type="button" data-hlf="" aria-pressed="true">All<span class="num">${highlights.length}</span></button>
    ${Object.keys(HIGHLIGHT_KINDS).filter((key) => counts[key]).map((key) => html`<button class="fchip" type="button" data-hlf="${key}" aria-pressed="false">${HIGHLIGHT_KINDS[key].label}<span class="num">${counts[key]}</span></button>`)}
  </div>`;
}

function renderHighlight(message, index, person) {
  const label = `${kindsOf(message).map((key) => HIGHLIGHT_KINDS[key].label).join(", ")} · ${shortChannelName(message.channel)} · ${formatDate(message.date)}`;
  const body = splitMessageExtras(message.text).body;
  return html`<li class="hl">
    <article aria-labelledby="hl-h-${index}">
      <h3 class="sr" id="hl-h-${index}">${label}</h3>
      <header class="hl__head">
        <span class="hl__chips">${renderKindChips(message)}</span>
        <span class="hl__meta num">${shortChannelName(message.channel)}${message.in_thread ? rawHtml('<span class="sep">·</span>in a thread') : ""}<span class="sep">·</span><time datetime="${message.date}">${formatDate(message.date)}</time></span>
      </header>
      ${body ? html`<div class="msg__text hl__text">${rawHtml(renderSlackText(body))}</div>` : ""}
      ${messageAttachments(message)}
      <footer class="hl__foot">
        <button class="btn btn--secondary btn--sm" type="button" data-draft="${index}" aria-expanded="false" aria-controls="hl-d-${index}">${icon("mail")}Draft a message</button>
        <button class="btn btn--ghost btn--sm" type="button" data-copy="${quoteForClipboard(message, person)}" data-copy-msg="Copied quote">${icon("copy")}<span class="btn__label">Copy quote</span></button>
        <a class="linkbtn hl__view" href="${archiveLinkFor(message)}">${icon("message", "i i--12")}${message.in_thread ? "View in thread" : "View in archive"}</a>
      </footer>
      <div class="hl__draft" id="hl-d-${index}" hidden></div>
    </article>
  </li>`;
}

function renderLinkedInButton(person, message) {
  const url = person.linkedin?.[0] || splitMessageExtras(message.text).body.match(LINKEDIN_PROFILE_RE)?.[0];
  if (url) return html`<a class="btn btn--li btn--sm" href="${url}" target="_blank" rel="noreferrer">${icon("linkedin")}Open LinkedIn${NEW_TAB_NOTICE}</a>`;
  return html`<a class="btn btn--secondary btn--sm" href="${linkedInSearchUrl(person)}" target="_blank" rel="noreferrer">${icon("search")}Search LinkedIn${NEW_TAB_NOTICE}</a>`;
}

function renderDraftEditor(person, message, index) {
  const ask = defaultAskFor(message);
  const myName = preferences.get(MY_NAME_PREFERENCE, "");
  return html`<div class="odraft">
    <div class="odraft__row">
      <label class="odraft__f"><span>Ask for</span><select class="select" data-ask>${Object.entries(ASK_LABELS).map(([key, label]) => html`<option value="${key}" ${key === ask ? "selected" : ""}>${label}</option>`)}</select></label>
      <label class="odraft__f"><span>Your name</span><input class="input" data-me value="${myName}" placeholder="Your name" autocomplete="name"></label>
    </div>
    <label class="sr" for="hl-t-${index}">Message to ${nameOf(person)}</label>
    <textarea class="textarea odraft__text" id="hl-t-${index}" rows="8" data-dtext>${templateDraft(person, message, ask, myName)}</textarea>
    <div class="odraft__bar">
      <button class="btn btn--primary btn--sm" type="button" data-dcopy>${icon("copy")}<span>Copy message</span></button>
      ${renderLinkedInButton(person, message)}
      <button class="btn btn--ghost btn--sm" type="button" data-dlog>${icon("check")}Log “reached out” in notes</button>
      <span class="odraft__status" aria-live="polite"></span>
    </div>
    <p class="faint small">A template from their message. Fill in the [brackets] and make it yours before sending.</p>
  </div>`;
}

// [message, originalIndex] pairs passing the current filter; the index keeps draft ids stable.
function visibleHighlights(section) {
  return section.highlights
    .map((message, index) => [message, index])
    .filter(([message]) => !section.filter || kindsOf(message).includes(section.filter));
}

function drawHighlightList(section) {
  const visible = visibleHighlights(section);
  const shown = section.isShowingAll ? visible : visible.slice(0, INITIAL_SHOWN);
  setHTML(section.list, html`${shown.map(([message, index]) => renderHighlight(message, index, section.person))}`);
  const showMore = findElement("#hl-more", section.root);
  showMore.hidden = visible.length <= INITIAL_SHOWN;
  showMore.firstElementChild.textContent = section.isShowingAll ? "Show fewer" : `Show all ${visible.length}`;
  for (const button of findAllElements("[data-hlf]", section.root)) button.setAttribute("aria-pressed", String(button.dataset.hlf === section.filter));
}

function handleOutreachClick(event, section) {
  const filterButton = event.target.closest("[data-hlf]");
  if (filterButton) {
    section.filter = filterButton.dataset.hlf;
    section.isShowingAll = false;
    drawHighlightList(section);
    announce(`Showing ${pluralize(visibleHighlights(section).length, "message")}`);
    return;
  }
  if (event.target.closest("[data-hl-more]")) {
    section.isShowingAll = !section.isShowingAll;
    drawHighlightList(section);
    return;
  }
  const draftButton = event.target.closest("[data-draft]");
  if (draftButton) {
    toggleDraft(section, draftButton);
    return;
  }
  const draftBox = event.target.closest(".hl__draft");
  if (draftBox) handleDraftClick(event.target, draftBox, section);
}

// One draft open at a time; opening another closes the previous one.
function toggleDraft(section, button) {
  const wasOpen = button.getAttribute("aria-expanded") === "true";
  for (const openButton of findAllElements("[data-draft][aria-expanded=true]", section.root)) {
    openButton.setAttribute("aria-expanded", "false");
    findElement(`#hl-d-${openButton.dataset.draft}`, section.root).hidden = true;
  }
  if (wasOpen) return;
  const index = +button.dataset.draft;
  const draftBox = findElement(`#hl-d-${index}`, section.root);
  button.setAttribute("aria-expanded", "true");
  draftBox.hidden = false;
  setHTML(draftBox, renderDraftEditor(section.person, section.highlights[index], index));
  findElement("[data-dtext]", draftBox).focus({ preventScroll: true });
}

async function handleDraftClick(target, draftBox, section) {
  const status = findElement(".odraft__status", draftBox);
  const textarea = findElement("[data-dtext]", draftBox);
  if (target.closest("[data-dcopy]")) {
    const isCopied = await copyText(textarea.value);
    status.textContent = isCopied ? "Copied. Paste it into LinkedIn or email." : "Press Ctrl+C to copy";
    if (!isCopied) textarea.select();
  }
  if (target.closest("[data-dlog]")) {
    const message = section.highlights[draftIndexOf(draftBox)];
    const askLabel = ASK_LABELS[findElement("[data-ask]", draftBox).value];
    section.onLog(`${askLabel} re: their ${shortChannelName(message.channel)} message (${formatDate(message.date)})`);
    status.textContent = "Logged in Notes and marked contacted.";
  }
}

// Rewrites the draft when the ask or name changes (the template is the source of truth until copied).
function rewriteDraft(draftBox, section) {
  const message = section.highlights[draftIndexOf(draftBox)];
  findElement("[data-dtext]", draftBox).value = templateDraft(section.person, message, findElement("[data-ask]", draftBox).value, findElement("[data-me]", draftBox).value);
}
