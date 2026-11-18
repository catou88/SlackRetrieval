// Project detail: what it is, how the code is built, prizes, team and each member's contribution.
// Generated paragraphs show their cited sources; missing evidence reads "Unknown", never guesses.
import { html } from "../utils/html.js";
import { setHTML } from "../utils/dom.js";
import { fetchProject } from "../services/intelApi.js";
import { errorCard } from "../components/states.js";
import { externalLink, linkRow } from "../components/intelLinks.js";

/** Document title for a project. */
export function pageTitle() {
  return "Project";
}

/** Render one project into `root`. */
export async function renderPage(root, { id }) {
  let project;
  try {
    project = await fetchProject(id);
  } catch (error) {
    setHTML(root, errorCard(error));
    return;
  }
  document.title = `${project.title} · Lanyard`;
  setHTML(root, renderProject(project));
}

// ---------- private helpers ----------

function renderProject(project) {
  const winnerPrizes = project.prizes.filter((p) => p.is_winner);
  return html`
    <a class="back" href="#/winners">← All winners</a>
    <header class="page-head"><h1 class="title">${project.title}</h1>
      <p class="lede">${project.tagline || ""}</p>
      <p class="meta-line">${project.hackathon_name || "Unknown hackathon"}</p>
      ${linkRow({ Devpost: project.devpost_url, GitHub: project.github_url, "Hugging Face": project.hf_url })}</header>
    ${winnerPrizes.length ? html`<section class="intel-section" aria-labelledby="prizes"><h2 class="sec-head" id="prizes">Prizes</h2>
      <ul class="intel-chips">${winnerPrizes.map((p) => html`<li class="chip chip--quiet">${p.prize}${p.sponsor ? ` · ${p.sponsor}` : ""}</li>`)}</ul></section>` : ""}
    ${section("what", "What it is", project.summary_what)}
    ${section("arch", "How it's built", project.summary_architecture)}
    ${project.summary_sources?.length ? html`<p class="meta-line">Sources: ${project.summary_sources.join(", ")}</p>` : ""}
    ${project.built_with.length ? html`<section class="intel-section" aria-labelledby="stack"><h2 class="sec-head" id="stack">Built with</h2>
      <ul class="intel-chips">${project.built_with.map((t) => html`<li class="chip chip--more">${t}</li>`)}</ul></section>` : ""}
    <section class="intel-section" aria-labelledby="team"><h2 class="sec-head" id="team">Team</h2>
      ${project.members.length ? html`<ul class="intel-members">${project.members.map((m) => memberRow(m, project))}</ul>` : html`<p class="meta-line">No team members listed.</p>`}</section>`;
}

function section(id, heading, text) {
  return html`<section class="intel-section" aria-labelledby="${id}"><h2 class="sec-head" id="${id}">${heading}</h2>
    <p>${text || "Unknown: this has not been summarized yet."}</p></section>`;
}

function memberRow(member, project) {
  const contribution = project.contributions.find((c) => c.person_id === member.id);
  return html`<li class="card intel-member"><h3 class="intel-member__name">${member.name}</h3>
    ${linkRow({ Devpost: member.devpost_url, GitHub: member.github_url, LinkedIn: member.linkedin_url })}
    <p>${contribution?.summary || "Unknown: no evidence of this person's contribution has been collected."}</p></li>`;
}
