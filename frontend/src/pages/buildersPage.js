// Find teammates: search people from past hackathon projects by skill, stack or interest.
import { html } from "../utils/html.js";
import { pluralize } from "../utils/format.js";
import { findElement, setHTML } from "../utils/dom.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { fetchTeammates } from "../services/intelApi.js";
import { emptyState, errorCard } from "../components/states.js";
import { linkRow } from "../components/intelLinks.js";

/** Document title for the teammate finder. */
export function pageTitle() {
  return "Find teammates";
}

/** Render the teammate finder into `root`. */
export async function renderPage(root, { params }) {
  const query = params.get("q") || "";
  setHTML(root, html`
    <header class="page-head"><h1 class="title">Find teammates</h1>
      <p class="lede">Search hackathon builders by skill or stack, e.g. “python langgraph”. Winners rank higher.</p></header>
    <form class="toolbar" role="search" aria-label="Find teammates">
      <label class="field"><span class="sr">Skills or stack</span><input class="input" id="bq" type="search" maxlength="200" value="${query}" placeholder="Skills or stack" autocomplete="off"></label>
      <button class="btn btn--primary" type="submit">Search</button>
    </form>
    <p class="meta-line" id="b-status" role="status" aria-live="polite"></p>
    <div id="b-list"></div>`);
  const input = findElement("#bq", root);
  const list = findElement("#b-list", root);
  const status = findElement("#b-status", root);

  let latest = 0; // ignore answers to superseded searches
  async function search() {
    const mine = ++latest;
    const q = input.value.trim();
    replaceHashParams({ q });
    if (!q) { status.textContent = ""; setHTML(list, ""); return; }
    try {
      const people = await fetchTeammates(q);
      if (mine !== latest) return;
      status.textContent = pluralize(people.length, "match", "matches");
      setHTML(list, people.length ? html`<ul class="intel-members">${people.map(personCard)}</ul>` : emptyState({
        icon: "users", title: "No one matches", body: "Try a broader skill, or ingest more hackathons.",
      }));
    } catch (error) {
      if (mine !== latest) return;
      status.textContent = "";
      setHTML(list, errorCard(error));
    }
  }
  findElement("form", root).addEventListener("submit", (event) => { event.preventDefault(); search(); });
  if (query) await search();
}

// ---------- private helpers ----------

function personCard(person) {
  return html`<li class="card intel-member"><h2 class="intel-member__name">${person.name}</h2>
    ${linkRow({ Devpost: person.links.devpost, GitHub: person.links.github, LinkedIn: person.links.linkedin })}
    <ul class="intel-why">${person.why.map((reason) => html`<li>${reason}</li>`)}</ul>
    ${person.projects.length ? html`<p class="meta-line">Projects: ${person.projects.map((p) => p.title).join(", ")}</p>` : ""}</li>`;
}
