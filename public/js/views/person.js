// Person: identity header (flippable badge), action bar, Reconnect, Conversation, Notes, Details.
import { html, raw, icon, esc, num, date, ago, setHTML, $, $$, debounce, announce, plural, NEWTAB, copyText } from "../html.js";
import { store, api, post, nameOf, firstName, liSlug, liSearch, chipsOf, stripOf, howMet, intros, recents, shortChan } from "../store.js";
import { parseNote, serializeNote, saveNote, todayISO, statusOf } from "../notes.js";
import { avatar, chip, messageList, message, empty, errorCard, finalizeClamps } from "../ui.js";
import { plain } from "../slack.js";
import { renderBrief, splitBrief } from "./brief.js";

let titleName = "Person";
export const title = () => titleName;
const PRESETS = ["Ask for a referral", "Resume review", "Team up next hackathon", "Say thanks"];

export async function render(el, { id }) {
  let data;
  try { [data] = await Promise.all([api(`/api/person?id=${encodeURIComponent(id)}`, { fresh: true }), intros()]); }
  catch (e) {
    if (/not found/.test(e.message))
      return void setHTML(el, empty({ icon: "users", title: "We couldn't find this person in the archive", actions: html`<a class="btn btn--secondary" href="#/people">Back to People</a>` }));
    throw e;
  }
  const p = { ...data.person, ...(store.byId.get(id) || {}) };
  const name = nameOf(p);
  titleName = name;
  recents.add(id);
  let st = parseNote(data.note?.body ?? p.note);
  const intro = store.introByUser.get(id);
  const claude = store.stats.claude;
  const li = p.linkedin[0];
  const tz = p.timezone ? new Intl.DateTimeFormat("en-US", { timeZone: p.timezone, hour: "numeric", minute: "2-digit" }).format(new Date()) : "";

  const prev = window.lanyardPrev || "";
  const BACK = { people: "People", teammates: "Teammates", opportunities: "Opportunities", archive: "Archive", ask: "Ask" };
  const pk = prev.replace(/^#\/?/, "").split(/[/?]/)[0];
  const back = BACK[pk] && !/^#\/people\/./.test(prev) ? { href: prev, label: BACK[pk] }
    : prev === "#/" ? { href: "#/", label: "Home" } : { href: "#/people", label: "People" };
  const dms = data.dms, mine = data.messages;
  let tab = dms.length ? "dms" : "msgs", dmShown = 20, msgShown = 20;

  const talked = (dms.length ? dms.slice(-3).reverse() : [...mine].sort((a, b) => sum(b) - sum(a)).slice(0, 3));
  function sum(m) { return (m.reactions || []).reduce((s, r) => s + r.count, 0); }

  setHTML(el, html`
    <a class="back" href="${back.href}">${icon("arrow-left")}${back.label}</a>
    <header class="phead">
      <div class="flip" data-flipped="false">
        <article class="badge badge--lg flip__front" data-strip="${stripOf(p)}" ${st.contacted ? raw("data-contacted") : ""}>
          <span class="badge__strip" aria-hidden="true"></span><span class="badge__slot" aria-hidden="true"></span>
          ${avatar(p, 96)}
          <div class="badge__chips">${chipsOf(p).map(chip)}</div>
          <footer class="badge__meta">${howMet(p)}</footer>
        </article>
        <article class="badge badge--lg flip__back" aria-hidden="true">
          <span class="badge__slot" aria-hidden="true"></span>
          <p class="flip__note" id="flip-note"></p>
          <footer class="badge__meta">${howMet(p)}</footer>
        </article>
      </div>
      <div class="phead__main">
        <h1 class="pname">${name}</h1>
        <p class="phead__line">${[p.title, p.pronouns].filter(Boolean).join(" · ")}${p.title || p.pronouns ? raw('<span class="sep">·</span>') : ""}<span class="mono">@${p.handle}</span>${tz ? html`<span class="sep">·</span><span class="mono" title="${p.timezone}">${tz} their time</span>` : ""}</p>
        <div class="phead__tags">
          <button class="linkbtn" type="button" data-flip aria-pressed="false">${icon("flip", "i i--12")}<span>Flip badge</span></button>
          ${p.role_evidence?.length ? html`<button class="linkbtn" type="button" data-why aria-expanded="false" aria-controls="why">${icon("info", "i i--12")}Why tagged</button>` : ""}
        </div>
        <ul class="why bare" id="why" hidden>${(p.role_evidence || []).map((e) => html`<li>${e}</li>`)}</ul>
        ${intro ? html`<figure class="intro"><blockquote>${plain(intro.text, 220)}</blockquote><figcaption>Their intro · ${shortChan(intro.channel)} · ${date(intro.date)}</figcaption></figure>` : ""}
      </div>
    </header>

    <div class="actionbar" role="toolbar" aria-label="Actions">
      ${li ? html`<a class="btn btn--li" href="${li}" target="_blank" rel="noreferrer" data-li>${icon("linkedin")}Open LinkedIn${NEWTAB}</a>
        <button class="btn btn--secondary" type="button" data-copy="${li}" data-copy-msg="Copied LinkedIn link" data-copyli>${icon("copy")}<span class="btn__label">Copy link</span></button>`
      : html`<span class="chip chip--quiet">No LinkedIn shared in Slack</span><a class="btn btn--secondary" href="${liSearch(p)}" target="_blank" rel="noreferrer" data-li>${icon("search")}Search LinkedIn${NEWTAB}</a>`}
      ${p.email ? html`<a class="btn btn--ghost" href="mailto:${p.email}">${icon("mail")}Email</a>` : ""}
      <span class="actionbar__sep" aria-hidden="true"></span>
      <button class="btn btn--secondary" type="button" data-toggle-contacted aria-pressed="${st.contacted}">${icon("check")}<span>${st.contacted ? "Contacted" : "Mark contacted"}</span></button>
      <label class="fu">${icon("calendar")}<span>Follow up</span><input class="input" type="date" id="fu" value="${st.followUp || ""}" min="${todayISO()}"></label>
      <span class="actionbar__undo" id="undo" aria-live="polite"></span>
    </div>

    <div class="pgrid">
      <div class="pmain">
        <section class="psec reconnect" aria-labelledby="h-rc">
          <h2 class="h2" id="h-rc">Reconnect</h2>
          <p class="muted small">What do you want from this conversation? Claude reads your shared messages and writes a brief plus a draft.</p>
          <div class="fchips presets">${PRESETS.map((g) => html`<button class="fchip" type="button" data-preset="${g}">${g}</button>`)}</div>
          <form class="rc-form" id="rc-form">
            <label class="sr" for="goal">Goal</label>
            <input class="input" id="goal" placeholder="Or write your own goal…" autocomplete="off">
            <button class="btn btn--primary" type="submit" id="rc-btn" ${claude ? "" : raw('aria-disabled="true" aria-describedby="rc-off"')}>${icon("sparkles")}<span>Write brief</span></button>
          </form>
          ${claude ? "" : html`<p class="hint" id="rc-off">${icon("info", "i i--12")}Briefs need a Claude API key. Add one to <code>.env</code> and restart.</p>`}
          <div id="rc-out" aria-live="polite"></div>
          ${data.briefs.length ? html`<details class="past"><summary>Past briefs (${data.briefs.length})</summary>${data.briefs.map((b) => html`<details class="past__one"><summary>${b.goal || "General"} · ${date(b.created_at)}</summary>${renderBrief(b.body)}</details>`)}</details>` : ""}
          ${!claude && talked.length ? html`<div class="talked"><h3 class="eyebrow">Things you talked about</h3><ul class="bare">${talked.map((m) => html`<li><span class="num faint">${shortChan(m.channel)} · ${date(m.date)}</span><p>${plain(m.text, 200)}</p></li>`)}</ul></div>` : ""}
        </section>

        <section class="psec psec--conv" aria-labelledby="h-conv">
          <h2 class="h2" id="h-conv">Conversation</h2>
          ${dms.length || mine.length ? html`<div class="tabs" role="tablist" aria-label="Conversation">
              ${dms.length ? html`<button class="tab" role="tab" id="t-dms" data-tab="dms" aria-controls="conv">DMs <span class="num">${dms.length}</span></button>` : ""}
              ${mine.length ? html`<button class="tab" role="tab" id="t-msgs" data-tab="msgs" aria-controls="conv">Their messages <span class="num">${mine.length}</span></button>` : ""}
            </div><div id="conv" role="tabpanel"></div>`
          : empty({ icon: "message", title: `No messages from ${firstName(p)} in the archive`, body: "They may have only reacted or lurked." })}
        </section>
      </div>

      <aside class="paside">
        <section class="psec psec--notes" aria-labelledby="h-notes">
          <h2 class="h2" id="h-notes"><label for="notes">Notes</label></h2>
          <textarea class="textarea" id="notes" rows="7" placeholder="Where you met, what you talked about, what to follow up on…">${st.text}</textarea>
          <p class="savestate" id="savestate" aria-live="polite">${data.note?.updated_at ? `Saved · ${ago(data.note.updated_at)}` : "Private. Saved on this computer."}</p>
        </section>
        <section class="psec psec--det" aria-labelledby="h-det">
          <h2 class="h2" id="h-det">Details</h2>
          <dl class="details">
            ${p.profile_fields.filter((f) => f.value).map((f) => html`<div><dt>${f.label || "Profile"}</dt><dd>${f.value}</dd></div>`)}
            ${p.org ? html`<div><dt>Company</dt><dd>${p.org}</dd></div>` : ""}
            ${p.linkedin.map((u) => html`<div><dt>LinkedIn</dt><dd><a href="${u}" target="_blank" rel="noreferrer" class="mono">in/${liSlug(u)}${NEWTAB}</a></dd></div>`)}
            ${(p.other_links || []).map((u) => html`<div><dt>Link</dt><dd><a href="${u}" target="_blank" rel="noreferrer" class="mono">${u.replace(/^https?:\/\/(www\.)?/, "")}${NEWTAB}</a></dd></div>`)}
            ${p.email ? html`<div><dt>Email</dt><dd class="mono">${p.email}</dd></div>` : ""}
            ${p.timezone ? html`<div><dt>Timezone</dt><dd class="mono">${p.timezone.replace(/_/g, " ")}</dd></div>` : ""}
            <div><dt>First seen</dt><dd class="mono">${date(p.first_seen) || "—"}</dd></div>
            <div><dt>Last seen</dt><dd class="mono">${date(p.last_seen) || "—"}</dd></div>
            <div><dt>Activity</dt><dd class="mono">${num(p.message_count)} msgs · ${num(p.dm_count)} DMs</dd></div>
          </dl>
          ${p.channels.length ? html`<h3 class="eyebrow chan-h">Channels</h3><div class="chanlist">${p.channels.slice(0, 12).map((c) => html`<span class="chanchip">${shortChan(c)}</span>`)}${p.channels.length > 12 ? html`<span class="chanchip">+${p.channels.length - 12}</span>` : ""}</div>` : ""}
        </section>
      </aside>
    </div>`);

  // ---------- conversation ----------
  const conv = $("#conv", el);
  function drawConv() {
    if (!conv) return;
    for (const t of $$("[role=tab]", el)) { const on = t.dataset.tab === tab; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; }
    conv.setAttribute("aria-labelledby", tab === "dms" ? "t-dms" : "t-msgs");
    if (tab === "dms") {
      const start = Math.max(0, dms.length - dmShown);
      setHTML(conv, html`${start > 0 ? html`<div class="showmore showmore--top"><button class="btn btn--ghost" type="button" data-earlier>Show ${Math.min(20, start)} earlier</button></div>` : ""}
        <div class="msgs">${messageList(dms.slice(start), { noChips: true })}</div>`);
    } else {
      setHTML(conv, html`<div class="msgs">${mine.slice(0, msgShown).map((m) => message(m, { channel: true, noChips: true }))}</div>
        ${msgShown < mine.length ? html`<div class="showmore"><button class="btn btn--secondary" type="button" data-more>Show 20 more</button></div>` : ""}
        ${mine.length === 300 && msgShown >= 300 ? html`<p class="faint small center">Showing their latest 300 messages.</p>` : ""}`);
    }
    finalizeClamps(conv);
  }
  drawConv();

  // ---------- notes + status ----------
  const saveEl = $("#savestate", el);
  let savedAt = data.note?.updated_at;
  const onState = (s) => {
    if (s === "saving") saveEl.textContent = "Saving…";
    if (s === "saved") { savedAt = new Date().toISOString(); saveEl.textContent = "Saved · just now"; }
    if (s === "error") setHTML(saveEl, html`<span class="due-txt">Not saved.</span> <button class="linkbtn" type="button" data-retry-save>Retry</button>`);
  };
  let q;
  const persist = () => { q = saveNote(id, serializeNote(st), onState); syncBadge(); };
  const syncBadge = () => {
    const front = $(".flip__front", el);
    front.toggleAttribute("data-contacted", st.contacted);
    $("#flip-note", el).textContent = st.text.trim() || `No note yet. Write one under Notes and it shows up here, like the back of a real name tag.`;
  };
  syncBadge();
  const tick = setInterval(() => { if (savedAt && /^Saved/.test(saveEl.textContent)) saveEl.textContent = `Saved · ${ago(savedAt)}`; }, 60000);
  const notes = $("#notes", el);
  const typed = debounce(() => { st.text = notes.value; persist(); }, 800);
  notes.addEventListener("input", typed);
  notes.addEventListener("blur", () => { if (notes.value !== st.text) { typed.cancel(); st.text = notes.value; persist(); } });
  $("#fu", el).addEventListener("change", (e) => { st.followUp = e.target.value || null; persist(); announce(st.followUp ? `Follow-up set for ${st.followUp}` : "Follow-up cleared"); });

  let undoT;
  function toggleContacted() {
    const prev = { ...st };
    st.contacted = !st.contacted;
    st.contactedOn = st.contacted ? todayISO() : null;
    persist();
    const b = $("[data-toggle-contacted]", el);
    b.setAttribute("aria-pressed", String(st.contacted));
    b.querySelector("span").textContent = st.contacted ? "Contacted" : "Mark contacted";
    const u = $("#undo", el);
    setHTML(u, html`${st.contacted ? "Marked contacted" : "Unmarked"} · <button class="linkbtn" type="button" data-undo>Undo</button>`);
    clearTimeout(undoT);
    undoT = setTimeout(() => (u.textContent = ""), 6000);
    u.dataset.prev = JSON.stringify(prev);
  }

  // ---------- reconnect ----------
  const out = $("#rc-out", el);
  async function writeBrief() {
    if (!claude) { $("#rc-off", el)?.classList.add("hint--pulse"); setTimeout(() => $("#rc-off", el)?.classList.remove("hint--pulse"), 600); return; }
    const btn = $("#rc-btn", el), goal = $("#goal", el).value.trim();
    btn.setAttribute("aria-disabled", "true");
    btn.querySelector("span").textContent = "Writing…";
    btn.classList.add("is-busy");
    const slow = setTimeout(() => (btn.querySelector("span").textContent = "Still working. Claude can take about 20 seconds."), 10000);
    try {
      const { answer } = await post("/api/brief", { person: id, goal });
      setHTML(out, renderBrief(answer, { copy: true }));
      announce("Brief ready");
    } catch (e) { setHTML(out, errorCard(e, "brief")); }
    clearTimeout(slow);
    btn.removeAttribute("aria-disabled"); btn.classList.remove("is-busy");
    btn.querySelector("span").textContent = "Write brief";
  }

  // ---------- events ----------
  el.addEventListener("submit", (e) => { e.preventDefault(); writeBrief(); });
  el.addEventListener("click", (e) => {
    const t = e.target;
    const pr = t.closest("[data-preset]");
    if (pr) { $("#goal", el).value = pr.dataset.preset; $("#goal", el).focus(); }
    const tb = t.closest("[data-tab]");
    if (tb) { tab = tb.dataset.tab; drawConv(); }
    if (t.closest("[data-earlier]")) { dmShown += 20; drawConv(); }
    if (t.closest("[data-more]")) { msgShown += 20; drawConv(); }
    if (t.closest("[data-toggle-contacted]")) toggleContacted();
    if (t.closest("[data-undo]")) { st = JSON.parse($("#undo", el).dataset.prev); persist(); const b = $("[data-toggle-contacted]", el); b.setAttribute("aria-pressed", String(st.contacted)); b.querySelector("span").textContent = st.contacted ? "Contacted" : "Mark contacted"; $("#undo", el).textContent = "Undone"; }
    if (t.closest("[data-retry-save]")) q?.retry();
    if (t.closest("[data-action=brief]")) writeBrief();
    const w = t.closest("[data-why]");
    if (w) { const open = w.getAttribute("aria-expanded") === "true"; w.setAttribute("aria-expanded", String(!open)); $("#why", el).hidden = open; }
    const f = t.closest("[data-flip]");
    if (f) {
      const on = f.getAttribute("aria-pressed") !== "true";
      f.setAttribute("aria-pressed", String(on));
      f.querySelector("span").textContent = on ? "Flip back" : "Flip badge";
      $(".flip", el).dataset.flipped = String(on);
      $(".flip__back", el).setAttribute("aria-hidden", String(!on));
      $(".flip__front", el).setAttribute("aria-hidden", String(on));
    }
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target.closest("[role=tab]");
    if (t && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const tabs = $$("[role=tab]", el), i = tabs.indexOf(t);
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      tab = n.dataset.tab; drawConv(); n.focus();
    }
  });
  el.addEventListener("viewkey", ({ detail: e }) => {
    const k = e.key.toLowerCase();
    if (k === "l") $("[data-li]", el)?.click();
    else if (k === "c" && li) $("[data-copyli]", el)?.click();
    else if (k === "x") toggleContacted();
    else if (e.key === "Escape") location.hash = back.href;
  });
  return () => { clearInterval(tick); clearTimeout(undoT); if (notes.value !== st.text) { st.text = notes.value; saveNote(id, serializeNote(st)); } };
}
