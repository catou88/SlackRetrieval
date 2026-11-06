// Home: "Before access ends" ribbon → title → follow-ups → three lanes → hero badges → offers.
import { html, raw, icon, num, date, isoDate, setHTML, plural } from "../html.js";
import { store, api, nameOf, chipsOf, companyOf, lineOf, howMet } from "../store.js";
import { statusOf } from "../notes.js";
import { badge, miniRow, avatar, chip, chips, empty, cmd, countLine, errorCard } from "../ui.js";
import { plain } from "../slack.js";
import { exportPeople, copyAllLinkedIns, lastExportLabel } from "../export.js";

export const title = () => "Home";

const mentorOrder = (a, b) => {
  const k = (p) => (p.linkedin.length && !statusOf(p).contacted ? 1 : 0);
  return k(b) - k(a) || b.dm_count - a.dm_count || b.message_count - a.message_count;
};

function ribbon() {
  const s = store.stats;
  const li = store.people.filter((p) => p.linkedin.length).length;
  const done = lastExportLabel();
  if (done)
    return html`<aside class="ribbon ribbon--done" aria-label="Export">${icon("check", "i i--12")}<span>Contacts exported ${done}. Workspace access can end; your people stay here.</span>
      <span class="ribbon__acts"><button class="linkbtn" type="button" data-export="csv">Export again</button></span></aside>`;
  return html`<aside class="ribbon" aria-label="Before access ends">
    <span class="ribbon__pulse" aria-hidden="true"></span>
    <span class="ribbon__text"><b>Before access ends</b><span class="sep">·</span>${num(s.people)} people<span class="sep">·</span>${num(li)} with LinkedIn<span class="sep">·</span>not exported yet</span>
    <span class="ribbon__acts">
      <button class="btn btn--primary btn--sm" type="button" data-export="csv">${icon("download")}Export CSV</button>
      <button class="btn btn--secondary btn--sm" type="button" data-export="vcf">vCard</button>
      <button class="btn btn--ghost btn--sm" type="button" data-copy-all>${icon("copy")}<span class="btn__label">Copy all LinkedIns</span></button>
    </span></aside>`;
}

function followUps() {
  const due = store.people.map((p) => [p, statusOf(p)]).filter(([, s]) => s.due).sort((a, b) => a[1].followUp.localeCompare(b[1].followUp));
  if (!due.length) return "";
  return html`<section class="home-due" aria-labelledby="h-due">
    <h2 class="h2" id="h-due">Follow-ups due <span class="num faint">${due.length}</span></h2>
    <ul class="minis bare">${due.slice(0, 6).map(([p, s]) => html`<li class="mini">${avatar(p, 28)}
      <span class="mini__body"><a class="mini__name" href="#/people/${p.id}">${nameOf(p)}</a><span class="mini__sub">${s.overdue ? "overdue · " : "due "}${isoDate(s.followUp)}</span></span>
      ${p.linkedin.length ? html`<a class="btn btn--secondary btn--sm" href="${p.linkedin[0]}" target="_blank" rel="noreferrer">${icon("linkedin")}Open LinkedIn</a>` : ""}</li>`)}</ul></section>`;
}

