// Person profile: identity header (flippable name-tag badge), action bar (LinkedIn, contacted,
// follow-up), Outreach highlights, Reconnect briefs, Conversation, private Notes and Details.
import { html, rawHtml, icon, NEW_TAB_NOTICE } from "../utils/html.js";
import { formatNumber, formatDate, formatTimeAgo } from "../utils/format.js";
import { findElement, findAllElements, setHTML, debounce, announce } from "../utils/dom.js";
import { nameOf, firstName, linkedInSlug, linkedInSearchUrl, roleChipsOf, roleStripOf, howYouMet, shortChannelName } from "../utils/people.js";
import { parseNote, serializeNote, todayISO, reachedOutLine } from "../utils/noteStatus.js";
import { getJson, postJson } from "../services/api.js";
import { store, teammateOf, loadIntroPosts, saveNote } from "../contexts/appState.js";
import { recentPeople } from "../contexts/preferences.js";
import { previousRoute } from "../contexts/navigation.js";
import { personAvatar } from "../components/avatar.js";
import { roleChip } from "../components/chips.js";
import { renderMessageList, renderMessage, finalizeClamps } from "../components/message.js";
import { emptyState, errorCard } from "../components/states.js";
import { renderBrief } from "../components/brief.js";
import { renderOutreachSection, wireOutreachSection, sortHighlights, shouldShowOutreach } from "../components/outreachSection.js";
import { slackExcerpt } from "../components/slackText.js";

const GOAL_PRESETS = ["Ask for a referral", "Resume review", "Team up next hackathon", "Say thanks"];
// Where "Back" returns to when the user arrived from one of these pages.
const BACK_LABELS = { people: "People", teammates: "Teammates", opportunities: "Opportunities", archive: "Archive", ask: "Ask" };
const CONVERSATION_PAGE_SIZE = 20;
// The server sends at most this many of their channel messages.
const SERVER_MESSAGE_CAP = 300;
const MAX_TALKED_ABOUT = 3;
const MAX_CHANNEL_CHIPS = 12;
const NOTE_SAVE_DELAY_MS = 800;
const SAVED_LABEL_REFRESH_MS = 60000;
const UNDO_VISIBLE_MS = 6000;
const SLOW_BRIEF_MS = 10000;
const HINT_PULSE_MS = 600;

// Set while rendering so the router can title the tab with the person's name.
let currentPersonName = "Person";

/** Document title: the person's name once their profile has loaded. */
export function pageTitle() {
  return currentPersonName;
}

/** Render the profile for person `id` into `root`. @returns {() => void} cleanup that flushes unsaved notes */
export async function renderPage(root, { id }) {
  let data;
  try {
    [data] = await Promise.all([getJson(`/api/person?id=${encodeURIComponent(id)}`, { fresh: true }), loadIntroPosts()]);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    setHTML(root, emptyState({ icon: "users", title: "We couldn't find this person in the archive", actions: html`<a class="btn btn--secondary" href="#/people">Back to People</a>` }));
    return;
  }
  const profile = createProfile(root, id, data);
  currentPersonName = nameOf(profile.person);
  recentPeople.add(id);
  setHTML(root, renderProfile(profile));
  drawConversation(profile);
  wireNotes(profile);
  wireOutreachSection(root, { person: profile.person, highlights: profile.highlights, onLog: (summary) => logReachOut(profile, summary) });
  wireProfileEvents(profile);
  return () => cleanupProfile(profile);
}

// ---------- private helpers ----------

function isNotFound(error) {
  return error?.code === "not_found" || /not found/.test(error?.message || "");
}

function createProfile(root, id, data) {
  // The people-list row wins over the profile row so in-session note edits show.
  const person = { ...data.person, ...(store.peopleById.get(id) || {}) };
  return {
    root,
    id,
    data,
    person,
    status: parseNote(data.note?.body ?? person.note),
    highlights: sortHighlights(data.highlights || []),
    backLink: backLinkFor(previousRoute()),
    isClaudeOn: store.stats.claude,
    conversationTab: data.dms.length ? "dms" : "msgs",
    dmsShown: CONVERSATION_PAGE_SIZE,
    messagesShown: CONVERSATION_PAGE_SIZE,
    noteSave: null,
    savedAt: data.note?.updated_at,
    savedLabelTimer: null,
    undoTimer: null,
  };
}

