// Teammates: people to build with again (from /api/teammates), in three reasoned sections:
// worked with, wanted to team up, DMed.
import { html } from "../utils/html.js";
import { formatNumber, pluralize } from "../utils/format.js";
import { setHTML } from "../utils/dom.js";
import { shortChannelName } from "../utils/people.js";
import { store } from "../contexts/appState.js";
import { nameTagBadge } from "../components/personCards.js";
import { emptyState } from "../components/states.js";
import { slackExcerpt } from "../components/slackText.js";

const PAGE_SIZE = 24;

/** Document title for Teammates. */
export function pageTitle() {
  return "Teammates";
}

/** Render Teammates into `root`. */
export async function renderPage(root) {
  const sections = buildSections(mergedTeammates());
  const shownBySection = Object.fromEntries(sections.map((section) => [section.id, PAGE_SIZE]));
  const draw = () => setHTML(root, renderTeammates(sections, shownBySection));
  draw();
  root.addEventListener("click", (event) => {
    const moreButton = event.target.closest("[data-more]");
    if (!moreButton) return;
    // Redrawing replaces the page, so keep the reader where they were.
    const scrollTop = scrollY;
    shownBySection[moreButton.dataset.more] += PAGE_SIZE;
    draw();
    scrollTo(0, scrollTop);
  });
}

// ---------- private helpers ----------

// The people row has the profile fields; the teammate row's groups and posts must win.
function mergedTeammates() {
  return store.teammates.map((teammate) => ({
    ...teammate,
    ...(store.peopleById.get(teammate.id) || {}),
    shared_groups: teammate.shared_groups,
    team_posts: teammate.team_posts,
  }));
}

function buildSections(teammates) {
  return [
    {
      id: "worked", title: "You worked with", sub: "You were both in a group chat or private channel.",
      rows: teammates.filter((person) => person.shared_groups.length),
      reason: (person) => `Group: ${person.shared_groups.slice(0, 2).map(shortChannelName).join(", ")}`,
    },
    {
      id: "wanted", title: "They wanted to team up", sub: "They posted about finding a team. Good people to ask for the next hackathon.",
      rows: teammates.filter((person) => !person.shared_groups.length && person.team_posts.length),
      reason: (person) => html`<span class="quote">“${slackExcerpt(person.team_posts[0].text, 140)}”</span>`,
    },
    {
      id: "dmed", title: "You DMed", sub: "You talked one on one.",
      rows: teammates.filter((person) => !person.shared_groups.length && !person.team_posts.length && person.dm_count > 0),
      reason: (person) => pluralize(person.dm_count, "DM"),
    },
  ].filter((section) => section.rows.length);
}

function renderTeammates(sections, shownBySection) {
  const body = sections.length
    ? sections.map((section) => renderSection(section, shownBySection[section.id]))
    : emptyState({ icon: "handshake", title: "No likely teammates found", body: "If you had a team group chat, make sure it was included in the backup." });
  return html`
    <header class="page-head"><h1 class="title">Teammates</h1>
      <p class="lede">People to build with again. Mentors, judges, sponsor reps and organizers are left out.</p></header>
    ${body}`;
}

function renderSection(section, shownCount) {
  const remaining = section.rows.length - shownCount;
  return html`<section class="tm-sec" aria-labelledby="h-${section.id}">
        <header class="sec-head"><h2 class="h2" id="h-${section.id}">${section.title} <span class="num faint">${formatNumber(section.rows.length)}</span></h2><span class="muted small">${section.sub}</span></header>
        <div class="badges">${section.rows.slice(0, shownCount).map((person) => nameTagBadge(person, { reason: section.reason(person) }))}</div>
        ${remaining > 0 ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more="${section.id}">Show ${Math.min(PAGE_SIZE, remaining)} more</button></div>` : ""}
      </section>`;
}
