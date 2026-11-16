// Home: "Before access ends" export ribbon → title → follow-ups due → three lanes (mentors,
// sponsors, teammates) → hero badges → offers of help.
import { html, icon } from "../utils/html.js";
import { formatNumber, formatDate, formatIsoDate } from "../utils/format.js";
import { setHTML } from "../utils/dom.js";
import { nameOf, companyOf, subtitleOf, howYouMet } from "../utils/people.js";
import { noteStatusOf } from "../utils/noteStatus.js";
import { getJson } from "../services/api.js";
import { exportPeople, copyAllLinkedIns, lastExportLabel } from "../services/contactExport.js";
import { store, teammateOf } from "../contexts/appState.js";
import { personAvatar } from "../components/avatar.js";
import { roleChips } from "../components/chips.js";
import { nameTagBadge, miniPersonRow } from "../components/personCards.js";
import { emptyState, commandSnippet, metaLine } from "../components/states.js";
import { slackExcerpt } from "../components/slackText.js";

const MAX_FOLLOW_UPS = 6;
const MAX_LANE_MENTORS = 4;
const MAX_LANE_SPONSOR_POSTS = 3;
const MAX_LANE_TEAMMATES = 5;
const MAX_HERO_BADGES = 6;
const MAX_OFFERS = 3;
const COPY_ALL_FEEDBACK_MS = 1800;

/** Document title for Home. */
export function pageTitle() {
  return "Home";
}

/** Render Home into `root`. */
export async function renderPage(root) {
  const mentors = store.people.filter((person) => person.is_mentor).sort(compareMentorsForOutreach);
  let sponsorPosts = [];
  let offerPosts = [];
  try {
    [sponsorPosts, offerPosts] = await Promise.all([getJson("/api/collection?key=sponsor_opportunity"), getJson("/api/collection?key=offer")]);
  } catch { /* lanes fall back to empty states */ }
  const draw = () => setHTML(root, renderHome(mentors, sponsorPosts, offerPosts));
  draw();
  root.addEventListener("click", (event) => handleHomeClick(event, draw));
}

// ---------- private helpers ----------

// Mentors with a LinkedIn you haven't contacted come first, then the ones you talked to most.
function compareMentorsForOutreach(a, b) {
  const isActionable = (person) => (person.linkedin.length && !noteStatusOf(person).contacted ? 1 : 0);
  return isActionable(b) - isActionable(a) || b.dm_count - a.dm_count || b.message_count - a.message_count;
}

function renderHome(mentors, sponsorPosts, offerPosts) {
  const stats = store.stats;
  return html`
    ${renderExportRibbon()}
    <header class="page-head">
      <p class="eyebrow">Cal Hacks 13.0 · UC Berkeley</p>
      <h1 class="title title--home">Your people from <em>Cal Hacks 13.0</em></h1>
      ${metaLine([`${formatNumber(stats.people)} people`, `${formatNumber(stats.channels)} channels`, `${formatNumber(stats.messages)} messages`, `archived through ${formatDate(stats.last_message)}`])}
    </header>
    ${renderFollowUps()}
    <div class="lanes">${renderMentorLane(mentors)}${renderSponsorLane(sponsorPosts)}${renderTeammateLane()}</div>
    ${renderStartWith(mentors)}
    ${renderOffers(offerPosts)}
    <footer class="disclaimer">Personal archive on this computer. Not affiliated with Cal Hacks or its sponsors.</footer>`;
}

async function handleHomeClick(event, redraw) {
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) {
    exportPeople(store.people, exportButton.dataset.export, "all");
    redraw();
  }
  const copyAllButton = event.target.closest("[data-copy-all]");
  if (copyAllButton) {
    const copiedCount = await copyAllLinkedIns();
    const label = copyAllButton.querySelector(".btn__label");
    label.textContent = copiedCount ? `Copied ${copiedCount}` : "Couldn't copy";
    setTimeout(() => (label.textContent = "Copy all LinkedIns"), COPY_ALL_FEEDBACK_MS);
  }
}