function mentorLane(mentors) {
  const withLi = mentors.filter((p) => p.linkedin.length);
  const done = withLi.filter((p) => statusOf(p).contacted).length;
  const pct = withLi.length ? (done / withLi.length) * 100 : 0;
  return html`<section class="lane lane--mentor" aria-labelledby="l-m">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-m">Mentors & judges</h2><span class="num">${mentors.length}</span></header>
    <div class="lane__progress">
      <span class="small muted"><b class="num">${done}</b> of <span class="num">${withLi.length}</span> with LinkedIn contacted</span>
      <span class="bar" role="progressbar" aria-label="Mentors contacted" aria-valuemin="0" aria-valuemax="${withLi.length}" aria-valuenow="${done}"><span style="width:${pct}%"></span></span>
    </div>
    ${mentors.length ? html`<ul class="minis bare">${mentors.slice(0, 4).map((p) => miniRow(p, lineOf(p) || howMet(p)))}</ul>`
      : empty({ icon: "users", title: "No mentors found yet", body: "Mentors are spotted from their intros and roles.", actions: html`<a class="btn btn--secondary btn--sm" href="#/people">Browse everyone</a>` })}
    <a class="lane__more" href="#/people?f=mentors">See all mentors ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

function sponsorLane(rows) {
  const companies = new Set(rows.map((r) => companyOf(r)).filter((c) => c.channel).map((c) => c.key));
  return html`<section class="lane lane--sponsor" aria-labelledby="l-s">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-s">Sponsors</h2><span class="num">${companies.size} companies · ${num(rows.length)} posts</span></header>
    ${rows.length ? html`<ul class="bare lane__posts">${rows.slice(0, 3).map((r) => {
      const c = companyOf(r);
      return html`<li><a class="post-mini" href="#/opportunities?tab=sponsors&co=${encodeURIComponent(c.key)}">
        <span class="post-mini__co">${c.label}<span class="num faint">${date(r.date)}</span></span>
        <span class="post-mini__text">${plain(r.text, 120)}</span></a></li>`;
    })}</ul>`
      : empty({ icon: "briefcase", title: "Nothing sorted yet", body: html`Run ${cmd("npm run categorize")} to gather sponsor posts and offers. It runs locally and needs no API key.` })}
    <a class="lane__more" href="#/opportunities">See all opportunities ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

function teammateLane() {
  const t = store.teammates;
  return html`<section class="lane lane--teammate" aria-labelledby="l-t">
    <header class="lane__head"><span class="lane__dot" aria-hidden="true"></span><h2 id="l-t">Possible teammates</h2><span class="num">${num(t.length)}</span></header>
    ${t.length ? html`<ul class="minis bare">${t.slice(0, 5).map((p) => miniRow(store.byId.get(p.id) || p, p.team_posts[0] ? plain(p.team_posts[0].text, 80) : undefined, { chip: false }))}</ul>`
      : empty({ icon: "handshake", title: "No teammates found yet", body: "People you shared group chats with, or who posted about teaming up, will show here." })}
    <a class="lane__more" href="#/teammates">See all teammates ${icon("arrow-right", "i i--12")}</a>
  </section>`;
}

function offers(rows) {
  if (!rows.length) return "";
  return html`<section class="home-sec" aria-labelledby="h-off">
    <header class="sec-head"><h2 class="h2" id="h-off">Offers of help</h2><span class="muted small">Advice, resume reviews, referrals people offered</span><a class="lane__more" href="#/opportunities?tab=offers">All ${num(rows.length)} ${icon("arrow-right", "i i--12")}</a></header>
    <ul class="bare offer-rows">${rows.slice(0, 3).map((r) => {
      const p = store.byId.get(r.user_id);
      return html`<li class="offer-row">${avatar(p, 40, r.user_name)}
        <div class="offer-row__body"><div class="offer-row__head">${p ? html`<a href="#/people/${p.id}">${nameOf(p)}</a>` : html`<b>${r.user_name}</b>`}${p ? chips(p, 1) : ""}<span class="num faint small">${r.channel} · ${date(r.date)}</span></div>
        <p class="offer-row__text">${plain(r.text, 260)}</p></div></li>`;
    })}</ul></section>`;
}

export async function render(el) {
  const s = store.stats;
  const mentors = store.people.filter((p) => p.is_mentor).sort(mentorOrder);
  let sp = [], of = [];
  try { [sp, of] = await Promise.all([api("/api/collection?key=sponsor_opportunity"), api("/api/collection?key=offer")]); }
  catch (e) { /* lanes fall back to empty states */ }
  const draw = () => setHTML(el, html`
    ${ribbon()}
    <header class="page-head">
      <p class="eyebrow">Cal Hacks 13.0 · UC Berkeley</p>
      <h1 class="title title--home">Your people from <em>Cal Hacks 13.0</em></h1>
      ${countLine([`${num(s.people)} people`, `${num(s.channels)} channels`, `${num(s.messages)} messages`, `archived through ${date(s.last_message)}`])}
    </header>
    ${followUps()}
    <div class="lanes">${mentorLane(mentors)}${sponsorLane(sp)}${teammateLane()}</div>
    ${mentors.length ? html`<section class="home-sec" aria-labelledby="h-start">
      <header class="sec-head"><h2 class="h2" id="h-start">Start with these</h2><span class="muted small">Mentors who shared a LinkedIn and you haven't contacted yet</span></header>
      <div class="badges badges--row">${mentors.slice(0, 6).map((p) => badge(p, { tilt: true }))}</div></section>` : ""}
    ${offers(of)}
    <footer class="disclaimer">Personal archive on this computer. Not affiliated with Cal Hacks or its sponsors.</footer>`);
  draw();
  el.addEventListener("click", async (e) => {
    const ex = e.target.closest("[data-export]");
    if (ex) { exportPeople(store.people, ex.dataset.export, "all"); draw(); }
    const ca = e.target.closest("[data-copy-all]");
    if (ca) {
      const n = await copyAllLinkedIns();
      const lab = ca.querySelector(".btn__label");
      lab.textContent = n ? `Copied ${n}` : "Couldn't copy";
      setTimeout(() => (lab.textContent = "Copy all LinkedIns"), 1800);
    }
  });
}