// Back goes to the list page the user came from; another profile or an unknown page means People.
function backLinkFor(previousHash) {
  const section = previousHash.replace(/^#\/?/, "").split(/[/?]/)[0];
  if (BACK_LABELS[section] && !/^#\/people\/./.test(previousHash)) return { href: previousHash, label: BACK_LABELS[section] };
  if (previousHash === "#/") return { href: "#/", label: "Home" };
  return { href: "#/people", label: "People" };
}

// What you talked about: your latest DMs, or else their most-reacted channel messages.
function talkedAboutMessages(data) {
  if (data.dms.length) return data.dms.slice(-MAX_TALKED_ABOUT).reverse();
  return [...data.messages].sort((a, b) => reactionTotal(b) - reactionTotal(a)).slice(0, MAX_TALKED_ABOUT);
}

function reactionTotal(message) {
  return (message.reactions || []).reduce((total, reaction) => total + reaction.count, 0);
}

function localTimeFor(timezone) {
  if (!timezone) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date());
}

function renderProfile(profile) {
  return html`
    <a class="back" href="${profile.backLink.href}">${icon("arrow-left")}${profile.backLink.label}</a>
    ${renderHeader(profile)}
    ${renderActionBar(profile)}
    <div class="pgrid">
      <div class="pmain">
        ${shouldShowOutreach(profile.person, profile.highlights) ? renderOutreachSection(profile.person, profile.highlights) : ""}
        ${renderReconnect(profile)}
        ${renderConversationSection(profile)}
      </div>
      <aside class="paside">
        ${renderNotesSection(profile)}
        ${renderDetailsSection(profile.person)}
      </aside>
    </div>`;
}

function renderHeader(profile) {
  const { person, status } = profile;
  const teammate = teammateOf(person.id);
  const intro = store.introPostByUserId.get(profile.id);
  return html`<header class="phead">
      <div class="flip" data-flipped="false">
        <article class="badge badge--lg flip__front" data-strip="${roleStripOf(person, teammate)}" ${status.contacted ? rawHtml("data-contacted") : ""}>
          <span class="badge__strip" aria-hidden="true"></span><span class="badge__slot" aria-hidden="true"></span>
          ${personAvatar(person, 96)}
          <div class="badge__chips">${roleChipsOf(person, teammate).map(roleChip)}</div>
          <footer class="badge__meta">${howYouMet(person, teammate)}</footer>
        </article>
        <article class="badge badge--lg flip__back" aria-hidden="true">
          <span class="badge__slot" aria-hidden="true"></span>
          <p class="flip__note" id="flip-note"></p>
          <footer class="badge__meta">${howYouMet(person, teammate)}</footer>
        </article>
      </div>
      <div class="phead__main">
        <h1 class="pname">${nameOf(person)}</h1>
        ${renderIdentityLine(person)}
        <div class="phead__tags">
          <button class="linkbtn" type="button" data-flip aria-pressed="false">${icon("flip", "i i--12")}<span>Flip badge</span></button>
          ${person.role_evidence?.length ? html`<button class="linkbtn" type="button" data-why aria-expanded="false" aria-controls="why">${icon("info", "i i--12")}Why tagged</button>` : ""}
        </div>
        <ul class="why bare" id="why" hidden>${(person.role_evidence || []).map((evidence) => html`<li>${evidence}</li>`)}</ul>
        ${intro ? html`<figure class="intro"><blockquote>${slackExcerpt(intro.text, 220)}</blockquote><figcaption>Their intro · ${shortChannelName(intro.channel)} · ${formatDate(intro.date)}</figcaption></figure>` : ""}
      </div>
    </header>`;
}

function renderIdentityLine(person) {
  const localTime = localTimeFor(person.timezone);
  return html`<p class="phead__line">${[person.title, person.pronouns].filter(Boolean).join(" · ")}${person.title || person.pronouns ? rawHtml('<span class="sep">·</span>') : ""}<span class="mono">@${person.handle}</span>${localTime ? html`<span class="sep">·</span><span class="mono" title="${person.timezone}">${localTime} their time</span>` : ""}</p>`;
}

function renderActionBar(profile) {
  const { person, status } = profile;
  const linkedInUrl = person.linkedin[0];
  const linkedInActions = linkedInUrl
    ? html`<a class="btn btn--li" href="${linkedInUrl}" target="_blank" rel="noreferrer" data-li>${icon("linkedin")}Open LinkedIn${NEW_TAB_NOTICE}</a>
        <button class="btn btn--secondary" type="button" data-copy="${linkedInUrl}" data-copy-msg="Copied LinkedIn link" data-copyli>${icon("copy")}<span class="btn__label">Copy link</span></button>`
    : html`<span class="chip chip--quiet">No LinkedIn shared in Slack</span><a class="btn btn--secondary" href="${linkedInSearchUrl(person)}" target="_blank" rel="noreferrer" data-li>${icon("search")}Search LinkedIn${NEW_TAB_NOTICE}</a>`;
  return html`<div class="actionbar" role="toolbar" aria-label="Actions">
      ${linkedInActions}
      ${person.email ? html`<a class="btn btn--ghost" href="mailto:${person.email}">${icon("mail")}Email</a>` : ""}
      <span class="actionbar__sep" aria-hidden="true"></span>
      <button class="btn btn--secondary" type="button" data-toggle-contacted aria-pressed="${status.contacted}">${icon("check")}<span>${status.contacted ? "Contacted" : "Mark contacted"}</span></button>
      <label class="fu">${icon("calendar")}<span>Follow up</span><input class="input" type="date" id="fu" value="${status.followUp || ""}" min="${todayISO()}"></label>
      <span class="actionbar__undo" id="undo" aria-live="polite"></span>
    </div>`;
}

function renderReconnect(profile) {
  const { data, isClaudeOn } = profile;
  const talkedAbout = talkedAboutMessages(data);
  return html`<section class="psec reconnect" aria-labelledby="h-rc">
          <h2 class="h2" id="h-rc">Reconnect</h2>
          <p class="muted small">What do you want from this conversation? Claude reads your shared messages and writes a brief plus a draft.</p>
          <div class="fchips presets">${GOAL_PRESETS.map((goal) => html`<button class="fchip" type="button" data-preset="${goal}">${goal}</button>`)}</div>
          <form class="rc-form" id="rc-form">
            <label class="sr" for="goal">Goal</label>
            <input class="input" id="goal" placeholder="Or write your own goal…" autocomplete="off">
            <button class="btn btn--primary" type="submit" id="rc-btn" ${isClaudeOn ? "" : rawHtml('aria-disabled="true" aria-describedby="rc-off"')}>${icon("sparkles")}<span>Write brief</span></button>
          </form>
          ${isClaudeOn ? "" : html`<p class="hint" id="rc-off">${icon("info", "i i--12")}Briefs need a Claude API key. Add one to <code>.env</code> and restart.</p>`}
          <div id="rc-out" aria-live="polite"></div>
          ${data.briefs.length ? html`<details class="past"><summary>Past briefs (${data.briefs.length})</summary>${data.briefs.map((brief) => html`<details class="past__one"><summary>${brief.goal || "General"} · ${formatDate(brief.created_at)}</summary>${renderBrief(brief.body)}</details>`)}</details>` : ""}
          ${!isClaudeOn && talkedAbout.length ? html`<div class="talked"><h3 class="eyebrow">Things you talked about</h3><ul class="bare">${talkedAbout.map((message) => html`<li><span class="num faint">${shortChannelName(message.channel)} · ${formatDate(message.date)}</span><p>${slackExcerpt(message.text, 200)}</p></li>`)}</ul></div>` : ""}
        </section>`;
}

function renderConversationSection(profile) {
  const { dms, messages } = profile.data;
  const body = dms.length || messages.length
    ? renderConversationTabs(dms, messages)
    : emptyState({ icon: "message", title: `No messages from ${firstName(profile.person)} in the archive`, body: "They may have only reacted or lurked." });
  return html`<section class="psec psec--conv" aria-labelledby="h-conv">
          <h2 class="h2" id="h-conv">Conversation</h2>
          ${body}
        </section>`;
}

function renderConversationTabs(dms, messages) {
  const dmsTab = dms.length ? html`<button class="tab" role="tab" id="t-dms" data-tab="dms" aria-controls="conv">DMs <span class="num">${dms.length}</span></button>` : "";
  const messagesTab = messages.length ? html`<button class="tab" role="tab" id="t-msgs" data-tab="msgs" aria-controls="conv">Their messages <span class="num">${messages.length}</span></button>` : "";
  return html`<div class="tabs" role="tablist" aria-label="Conversation">
              ${dmsTab}
              ${messagesTab}
            </div><div id="conv" role="tabpanel"></div>`;
}

function renderNotesSection(profile) {
  const updatedAt = profile.data.note?.updated_at;
  return html`<section class="psec psec--notes" aria-labelledby="h-notes">
          <h2 class="h2" id="h-notes"><label for="notes">Notes</label></h2>
          <textarea class="textarea" id="notes" rows="7" placeholder="Where you met, what you talked about, what to follow up on…">${profile.status.text}</textarea>
          <p class="savestate" id="savestate" aria-live="polite">${updatedAt ? `Saved · ${formatTimeAgo(updatedAt)}` : "Private. Saved on this computer."}</p>
        </section>`;
}

function renderDetailsSection(person) {
  return html`<section class="psec psec--det" aria-labelledby="h-det">
          <h2 class="h2" id="h-det">Details</h2>
          <dl class="details">
            ${person.profile_fields.filter((field) => field.value).map((field) => detailRow(field.label || "Profile", field.value))}
            ${person.org ? detailRow("Company", person.org) : ""}
            ${person.linkedin.map((url) => html`<div><dt>LinkedIn</dt><dd><a href="${url}" target="_blank" rel="noreferrer" class="mono">in/${linkedInSlug(url)}${NEW_TAB_NOTICE}</a></dd></div>`)}
            ${(person.other_links || []).map((url) => html`<div><dt>Link</dt><dd><a href="${url}" target="_blank" rel="noreferrer" class="mono">${url.replace(/^https?:\/\/(www\.)?/, "")}${NEW_TAB_NOTICE}</a></dd></div>`)}
            ${person.email ? monoDetailRow("Email", person.email) : ""}
            ${person.timezone ? monoDetailRow("Timezone", person.timezone.replace(/_/g, " ")) : ""}
            ${monoDetailRow("First seen", formatDate(person.first_seen) || "—")}
            ${monoDetailRow("Last seen", formatDate(person.last_seen) || "—")}
            ${monoDetailRow("Activity", `${formatNumber(person.message_count)} msgs · ${formatNumber(person.dm_count)} DMs`)}
          </dl>
          ${renderChannelChips(person.channels)}
        </section>`;
}

function detailRow(label, value) {
  return html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function monoDetailRow(label, value) {
  return html`<div><dt>${label}</dt><dd class="mono">${value}</dd></div>`;
}

function renderChannelChips(channels) {
  if (!channels.length) return "";
  const hiddenCount = channels.length - MAX_CHANNEL_CHIPS;
  return html`<h3 class="eyebrow chan-h">Channels</h3><div class="chanlist">${channels.slice(0, MAX_CHANNEL_CHIPS).map((channel) => html`<span class="chanchip">${shortChannelName(channel)}</span>`)}${hiddenCount > 0 ? html`<span class="chanchip">+${hiddenCount}</span>` : ""}</div>`;
}

// ---------- conversation ----------

function drawConversation(profile) {
  const { root, data } = profile;
  const panel = findElement("#conv", root);
  if (!panel) return;
  for (const tab of findAllElements("[role=tab]", root)) {
    const isSelected = tab.dataset.tab === profile.conversationTab;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }
  panel.setAttribute("aria-labelledby", profile.conversationTab === "dms" ? "t-dms" : "t-msgs");
  setHTML(panel, profile.conversationTab === "dms" ? renderDirectMessages(data.dms, profile.dmsShown) : renderTheirMessages(data.messages, profile.messagesShown));
  finalizeClamps(panel);
}

// DMs read top to bottom like a chat, so "earlier" pages are added above the newest ones.
function renderDirectMessages(dms, shownCount) {
  const start = Math.max(0, dms.length - shownCount);
  return html`${start > 0 ? html`<div class="showmore showmore--top"><button class="btn btn--ghost" type="button" data-earlier>Show ${Math.min(CONVERSATION_PAGE_SIZE, start)} earlier</button></div>` : ""}
        <div class="msgs">${renderMessageList(dms.slice(start), { noChips: true })}</div>`;
}

function renderTheirMessages(messages, shownCount) {
  return html`<div class="msgs">${messages.slice(0, shownCount).map((message) => renderMessage(message, { channel: true, noChips: true }))}</div>
        ${shownCount < messages.length ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more>Show 20 more</button></div>` : ""}
        ${messages.length === SERVER_MESSAGE_CAP && shownCount >= SERVER_MESSAGE_CAP ? html`<p class="faint small center">Showing their latest 300 messages.</p>` : ""}`;
}

// ---------- notes and contact status ----------

function wireNotes(profile) {
  const { root } = profile;
  const notesInput = findElement("#notes", root);
  const saveState = findElement("#savestate", root);
  profile.notesInput = notesInput;
  profile.saveState = saveState;
  syncBadgeWithStatus(profile);
  profile.savedLabelTimer = setInterval(() => {
    if (profile.savedAt && /^Saved/.test(saveState.textContent)) saveState.textContent = `Saved · ${formatTimeAgo(profile.savedAt)}`;
  }, SAVED_LABEL_REFRESH_MS);
  const saveAfterTyping = debounce(() => {
    profile.status.text = notesInput.value;
    persistStatus(profile);
  }, NOTE_SAVE_DELAY_MS);
  notesInput.addEventListener("input", saveAfterTyping);
  notesInput.addEventListener("blur", () => {
    if (notesInput.value === profile.status.text) return;
    saveAfterTyping.cancel();
    profile.status.text = notesInput.value;
    persistStatus(profile);
  });
  findElement("#fu", root).addEventListener("change", (event) => {
    profile.status.followUp = event.target.value || null;
    persistStatus(profile);
    announce(profile.status.followUp ? `Follow-up set for ${profile.status.followUp}` : "Follow-up cleared");
  });
}

function showSaveState(profile, state) {
  const { saveState } = profile;
  if (state === "saving") saveState.textContent = "Saving…";
  if (state === "saved") {
    profile.savedAt = new Date().toISOString();
    saveState.textContent = "Saved · just now";
  }
  if (state === "error") setHTML(saveState, html`<span class="due-txt">Not saved.</span> <button class="linkbtn" type="button" data-retry-save>Retry</button>`);
}

function persistStatus(profile) {
  profile.noteSave = saveNote(profile.id, serializeNote(profile.status), (state) => showSaveState(profile, state));
  syncBadgeWithStatus(profile);
}

// The badge front shows the contacted state; its back shows the note, like a real name tag.
function syncBadgeWithStatus(profile) {
  const { root, status } = profile;
  findElement(".flip__front", root).toggleAttribute("data-contacted", status.contacted);
  findElement("#flip-note", root).textContent = status.text.trim() || `No note yet. Write one under Notes and it shows up here, like the back of a real name tag.`;
}

function syncContactedButton(profile) {
  const button = findElement("[data-toggle-contacted]", profile.root);
  button.setAttribute("aria-pressed", String(profile.status.contacted));
  button.querySelector("span").textContent = profile.status.contacted ? "Contacted" : "Mark contacted";
}

function toggleContacted(profile) {
  const previousStatus = { ...profile.status };
  profile.status.contacted = !profile.status.contacted;
  profile.status.contactedOn = profile.status.contacted ? todayISO() : null;
  persistStatus(profile);
  syncContactedButton(profile);
  const undoArea = findElement("#undo", profile.root);
  setHTML(undoArea, html`${profile.status.contacted ? "Marked contacted" : "Unmarked"} · <button class="linkbtn" type="button" data-undo>Undo</button>`);
  clearTimeout(profile.undoTimer);
  profile.undoTimer = setTimeout(() => (undoArea.textContent = ""), UNDO_VISIBLE_MS);
  undoArea.dataset.prev = JSON.stringify(previousStatus);
}

function undoContactedToggle(profile) {
  const undoArea = findElement("#undo", profile.root);
  profile.status = JSON.parse(undoArea.dataset.prev);
  persistStatus(profile);
  syncContactedButton(profile);
  undoArea.textContent = "Undone";
}

// Logging uses the @status convention: mark contacted (keeping an earlier date) + a dated note line.
function logReachOut(profile, summary) {
  const { status } = profile;
  status.contacted = true;
  status.contactedOn ||= todayISO();
  status.text = [status.text.trimEnd(), reachedOutLine(summary)].filter(Boolean).join("\n");
  profile.notesInput.value = status.text;
  persistStatus(profile);
  syncContactedButton(profile);
}

// ---------- reconnect brief ----------

async function writeBrief(profile) {
  const { root } = profile;
  if (!profile.isClaudeOn) {
    pulseClaudeOffHint(root);
    return;
  }
  const button = findElement("#rc-btn", root);
  const buttonLabel = button.querySelector("span");
  const goal = findElement("#goal", root).value.trim();
  button.setAttribute("aria-disabled", "true");
  buttonLabel.textContent = "Writing…";
  button.classList.add("is-busy");
  const slowNotice = setTimeout(() => (buttonLabel.textContent = "Still working. Claude can take about 20 seconds."), SLOW_BRIEF_MS);
  const output = findElement("#rc-out", root);
  try {
    const { answer } = await postJson("/api/brief", { person: profile.id, goal });
    setHTML(output, renderBrief(answer, { copy: true }));
    announce("Brief ready");
  } catch (error) {
    setHTML(output, errorCard(error, "brief"));
  }
  clearTimeout(slowNotice);
  button.removeAttribute("aria-disabled");
  button.classList.remove("is-busy");
  buttonLabel.textContent = "Write brief";
}

// Draws the eye to why the button does nothing when Claude is off.
function pulseClaudeOffHint(root) {
  findElement("#rc-off", root)?.classList.add("hint--pulse");
  setTimeout(() => findElement("#rc-off", root)?.classList.remove("hint--pulse"), HINT_PULSE_MS);
}

// ---------- events ----------

function wireProfileEvents(profile) {
  const { root } = profile;
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    writeBrief(profile);
  });
  root.addEventListener("click", (event) => handleProfileClick(event.target, profile));
  root.addEventListener("keydown", (event) => handleTabArrowKeys(event, profile));
  root.addEventListener("viewkey", ({ detail: event }) => handleProfileShortcut(event, profile));
}

function handleProfileClick(target, profile) {
  const { root } = profile;
  const presetButton = target.closest("[data-preset]");
  if (presetButton) {
    findElement("#goal", root).value = presetButton.dataset.preset;
    findElement("#goal", root).focus();
  }
  const tabButton = target.closest("[data-tab]");
  if (tabButton) {
    profile.conversationTab = tabButton.dataset.tab;
    drawConversation(profile);
  }
  if (target.closest("[data-earlier]")) {
    profile.dmsShown += CONVERSATION_PAGE_SIZE;
    drawConversation(profile);
  }
  if (target.closest("[data-more]")) {
    profile.messagesShown += CONVERSATION_PAGE_SIZE;
    drawConversation(profile);
  }
  if (target.closest("[data-toggle-contacted]")) toggleContacted(profile);
  if (target.closest("[data-undo]")) undoContactedToggle(profile);
  if (target.closest("[data-retry-save]")) profile.noteSave?.retry();
  if (target.closest("[data-action=brief]")) writeBrief(profile);
  const whyButton = target.closest("[data-why]");
  if (whyButton) toggleWhyTagged(whyButton, root);
  const flipButton = target.closest("[data-flip]");
  if (flipButton) flipBadge(flipButton, root);
}

function toggleWhyTagged(button, root) {
  const isOpen = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!isOpen));
  findElement("#why", root).hidden = isOpen;
}

function flipBadge(button, root) {
  const isFlipped = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(isFlipped));
  button.querySelector("span").textContent = isFlipped ? "Flip back" : "Flip badge";
  findElement(".flip", root).dataset.flipped = String(isFlipped);
  findElement(".flip__back", root).setAttribute("aria-hidden", String(!isFlipped));
  findElement(".flip__front", root).setAttribute("aria-hidden", String(isFlipped));
}

function handleTabArrowKeys(event, profile) {
  const tab = event.target.closest("[role=tab]");
  if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
  const tabs = findAllElements("[role=tab]", profile.root);
  const step = event.key === "ArrowRight" ? 1 : -1;
  const nextTab = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
  profile.conversationTab = nextTab.dataset.tab;
  drawConversation(profile);
  nextTab.focus();
}

// L opens LinkedIn, C copies it, X toggles contacted, Esc goes back (see the shortcuts dialog).
function handleProfileShortcut(event, profile) {
  const { root } = profile;
  const key = event.key.toLowerCase();
  if (key === "l") findElement("[data-li]", root)?.click();
  else if (key === "c" && profile.person.linkedin[0]) findElement("[data-copyli]", root)?.click();
  else if (key === "x") toggleContacted(profile);
  else if (event.key === "Escape") location.hash = profile.backLink.href;
}

// Leaving the page mid-typing still saves what was typed (the debounce may not have fired).
function cleanupProfile(profile) {
  clearInterval(profile.savedLabelTimer);
  clearTimeout(profile.undoTimer);
  if (profile.notesInput.value !== profile.status.text) {
    profile.status.text = profile.notesInput.value;
    saveNote(profile.id, serializeNote(profile.status));
  }
}