function renderExportRibbon() {
  const stats = store.stats;
  const withLinkedIn = store.people.filter((person) => person.linkedin.length).length;
  const exportedOn = lastExportLabel();
  if (exportedOn) {
    return html`<aside class="ribbon ribbon--done" aria-label="Export">${icon("check", "i i--12")}<span>Contacts exported ${exportedOn}. Workspace access can end; your people stay here.</span>
      <span class="ribbon__acts"><button class="linkbtn" type="button" data-export="csv">Export again</button></span></aside>`;
  }
  return html`<aside class="ribbon" aria-label="Before access ends">
    <span class="ribbon__pulse" aria-hidden="true"></span>
    <span class="ribbon__text"><b>Before access ends</b><span class="sep">·</span>${formatNumber(stats.people)} people<span class="sep">·</span>${formatNumber(withLinkedIn)} with LinkedIn<span class="sep">·</span>not exported yet</span>
    <span class="ribbon__acts">
      <button class="btn btn--primary btn--sm" type="button" data-export="csv">${icon("download")}Export CSV</button>
      <button class="btn btn--secondary btn--sm" type="button" data-export="vcf">vCard</button>
      <button class="btn btn--ghost btn--sm" type="button" data-copy-all>${icon("copy")}<span class="btn__label">Copy all LinkedIns</span></button>
    </span></aside>`;
}

function renderFollowUps() {
  const due = store.people
    .map((person) => [person, noteStatusOf(person)])
    .filter(([, status]) => status.due)
    .sort((a, b) => a[1].followUp.localeCompare(b[1].followUp));
  if (!due.length) return "";
  return html`<section class="home-due" aria-labelledby="h-due">
    <h2 class="h2" id="h-due">Follow-ups due <span class="num faint">${due.length}</span></h2>
    <ul class="minis bare">${due.slice(0, MAX_FOLLOW_UPS).map(([person, status]) => renderFollowUpRow(person, status))}</ul></section>`;
}

function renderFollowUpRow(person, status) {
  return html`<li class="mini">${personAvatar(person, 28)}
      <span class="mini__body"><a class="mini__name" href="#/people/${person.id}">${nameOf(person)}</a><span class="mini__sub">${status.overdue ? "overdue · " : "due "}${formatIsoDate(status.followUp)}</span></span>
      ${person.linkedin.length ? html`<a class="btn btn--secondary btn--sm" href="${person.linkedin[0]}" target="_blank" rel="noreferrer">${icon("linkedin")}Open LinkedIn</a>` : ""}</li>`;
}

