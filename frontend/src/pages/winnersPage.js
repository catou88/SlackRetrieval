// Winners: 2026 San Francisco hackathon winners, filterable by hackathon, sponsor and stack.
// Filters are server-side (/api/intel/projects) and live in the hash so views are shareable.
import { html } from "../utils/html.js";
import { pluralize } from "../utils/format.js";
import { findElement, setHTML, debounce } from "../utils/dom.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { fetchProjects, fetchHackathons, fetchSponsors } from "../services/intelApi.js";
import { isAbortError } from "../services/api.js";
import { emptyState, errorCard, loadingSkeleton } from "../components/states.js";

const FILTER_DELAY_MS = 250;

/** Document title for Winners. */
export function pageTitle() {
  return "Winners";
}

/** Render Winners into `root`. */
export async function renderPage(root, { params }) {
  const [hackathons, sponsors] = await Promise.all([fetchHackathons(), fetchSponsors()]);
  const view = { hackathon: params.get("h") || "", sponsor: params.get("s") || "", stack: params.get("t") || "", winners: params.get("all") !== "1" };
  setHTML(root, renderShell(view, hackathons, sponsors));
  let controller; // a newer filter aborts the previous request so stale answers never land
  const list = findElement("#winners-list", root);
  const status = findElement("#winners-status", root);

  async function load() {
    controller?.abort();
    controller = new AbortController();
    setHTML(list, loadingSkeleton("rows", 4));
    try {
      const projects = await fetchProjects(view, { signal: controller.signal });
      status.textContent = pluralize(projects.length, "project");
      setHTML(list, projects.length ? html`<ul class="intel-cards">${projects.map(projectCard)}</ul>` : emptyState({
        icon: "search", title: "No projects match", body: "Try removing a filter. If you have not ingested Devpost data yet, run npm run intel:ingest.",
      }));
    } catch (error) {
      if (isAbortError(error)) return;
      status.textContent = "";
      setHTML(list, errorCard(error));
    }
  }

  const reload = () => {
    replaceHashParams({ h: view.hackathon, s: view.sponsor, t: view.stack, all: view.winners ? "" : "1" });
    load();
  };
  const reloadSoon = debounce(reload, FILTER_DELAY_MS);
  root.addEventListener("submit", (event) => event.preventDefault());
  root.addEventListener("change", (event) => {
    const { name, value } = event.target;
    if (name === "winners") view.winners = event.target.checked;
    else if (name in view) view[name] = value;
    reload();
  });
  findElement("#stack", root).addEventListener("input", (event) => { view.stack = event.target.value.trim(); reloadSoon(); });
  await load();
  return () => { reloadSoon.cancel(); controller?.abort(); };
}

// ---------- private helpers ----------

function renderShell(view, hackathons, sponsors) {
  const option = (value, label, selected) => html`<option value="${value}" ${selected ? "selected" : ""}>${label}</option>`;
  return html`
    <header class="page-head"><h1 class="title">Winners</h1>
      <p class="lede">What won at San Francisco hackathons in 2026, how it was built, and who built it.</p></header>
    <form class="toolbar" role="search" aria-label="Filter winners">
      <label class="field"><span class="sr">Hackathon</span><select class="select" name="hackathon">${option("", "All hackathons", !view.hackathon)}
        ${hackathons.map((h) => option(String(h.id), h.name, String(h.id) === view.hackathon))}</select></label>
      <label class="field"><span class="sr">Sponsor</span><select class="select" name="sponsor">${option("", "All sponsors", !view.sponsor)}
        ${sponsors.map((s) => option(s.name, s.name, s.name === view.sponsor))}</select></label>
      <label class="field"><span class="sr">Tech stack</span><input class="input" id="stack" name="stack" type="search" placeholder="Stack, e.g. langgraph" value="${view.stack}" autocomplete="off"></label>
      <label class="intel-check"><input type="checkbox" name="winners" ${view.winners ? "checked" : ""}> Winners only</label>
    </form>
    <p class="meta-line" id="winners-status" role="status" aria-live="polite"></p>
    <div id="winners-list"></div>`;
}

function projectCard(project) {
  const prizes = project.prizes.filter((p) => p.is_winner);
  return html`<li class="card intel-card">
    <h2 class="intel-card__title"><a href="#/winners/${project.id}">${project.title}</a></h2>
    <p class="meta-line">${project.hackathon_name || "Unknown hackathon"}</p>
    ${project.tagline ? html`<p>${project.tagline}</p>` : ""}
    ${prizes.length ? html`<p class="intel-chips">${prizes.map((p) => html`<span class="chip chip--quiet">${p.prize}${p.sponsor ? ` · ${p.sponsor}` : ""}</span>`)}</p>` : ""}
    ${project.built_with.length ? html`<p class="intel-chips" aria-label="Built with">${project.built_with.slice(0, 8).map((t) => html`<span class="chip chip--more">${t}</span>`)}</p>` : ""}
  </li>`;
}
