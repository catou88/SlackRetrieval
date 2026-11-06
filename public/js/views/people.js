// People: list (default) or badge grid, client-side filters, sort, search, export.
import { html, raw, icon, num, setHTML, $, debounce, replaceParams, plural } from "../html.js";
import { store, nameOf, liSlug, lineOf, howMet, pref } from "../store.js";
import { statusOf } from "../notes.js";
import { badge, avatar, chips, statusChips, liButtons, empty } from "../ui.js";
import { exportPeople } from "../export.js";

export const title = () => "People";

const ROLE = [
  { id: "mentors", label: "Mentors & judges", test: (p) => p.is_mentor, color: "var(--mentor)" },
  { id: "sponsors", label: "Sponsors", test: (p) => p.is_sponsor, color: "var(--sponsor)" },
  { id: "organizers", label: "Organizers", test: (p) => p.is_organizer, color: "var(--organizer)" },
  { id: "likely", label: "Likely mentors", test: (p) => (p.likely_mentor || p.roles.includes("mentor?")) && !p.is_mentor, color: "transparent" },
];
const ATTR = [
  { id: "linkedin", label: "Has LinkedIn", phrase: "with LinkedIn", test: (p) => p.linkedin.length > 0 },
  { id: "contacted", label: "Contacted", phrase: "contacted", test: (p) => statusOf(p).contacted },
  { id: "due", label: "Follow-up due", phrase: "follow-up due", test: (p) => statusOf(p).due },
];
const SORTS = {
  talked: { label: "Most talked-to", fn: (a, b) => b.dm_count - a.dm_count || b.message_count - a.message_count },
  name: { label: "Name A–Z", fn: (a, b) => nameOf(a).localeCompare(nameOf(b)) },
  recent: { label: "Recently active", fn: (a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")) },
};

function listRow(p) {
  const s = statusOf(p);
  const li = p.linkedin[0];
  return html`<li class="prow">
    ${avatar(p, 40)}
    <div class="prow__id"><span class="prow__name"><a href="#/people/${p.id}">${nameOf(p)}</a>${chips(p)}</span>
      <span class="prow__line">${lineOf(p) || howMet(p)}</span></div>
    <div class="prow__li">${li ? html`<a class="mono" href="${li}" target="_blank" rel="noreferrer" aria-label="Open ${nameOf(p)}'s LinkedIn">in/${liSlug(li)}</a>
      <button class="btn btn--icon btn--ghost btn--sm" type="button" data-copy="${li}" data-copy-msg="Copied LinkedIn link" aria-label="Copy ${nameOf(p)}'s LinkedIn link">${icon("copy")}</button>`
      : html`<span class="faint small">No LinkedIn</span>`}</div>
    <div class="prow__status">${s.contacted ? html`<span class="ok-ico" role="img" aria-label="Contacted" data-tip="Contacted">${icon("check")}</span>` : ""}
      ${s.followUp ? html`<span class="${s.due ? "due-ico" : "faint"}" role="img" aria-label="Follow up ${s.followUp}" data-tip="Follow up ${s.followUp}">${icon("calendar")}</span>` : ""}</div>
    <div class="prow__counts num">${num(p.message_count)} msgs${p.dm_count ? html`<br>${num(p.dm_count)} DMs` : ""}</div>
  </li>`;
}

export async function render(el, { params }) {
  let filters = new Set((params.get("f") || "").split(",").filter(Boolean));
  let q = params.get("q") || "";
  let sort = SORTS[params.get("sort")] ? params.get("sort") : "talked";
  let mode = params.get("view") || pref.get("peopleView", "list");
  let shown = 0, rows = [], io;

  const counts = Object.fromEntries([...ROLE, ...ATTR].map((f) => [f.id, store.people.filter(f.test).length]));
  setHTML(el, html`
    <header class="page-head"><h1 class="title">People</h1>
      <p class="lede">Everyone who posted or DMed in the workspace. Mentors, judges and sponsor reps are tagged from their name tags and intros.</p></header>
    <div class="toolbar">
      <label class="field">${icon("search")}<span class="sr">Search people</span><input class="input" id="pq" type="search" placeholder="Search name, title, company, handle" value="${q}" autocomplete="off"></label>
      <div class="toolbar__end">
        <label class="sr" for="psort">Sort</label>
        <select class="select" id="psort">${Object.entries(SORTS).map(([k, v]) => html`<option value="${k}" ${k === sort ? "selected" : ""}>${v.label}</option>`)}</select>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" data-mode="list" aria-pressed="${mode === "list"}" aria-label="List">${icon("list")}</button>
          <button type="button" data-mode="grid" aria-pressed="${mode === "grid"}" aria-label="Badges">${icon("grid")}</button>
        </div>
        <details class="menu"><summary class="btn btn--secondary">${icon("download")}Export</summary>
          <div class="menu__pop" role="group" aria-label="Export"><p class="menu__head" id="xcount"></p>
            <button class="menu__item" type="button" data-export="csv">CSV spreadsheet</button>
            <button class="menu__item" type="button" data-export="vcf">vCard contacts</button></div></details>
      </div>
    </div>
    <div class="fchips" role="group" aria-label="Filters">
      <button class="fchip" type="button" data-f="" aria-pressed="false">All</button>
      ${ROLE.map((f) => html`<button class="fchip" type="button" data-f="${f.id}" aria-pressed="false"><span class="fchip__dot${f.id === "likely" ? " fchip__dot--likely" : ""}" style="background:${f.color}"></span>${f.label}<span class="num">${num(counts[f.id])}</span></button>`)}
      <span class="fsep" aria-hidden="true"></span>
      ${ATTR.map((f) => html`<button class="fchip" type="button" data-f="${f.id}" aria-pressed="false">${f.label}<span class="num">${num(counts[f.id])}</span></button>`)}
    </div>
    <p class="meta-line people-count" id="pcount" aria-live="polite"></p>
    <div id="presults"></div>`);

  const results = $("#presults", el), countEl = $("#pcount", el);
  function compute() {
    const roles = ROLE.filter((f) => filters.has(f.id)), attrs = ATTR.filter((f) => filters.has(f.id));
    const ql = q.trim().toLowerCase();
    rows = store.people.filter((p) =>
      (!roles.length || roles.some((f) => f.test(p))) && attrs.every((f) => f.test(p)) &&
      (!ql || `${nameOf(p)} ${p.name} ${p.handle} ${p.title} ${p.org}`.toLowerCase().includes(ql)));
    rows.sort(SORTS[sort].fn);
    const desc = [roles.map((f) => f.label).join(" or "), attrs.map((f) => f.phrase).join(" · ")].filter(Boolean);
    setHTML(countEl, html`<span>${plural(rows.length, "person", "people")}</span>${desc.map((d) => html`<span class="sep">·</span><span>${d}</span>`)}${ql ? html`<span class="sep">·</span><span>matching “${q.trim()}”</span>` : ""}`);
    $("#xcount", el).textContent = `${plural(rows.length, "person", "people")} in this view`;
  }
  function draw() {
    io?.disconnect();
    for (const b of el.querySelectorAll("[data-f]")) b.setAttribute("aria-pressed", String(b.dataset.f ? filters.has(b.dataset.f) : !filters.size));
    for (const b of el.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    compute();
    shown = 0;
    if (!rows.length) {
      const only = [...filters];
      setHTML(results, only.length === 1 && only[0] === "contacted" && !q
        ? empty({ icon: "check", title: "You haven't marked anyone as contacted yet", body: "Open a person and press Mark contacted." })
        : empty({ icon: "search", title: q ? `No one matches “${q.trim()}”` : "No one matches these filters", actions: html`<button class="btn btn--secondary" type="button" data-clear>Clear search and filters</button>` }));
      return;
    }
    setHTML(results, mode === "grid" ? html`<div class="badges" id="pitems"></div>` : html`<ul class="plist card" role="list" id="pitems"></ul>`);
    results.insertAdjacentHTML("beforeend", `<div class="showmore"><button class="btn btn--secondary" type="button" data-more>Show more</button></div>`);
    more();
    const sentinel = results.querySelector(".showmore");
    io = new IntersectionObserver((e) => e[0].isIntersecting && more(), { rootMargin: "600px" });
    io.observe(sentinel);
  }
  function more() {
    const n = mode === "grid" ? 60 : 100;
    const batch = rows.slice(shown, shown + n);
    shown += batch.length;
    $("#pitems", results).insertAdjacentHTML("beforeend", String(html`${batch.map((p) => (mode === "grid" ? badge(p) : listRow(p)))}`));
    const sm = results.querySelector(".showmore");
    if (sm) sm.hidden = shown >= rows.length;
  }
  const save = () => replaceParams({ f: [...filters].join(","), q: q.trim(), sort: sort === "talked" ? "" : sort, view: mode });
  const onSearch = debounce(() => { save(); draw(); }, 120);

  el.addEventListener("input", (e) => { if (e.target.id === "pq") { q = e.target.value; onSearch(); } });
  el.addEventListener("change", (e) => { if (e.target.id === "psort") { sort = e.target.value; save(); draw(); } });
  el.addEventListener("click", (e) => {
    const f = e.target.closest("[data-f]");
    if (f) {
      if (!f.dataset.f) filters.clear();
      else filters.has(f.dataset.f) ? filters.delete(f.dataset.f) : filters.add(f.dataset.f);
      save(); draw(); return;
    }
    const m = e.target.closest("[data-mode]");
    if (m) { mode = m.dataset.mode; pref.set("peopleView", mode); save(); draw(); return; }
    if (e.target.closest("[data-more]")) more();
    if (e.target.closest("[data-clear]")) { filters.clear(); q = ""; $("#pq", el).value = ""; save(); draw(); }
    const x = e.target.closest("[data-export]");
    if (x) {
      const label = [...filters].join("-") || (q ? "search" : "all");
      exportPeople(rows, x.dataset.export, label);
      x.closest("details").open = false;
    }
  });
  document.addEventListener("click", function off(e) {
    if (!el.isConnected) return document.removeEventListener("click", off);
    const d = el.querySelector("details.menu[open]");
    if (d && !d.contains(e.target)) d.open = false;
  });
  draw();
  return () => io?.disconnect();
}
