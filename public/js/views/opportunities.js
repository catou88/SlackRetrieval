// Opportunities: sponsor posts grouped into company "booths" (reps hang on a lanyard cord),
// plus offers of help. Intent chips filter client-side; text filter is server-side.
import { html, raw, icon, num, date, setHTML, $, debounce, replaceParams, plural, NEWTAB } from "../html.js";
import { store, api, slot, nameOf, cleanName, companyOf, channels } from "../store.js";
import { avatar, chips, empty, cmd, errorCard, finalizeClamps, archiveHref } from "../ui.js";
import { render as slackRender, splitExtras, urlsIn, shortUrl } from "../slack.js";

export const title = () => "Opportunities";

const INTENTS = [
  { id: "jobs", label: "Jobs", re: /\b(intern(ship)?s?|hiring|roles?|apply|applications?|careers?|full[- ]time|new grad|recruit\w*|positions?)\b/i },
  { id: "events", label: "Events", re: /\b(events?|rsvp|meetups?|happy hour|workshops?|dinner|talks?|panel|webinar)\b|lu\.ma|luma\.com|partiful/i },
  { id: "forms", label: "Forms & links", re: /forms\.gle|docs\.google|typeform|airtable|tally\.so|\bform\b/i },
  { id: "perks", label: "Perks", re: /\b(credits?|promo|code|coupon|free tier|discount|swag|merch|api keys?)\b/i },
];

function card(r) {
  const p = store.byId.get(r.user_id);
  const { body } = splitExtras(r.text);
  const urls = urlsIn(r.text, 3);
  const li = r.author_linkedin?.[0];
  return html`<article class="opp">
    <header class="opp__head">${avatar(p, 28, r.user_name)}
      <span class="opp__who">${p ? html`<a href="#/people/${p.id}">${nameOf(p)}</a>` : html`<b>${cleanName(r.user_name)}</b>`}${p ? chips(p, 1) : ""}</span>
      <time class="num faint" datetime="${r.date}">${date(r.date)}</time></header>
    <div class="msg__text clamp opp__text" style="--lines:5">${raw(slackRender(body))}</div>
    ${urls.length ? html`<div class="opp__links">${urls.map((u) => html`<a class="linkchip" href="${u}" target="_blank" rel="noreferrer">${icon("link", "i i--12")}${shortUrl(u, 30)}${NEWTAB}</a>`)}</div>` : ""}
    <footer class="opp__foot">
      ${li ? html`<a class="linkbtn" href="${li}" target="_blank" rel="noreferrer">${icon("linkedin", "i i--12")}Open LinkedIn${NEWTAB}</a>` : ""}
      <a class="linkbtn" href="${archiveHref(r)}">${icon("message", "i i--12")}View in thread</a>
      <span class="opp__chan num faint">${r.channel}</span>
    </footer></article>`;
}

// Bold idea #2: the company's reps hang from one shared cord.
function cord(reps) {
  if (!reps.length) return "";
  const n = reps.length;
  return html`<div class="cord" aria-label="People from this company">
    <svg class="cord__line" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 2 Q50 14 100 2" vector-effect="non-scaling-stroke"/></svg>
    ${reps.map((p, i) => { const t = (i + 0.5) / n; const y = 2 + 12 * 2 * t * (1 - t) * 0.83; return html`<a class="cord__tag" href="#/people/${p.id}" style="left:${(t * 100).toFixed(2)}%;top:${(y * 0.9).toFixed(1)}px" data-tip="${nameOf(p)}" aria-label="${nameOf(p)}">${avatar(p, 28)}</a>`; })}
  </div>`;
}

