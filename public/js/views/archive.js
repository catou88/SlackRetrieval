// Archive: channel index | reader (windowed, ≤200 message nodes) | search.
import { html, raw, icon, num, setHTML, $, $$, debounce, replaceParams, plural } from "../html.js";
import { store, api, slot, channels, nameOf, titleCase, sponsorSlug } from "../store.js";
import { messageList, message, empty, errorCard, finalizeClamps, skeleton } from "../ui.js";

export const title = (r) => (r.id === "search" ? "Search" : "Archive");
const PAGE = 100, MAX_NODES = 200;

function label(c) {
  if (c.type === "im" || c.type === "mpim") { const p = store.byId.get(c.dm_with); return p ? nameOf(p) : c.name.replace(/^DM with /, ""); }
  const s = sponsorSlug(c.name);
  if (s) return titleCase(s);
  return c.name.replace(/^#/, "").replace(/^\d+-/, "");
}
function groupsOf(chs) {
  const g = { dm: [], sponsors: [], event: [], travel: [], other: [] };
  for (const c of chs) {
    if (c.type === "im" || c.type === "mpim") g.dm.push(c);
    else if (sponsorSlug(c.name)) g.sponsors.push(c);
    else if (/^#?\d+-travel/.test(c.name)) g.travel.push(c);
    else if (/^#?\d+-/.test(c.name)) g.event.push(c);
    else g.other.push(c);
  }
  g.sponsors.sort((a, b) => label(a).localeCompare(label(b)));
  g.event.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  g.travel.sort((a, b) => b.message_count - a.message_count);
  return [["dm", "Direct messages", g.dm, true], ["event", "Event", g.event, true], ["sponsors", "Sponsors", g.sponsors, true],
    ["travel", "Travel", g.travel, g.travel.length <= 30], ["other", "Other", g.other, g.other.length <= 30]].filter((x) => x[2].length);
}

export async function render(el, { id, params }) {
  const chs = await channels();
  const isSearch = id === "search";
  const mode0 = params.get("mode") === "keyword" ? "keyword" : "semantic";
  const q0 = params.get("q") || "";
  setHTML(el, html`
    <header class="page-head arch-head"><h1 class="title">${isSearch ? "Search messages" : "Archive"}</h1>
      <form class="arch-search" id="asearch" role="search">
        <label class="field">${icon("search")}<span class="sr">Search messages</span><input class="input" id="aq" type="search" placeholder="Search all ${num(store.stats.messages)} messages…" value="${q0}" autocomplete="off"></label>
        <div class="seg" role="group" aria-label="Search mode">
          <button type="button" data-mode="semantic" aria-pressed="${mode0 === "semantic"}">By meaning</button>
          <button type="button" data-mode="keyword" aria-pressed="${mode0 === "keyword"}">Exact words</button>
        </div>
      </form>
      <p class="faint small arch-help">By meaning finds related ideas; exact words finds the phrase.</p>
    </header>
    <div class="arch ${id ? "arch--open" : ""}">
      <nav class="arch__index" aria-label="Channels">${groupsOf(chs).map(([k, t, list, open]) => html`<details class="agroup" ${open ? "open" : ""}>
        <summary><span class="eyebrow">${t}</span><span class="num faint">${list.length}</span>${icon("chevron-down", "i i--12 agroup__chev")}</summary>
        <ul class="bare">${list.map((c) => html`<li><a class="aitem" href="#/archive/${c.id}" ${c.id === id ? html`aria-current="page"` : ""} title="${c.name}">
          ${icon(c.type === "im" ? "message" : c.type === "private" ? "lock" : "hash", "i i--12")}<span>${label(c)}</span><span class="num">${num(c.message_count)}</span></a></li>`)}</ul></details>`)}</nav>
      <section class="arch__reader" id="reader" aria-live="polite"></section>
    </div>`);
  const reader = $("#reader", el);
  let mode = mode0;

  // ---------- search ----------
  const getSearch = slot();
  async function runSearch(q) {
    q = q.trim();
    if (!q) return;
    if (!isSearch) return void (location.hash = `#/archive/search?mode=${mode}&q=${encodeURIComponent(q)}`);
    replaceParams({ q, mode });
    setHTML(reader, skeleton("rows", 5));
    try {
      const rows = await getSearch(`/api/search?mode=${mode}&q=${encodeURIComponent(q)}`);
      if (!rows.length) {
        const other = mode === "semantic" ? "exact words" : "by meaning";
        return setHTML(reader, empty({ icon: "search", title: `No messages match “${q}”`, body: `Try fewer words or switch to ${other}.`, actions: html`<button class="btn btn--secondary" type="button" data-switch>Search ${other}</button>` }));
      }
      setHTML(reader, html`<p class="meta-line rhead">${plural(rows.length, "result")} · ${mode === "semantic" ? "by meaning" : "exact words"}</p>
        <div class="msgs">${rows.slice(0, 100).map((m) => message(m, { channel: true, jump: true, thread: false }))}</div>`);
      finalizeClamps(reader);
    } catch (e) {
      if (e.name === "AbortError") return;
      if (mode === "semantic") setHTML(reader, empty({ icon: "info", title: "Search by meaning isn't available", body: "Try exact words.", actions: html`<button class="btn btn--secondary" type="button" data-switch>Search exact words</button>` }));
      else setHTML(reader, errorCard(e));
    }
  }
  const typed = debounce(() => mode === "keyword" && isSearch && runSearch($("#aq", el).value), 300);
  el.addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#aq", el).value); });
  el.addEventListener("input", (e) => e.target.id === "aq" && typed());

  // ---------- channel reader (windowed) ----------
  let ch = null, loaded = [], fetched = 0, exhausted = false, w0 = 0, w1 = 0;
  async function fetchPage() {
    const d = await api(`/api/channel?id=${encodeURIComponent(id)}&limit=${PAGE}&offset=${fetched}`);
    ch = d.channel;
    fetched += PAGE;
    if (d.messages.length < PAGE) exhausted = true;
    loaded = [...d.messages, ...loaded];
    return d.messages.length;
  }
  function drawReader() {
    const c = chs.find((x) => x.id === id) || ch;
    setHTML(reader, html`<header class="rhead">
        <a class="back back--reader" href="#/archive">${icon("arrow-left")}Archive</a>
        <h2 class="rhead__name">${c.type === "im" ? label(c) : c.name}</h2>
        <p class="num faint">${num(c.message_count)} messages${ch?.topic ? html`<span class="rhead__topic"> · ${ch.topic}</span>` : ""}</p></header>
      ${w0 > 0 || !exhausted ? html`<div class="showmore showmore--top"><button class="btn btn--ghost" type="button" data-earlier>${icon("chevron-down", "i i--12 flipy")}Load earlier messages</button></div>` : ""}
      ${loaded.length ? html`<div class="msgs" id="msgs">${messageList(loaded.slice(w0, w1), { lines: 8 })}</div>`
        : empty({ icon: "message", title: "This channel has no saved messages" })}
      ${w1 < loaded.length ? html`<div class="showmore"><button class="btn btn--ghost" type="button" data-newer>Show newer messages</button></div>` : ""}`);
    finalizeClamps(reader);
  }
  async function earlier() {
    const first = $("#msgs .msg", reader), top = first?.getBoundingClientRect().top;
    if (w0 === 0 && !exhausted) { const n = await fetchPage(); w0 += n; w1 += n; }
    w0 = Math.max(0, w0 - PAGE);
    w1 = Math.min(loaded.length, w0 + MAX_NODES);
    drawReader();
    const same = first && reader.querySelector(`[data-ts="${first.dataset.ts}"]`);
    if (same) scrollBy(0, same.getBoundingClientRect().top - top);
  }
  function newer() { w1 = Math.min(loaded.length, w1 + PAGE); w0 = Math.max(0, w1 - MAX_NODES); drawReader(); }

  async function openChannel() {
    setHTML(reader, skeleton("rows", 6));
    const ts = params.get("ts"), thread = params.get("thread");
    const target = thread || ts;
    try {
      await fetchPage();
      for (let i = 0; target && !loaded.some((m) => m.ts === target) && !exhausted && i < 40; i++) await fetchPage();
      w1 = loaded.length; w0 = Math.max(0, w1 - PAGE);
      const ti = target ? loaded.findIndex((m) => m.ts === target) : -1;
      if (ti >= 0) { w0 = Math.max(0, ti - 40); w1 = Math.min(loaded.length, w0 + MAX_NODES); }
      drawReader();
      setTimeout(async () => {
        const el2 = ti >= 0 && reader.querySelector(`[data-ts="${CSS.escape(target)}"]`);
        if (el2) {
          el2.scrollIntoView({ block: "center" });
          const tb = el2.querySelector("[data-thread]");
          if (thread && tb) (await import("../app.js")).toggleThread(tb, ts);
          else { el2.classList.add("flash"); if (tb) (await import("../app.js")).toggleThread(tb); }
          setTimeout(() => el2.classList.remove("flash"), 1600);
        } else if (matchMedia("(min-width:768px)").matches) scrollTo(0, document.body.scrollHeight);
      }, 60);
    } catch (e) { setHTML(reader, errorCard(e)); }
  }

  el.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) {
      mode = m.dataset.mode;
      for (const b of $$("[data-mode]", el)) b.setAttribute("aria-pressed", String(b === m));
      if ($("#aq", el).value.trim() && isSearch) runSearch($("#aq", el).value);
    }
    if (e.target.closest("[data-switch]")) $(`[data-mode="${mode === "semantic" ? "keyword" : "semantic"}"]`, el).click();
    if (e.target.closest("[data-earlier]")) earlier();
    if (e.target.closest("[data-newer]")) newer();
  });

  if (isSearch) {
    if (q0) runSearch(q0);
    else setHTML(reader, empty({ icon: "search", title: "Search the whole workspace", body: "Type a question or a phrase. By meaning works offline using the local index." }));
    $(".arch", el).classList.add("arch--open");
  } else if (id) await openChannel();
  else {
    const top = [...chs].filter((c) => c.type !== "im").sort((a, b) => b.message_count - a.message_count).slice(0, 6);
    setHTML(reader, html`<div class="arch-welcome">${empty({ icon: "archive", title: "Pick a channel", body: `${num(chs.length)} channels and DMs are saved on this computer. The busiest ones:` })}
      <ul class="bare arch-top">${top.map((c) => html`<li><a href="#/archive/${c.id}"><span>${c.name}</span><span class="num faint">${num(c.message_count)}</span></a></li>`)}</ul></div>`);
  }
}
