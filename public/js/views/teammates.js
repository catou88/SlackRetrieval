// Teammates: people to build with again, in three reasoned sections.
import { html, raw, num, date, setHTML, plural } from "../html.js";
import { store, shortChan } from "../store.js";
import { badge, empty } from "../ui.js";
import { plain } from "../slack.js";

export const title = () => "Teammates";

export async function render(el) {
  const t = store.teammates.map((x) => ({ ...x, ...(store.byId.get(x.id) || {}), shared_groups: x.shared_groups, team_posts: x.team_posts }));
  const sections = [
    { id: "worked", title: "You worked with", sub: "You were both in a group chat or private channel.", rows: t.filter((p) => p.shared_groups.length),
      reason: (p) => `Group: ${p.shared_groups.slice(0, 2).map(shortChan).join(", ")}` },
    { id: "wanted", title: "They wanted to team up", sub: "They posted about finding a team. Good people to ask for the next hackathon.", rows: t.filter((p) => !p.shared_groups.length && p.team_posts.length),
      reason: (p) => html`<span class="quote">“${plain(p.team_posts[0].text, 140)}”</span>` },
    { id: "dmed", title: "You DMed", sub: "You talked one on one.", rows: t.filter((p) => !p.shared_groups.length && !p.team_posts.length && p.dm_count > 0),
      reason: (p) => plural(p.dm_count, "DM") },
  ].filter((s) => s.rows.length);
  const shown = Object.fromEntries(sections.map((s) => [s.id, 24]));

  const draw = () => setHTML(el, html`
    <header class="page-head"><h1 class="title">Teammates</h1>
      <p class="lede">People to build with again. Mentors, judges, sponsor reps and organizers are left out.</p></header>
    ${sections.length ? sections.map((s) => html`<section class="tm-sec" aria-labelledby="h-${s.id}">
        <header class="sec-head"><h2 class="h2" id="h-${s.id}">${s.title} <span class="num faint">${num(s.rows.length)}</span></h2><span class="muted small">${s.sub}</span></header>
        <div class="badges">${s.rows.slice(0, shown[s.id]).map((p) => badge(p, { reason: s.reason(p) }))}</div>
        ${s.rows.length > shown[s.id] ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more="${s.id}">Show ${Math.min(24, s.rows.length - shown[s.id])} more</button></div>` : ""}
      </section>`)
    : empty({ icon: "handshake", title: "No likely teammates found", body: "If you had a team group chat, make sure it was included in the backup." })}`);
  draw();
  el.addEventListener("click", (e) => {
    const m = e.target.closest("[data-more]");
    if (m) { const y = scrollY; shown[m.dataset.more] += 24; draw(); scrollTo(0, y); }
  });
}