export async function render(el, { params }) {
  let tab = params.get("tab") === "offers" ? "offers" : "sponsors";
  let q = params.get("q") || "";
  const focusCo = params.get("co");
  const intents = new Set((params.get("i") || "").split(",").filter(Boolean));
  const expanded = new Map(focusCo ? [[focusCo, 24]] : []);
  let offersShown = 20, rows = [];
  const get = slot();
  const counts = Object.fromEntries((store.collections || (await api("/api/collections"))).map((c) => [c.key, c.messages]));
  const chans = await channels().catch(() => []);
  const chanId = Object.fromEntries(chans.map((c) => [c.name, c.id]));

  setHTML(el, html`
    <header class="page-head"><h1 class="title">Opportunities</h1>
      <p class="lede">Jobs, events and offers people shared during the hackathon. Sponsor posts are grouped by company, so you know who to contact.</p></header>
    <div class="opp-bar">
      <div class="tabs" role="tablist" aria-label="Opportunities">
        <button class="tab" role="tab" id="t-sp" data-tab="sponsors" aria-controls="opp-panel">From sponsors <span class="num">${num(counts.sponsor_opportunity)}</span></button>
        <button class="tab" role="tab" id="t-of" data-tab="offers" aria-controls="opp-panel">Offers of help <span class="num">${num(counts.offer)}</span></button>
      </div>
      <label class="field opp-filter">${icon("search")}<span class="sr">Filter posts</span><input class="input" id="oq" type="search" placeholder="Filter by words, company or person" value="${q}" autocomplete="off"></label>
    </div>
    <div class="fchips intents" role="group" aria-label="Kind of post" id="intents"></div>
    <div id="opp-panel" role="tabpanel"></div>`);
  const panel = $("#opp-panel", el);

  const passes = (r) => !intents.size || [...intents].some((id) => INTENTS.find((x) => x.id === id).re.test(r.text));
  function drawIntents() {
    setHTML($("#intents", el), html`${INTENTS.map((x) => html`<button class="fchip" type="button" data-intent="${x.id}" aria-pressed="${intents.has(x.id)}">${x.label}<span class="num">${rows.filter((r) => x.re.test(r.text)).length}</span></button>`)}`);
  }
  function draw() {
    for (const t of el.querySelectorAll("[role=tab]")) { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; }
    panel.setAttribute("aria-labelledby", tab === "sponsors" ? "t-sp" : "t-of");
    drawIntents();
    const list = rows.filter(passes);
    const cap = rows.length === 500 ? html`<p class="meta-line">Showing the latest 500. Use the filter to narrow.</p>` : "";
    if (!rows.length && !q) {
      setHTML(panel, empty({ icon: "briefcase", title: "Nothing sorted yet", body: html`Run ${cmd("npm run categorize")} to gather sponsor posts and offers. It runs locally and needs no API key.`, actions: html`<a class="btn btn--secondary" href="#/archive">Browse sponsor channels ${icon("arrow-right")}</a>` }));
      return;
    }
    if (!list.length) {
      setHTML(panel, empty({ icon: "search", title: q ? `No posts mention “${q}”` : "No posts of this kind", actions: html`<button class="btn btn--secondary" type="button" data-clear>Clear</button>` }));
      return;
    }
    if (tab === "offers") {
      setHTML(panel, html`${cap}<div class="opps opps--flat">${list.slice(0, offersShown).map(card)}</div>
        ${offersShown < list.length ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more-offers>Show more</button></div>` : ""}`);
      return finalizeClamps(panel);
    }
    const groups = new Map();
    for (const r of list) {
      const c = companyOf(r);
      const g = groups.get(c.key) || { ...c, rows: [], reps: new Map(), chans: new Set() };
      g.rows.push(r);
      if (r.channel) g.chans.add(r.channel);
      const p = store.byId.get(r.user_id);
      if (p && (r.author_is_sponsor || (!r.author_is_organizer && !r.author_is_mentor))) g.reps.set(p.id, p);
      groups.set(c.key, g);
    }
    const sorted = [...groups.values()].sort((a, b) => (a.key === "dm") - (b.key === "dm") || b.rows[0].ts - a.rows[0].ts);
    setHTML(panel, html`${cap}<p class="meta-line">${plural(sorted.length, "company", "companies")}<span class="sep">·</span>${plural(list.length, "post")}</p>
      ${sorted.map((g) => {
        const n = expanded.get(g.key) || 4;
        const home = [...g.chans].find((c) => chanId[c] && /spons|cohost|partner/.test(c)) || [...g.chans][0];
        return html`<section class="booth" id="co-${encodeURIComponent(g.key)}" aria-label="${g.label}">
          <header class="booth__head">
            <div class="booth__id"><h2 class="booth__name">${g.label}</h2>
              <span class="num faint">${g.channel ? html`${[...g.chans].slice(0, 2).join(" ")} · ` : ""}${plural(g.rows.length, "post")}</span></div>
            ${cord([...g.reps.values()].slice(0, 7))}
            ${home && chanId[home] ? html`<a class="lane__more booth__open" href="#/archive/${chanId[home]}">Open channel ${icon("arrow-right", "i i--12")}</a>` : ""}
          </header>
          <div class="opps">${g.rows.slice(0, n).map(card)}</div>
          ${g.rows.length > n ? html`<button class="linkbtn booth__more" type="button" data-expand="${g.key}">${icon("chevron-down", "i i--12")}Show ${Math.min(20, g.rows.length - n)} more of ${g.rows.length}</button>` : ""}
        </section>`;
      })}`);
    finalizeClamps(panel);
  }
  async function load() {
    try {
      rows = await get(`/api/collection?key=${tab === "offers" ? "offer" : "sponsor_opportunity"}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      draw();
    } catch (e) { if (e.name !== "AbortError") setHTML(panel, errorCard(e)); }
  }
  const save = () => replaceParams({ tab: tab === "sponsors" ? "" : tab, q, i: [...intents].join(","), co: "" });
  const onQ = debounce(() => { save(); load(); }, 250);

  el.addEventListener("input", (e) => { if (e.target.id === "oq") { q = e.target.value.trim(); onQ(); } });
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t && t.dataset.tab !== tab) { tab = t.dataset.tab; offersShown = 20; save(); load(); }
    const i = e.target.closest("[data-intent]");
    if (i) { intents.has(i.dataset.intent) ? intents.delete(i.dataset.intent) : intents.add(i.dataset.intent); save(); draw(); }
    const x = e.target.closest("[data-expand]");
    if (x) { const k = x.dataset.expand; expanded.set(k, (expanded.get(k) || 4) + 20); draw(); }
    if (e.target.closest("[data-more-offers]")) { offersShown += 20; draw(); }
    if (e.target.closest("[data-clear]")) { q = ""; $("#oq", el).value = ""; intents.clear(); save(); load(); }
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target.closest("[role=tab]");
    if (t && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { const o = el.querySelector(`[role=tab]:not([data-tab="${t.dataset.tab}"])`); o.focus(); o.click(); }
  });
  await load();
  // After the router's own scroll reset.
  if (focusCo) setTimeout(() => document.getElementById(`co-${encodeURIComponent(focusCo)}`)?.scrollIntoView({ block: "start" }), 60);
}