function renderMentorLane(mentors) {
  const withLinkedIn = mentors.filter((person) => person.linkedin.length);
  const contactedCount = withLinkedIn.filter((person) => noteStatusOf(person).contacted).length;
  const percentContacted = withLinkedIn.length ? (contactedCount / withLinkedIn.length) * 100 : 0;
  const mentorRows = mentors.length
    ? html`<ul class="minis bare">${mentors.slice(0, MAX_LANE_MENTORS).map((person) => miniPersonRow(person, subtitleOf(person) || howYouMet(person, teammateOf(person.id))))}</ul>`
    : emptyState({ icon: "users", title: "No mentors found yet", body: "Mentors are spotted from their intros and roles.", actions: html`<a class="btn btn--secondary btn--sm" href="#/people">Browse everyone</a>` });
  return html`<section class="lane lane--mentor" aria-labelledby="l-m">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-m">Mentors & judges</h2><span class="num">${mentors.length}</span></header>
    <div class="lane__progress">
      <span class="small muted"><b class="num">${contactedCount}</b> of <span class="num">${withLinkedIn.length}</span> with LinkedIn contacted</span>
      <span class="bar" role="progressbar" aria-label="Mentors contacted" aria-valuemin="0" aria-valuemax="${withLinkedIn.length}" aria-valuenow="${contactedCount}"><span style="width:${percentContacted}%"></span></span>
    </div>
    ${mentorRows}
    <a class="lane__more" href="#/people?f=mentors">See all mentors ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

function renderSponsorLane(posts) {
  const companyKeys = new Set(posts.map(companyOf).filter((company) => company.channel).map((company) => company.key));
  const postList = posts.length
    ? html`<ul class="bare lane__posts">${posts.slice(0, MAX_LANE_SPONSOR_POSTS).map(renderSponsorPost)}</ul>`
    : emptyState({ icon: "briefcase", title: "Nothing sorted yet", body: html`Run ${commandSnippet("npm run categorize")} to gather sponsor posts and offers. It runs locally and needs no API key.` });
  return html`<section class="lane lane--sponsor" aria-labelledby="l-s">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-s">Sponsors</h2><span class="num">${companyKeys.size} companies · ${formatNumber(posts.length)} posts</span></header>
    ${postList}
    <a class="lane__more" href="#/opportunities">See all opportunities ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

function renderSponsorPost(post) {
  const company = companyOf(post);
  return html`<li><a class="post-mini" href="#/opportunities?tab=sponsors&co=${encodeURIComponent(company.key)}">
        <span class="post-mini__co">${company.label}<span class="num faint">${formatDate(post.date)}</span></span>
        <span class="post-mini__text">${slackExcerpt(post.text, 120)}</span></a></li>`;
}

function renderTeammateLane() {
  const teammates = store.teammates;
  // The lane title already says "teammates", so the role chip is left off each row.
  const teammateRows = teammates.length
    ? html`<ul class="minis bare">${teammates.slice(0, MAX_LANE_TEAMMATES).map(renderTeammateRow)}</ul>`
    : emptyState({ icon: "handshake", title: "No teammates found yet", body: "People you shared group chats with, or who posted about teaming up, will show here." });
  return html`<section class="lane lane--teammate" aria-labelledby="l-t">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-t">Possible teammates</h2><span class="num">${formatNumber(teammates.length)}</span></header>
    ${teammateRows}
    <a class="lane__more" href="#/teammates">See all teammates ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

// Their team post is the most useful sub-line; without one the row falls back to "how you met".
function renderTeammateRow(teammate) {
  const teamPost = teammate.team_posts[0];
  const subLine = teamPost ? slackExcerpt(teamPost.text, 80) : undefined;
  return miniPersonRow(store.peopleById.get(teammate.id) || teammate, subLine, { showChip: false });
}

function renderStartWith(mentors) {
  if (!mentors.length) return "";
  return html`<section class="home-sec" aria-labelledby="h-start">
      <header class="sec-head"><h2 class="h2" id="h-start">Start with these</h2><span class="muted small">Mentors who shared a LinkedIn and you haven't contacted yet</span></header>
      <div class="badges badges--row">${mentors.slice(0, MAX_HERO_BADGES).map((person) => nameTagBadge(person, { isTilted: true }))}</div></section>`;
}

function renderOffers(posts) {
  if (!posts.length) return "";
  return html`<section class="home-sec" aria-labelledby="h-off">
    <header class="sec-head"><h2 class="h2" id="h-off">Offers of help</h2><span class="muted small">Advice, resume reviews, referrals people offered</span><a class="lane__more" href="#/opportunities?tab=offers">All ${formatNumber(posts.length)} ${icon("arrow-right", "i i--12")}</a></header>
    <ul class="bare offer-rows">${posts.slice(0, MAX_OFFERS).map(renderOfferRow)}</ul></section>`;
}

function renderOfferRow(post) {
  const person = store.peopleById.get(post.user_id);
  return html`<li class="offer-row">${personAvatar(person, 40, post.user_name)}
        <div class="offer-row__body"><div class="offer-row__head">${person ? html`<a href="#/people/${person.id}">${nameOf(person)}</a>` : html`<b>${post.user_name}</b>`}${person ? roleChips(person, 1) : ""}<span class="num faint small">${post.channel} · ${formatDate(post.date)}</span></div>
        <p class="offer-row__text">${slackExcerpt(post.text, 260)}</p></div></li>`;
}
