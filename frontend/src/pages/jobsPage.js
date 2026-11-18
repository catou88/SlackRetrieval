// Jobs: internship/job posts found in the Slack archive and Discord exports you provided.
// Filters (source, channel, company) run client-side over one fetch; every post links back to its chat message.
import { html } from "../utils/html.js";
import { pluralize, formatDate } from "../utils/format.js";
import { findElement, setHTML } from "../utils/dom.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { fetchJobs } from "../services/intelApi.js";
import { emptyState } from "../components/states.js";
import { linkRow } from "../components/intelLinks.js";

/** Document title for Jobs. */
export function pageTitle() {
  return "Jobs";
}

/** Render Jobs into `root`. */
export async function renderPage(root, { params }) {
  const jobs = await fetchJobs();
  const view = { source: params.get("source") || "", channel: params.get("channel") || "", company: params.get("company") || "" };
  setHTML(root, renderShell(view, jobs));
  const list = findElement("#jobs-list", root);
  const status = findElement("#jobs-status", root);
  const draw = () => {
    const shown = jobs.filter((job) => matches(job, view));
    status.textContent = pluralize(shown.length, "posting");
    setHTML(list, shown.length ? html`<ul class="intel-cards">${shown.map(jobCard)}</ul>` : emptyState({
      icon: "briefcase", title: "No job posts",
      body: "No posts match, or none are stored yet. Jobs come only from your Slack archive (npm run sync) and Discord exports in data/discord/ (npm run intel:ingest).",
    }));
  };
  root.addEventListener("change", (event) => {
    const { name, value } = event.target;
    if (!(name in view)) return;
    view[name] = value;
    replaceHashParams(view);
    draw();
  });
  draw();
}

// ---------- private helpers ----------

function matches(job, view) {
  return (!view.source || job.source === view.source)
    && (!view.channel || job.channel === view.channel)
    && (!view.company || job.company === view.company);
}

function distinct(jobs, key) {
  return [...new Set(jobs.map((job) => job[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderShell(view, jobs) {
  const select = (name, label, values) => html`<label class="field"><span class="sr">${label}</span><select class="select" name="${name}">
    <option value="">${label}</option>${values.map((v) => html`<option value="${v}" ${v === view[name] ? "selected" : ""}>${v}</option>`)}</select></label>`;
  return html`
    <header class="page-head"><h1 class="title">Jobs</h1>
      <p class="lede">Postings shared in your Slack and Discord communities.</p></header>
    <form class="toolbar" aria-label="Filter jobs">
      ${select("source", "All sources", ["slack", "discord"])}
      ${select("channel", "All channels", distinct(jobs, "channel"))}
      ${select("company", "All companies", distinct(jobs, "company"))}
    </form>
    <p class="meta-line" id="jobs-status" role="status" aria-live="polite"></p>
    <div id="jobs-list"></div>`;
}

function jobCard(job) {
  const where = [job.company, job.location].filter(Boolean).join(" · ");
  return html`<li class="card intel-card">
    <h2 class="intel-card__title">${job.title}</h2>
    <p class="meta-line">${where || "Company not stated"}${job.sponsor_name ? ` · hackathon sponsor` : ""}</p>
    ${job.snippet ? html`<p>${job.snippet}</p>` : ""}
    <p class="meta-line">${job.source} · #${job.channel || "unknown"}${job.posted_at ? ` · ${formatDate(job.posted_at)}` : ""}</p>
    ${linkRow({ "Apply / posting": job.link, "Original message": job.permalink })}
  </li>`;
}
