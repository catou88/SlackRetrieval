// Modal dialog helper (focus trap, inert background, Esc, focus return) and the ⌘K palette.
import { html, icon, esc, $, $$, setHTML, debounce, date, announce, copyText } from "./html.js";
import { store, channels, matchPeople, recents, nameOf, chipsOf, api, slot, liSlug } from "./store.js";
import { avatar } from "./ui.js";
import { plain } from "./slack.js";

const shellEls = () => [$(".shell"), $(".skip")];
export function openDialog({ label, opener, body, cls = "", onClose }) {
  const root = $("#overlay-root");
  const scrim = document.createElement("div");
  scrim.className = "dlg-scrim";
  setHTML(scrim, html`<div class="dlg ${cls}" role="dialog" aria-modal="true" aria-label="${label}">
    <button class="btn btn--icon btn--ghost dlg__close" type="button" aria-label="Close">${icon("x")}</button>${body}</div>`);
  root.append(scrim);
  for (const el of shellEls()) el.inert = true;
  const dlg = scrim.firstElementChild;
  const close = () => {
    scrim.remove();
    if (!root.children.length) for (const el of shellEls()) el.inert = false;
    onClose?.();
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
  };
  scrim.addEventListener("mousedown", (e) => e.target === scrim && close());
  dlg.querySelector(".dlg__close").addEventListener("click", close);
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === "Tab") {
      const f = $$("a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex='-1'])", dlg).filter((x) => x.offsetParent);
      if (!f.length) return;
      const [a, z] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  });
  requestAnimationFrame(() => (dlg.querySelector("[autofocus]") || dlg.querySelector(".dlg__close")).focus());
  return { dlg, close };
}

// ---------- palette ----------
const ACTIONS = [
  { label: "Go to Home", href: "#/", icon: "home" },
  { label: "Go to People", href: "#/people", icon: "users" },
  { label: "Go to Mentors & judges", href: "#/people?f=mentors", icon: "users" },
  { label: "Go to Opportunities", href: "#/opportunities", icon: "briefcase" },
  { label: "Go to Teammates", href: "#/teammates", icon: "handshake" },
  { label: "Go to Archive", href: "#/archive", icon: "archive" },
  { label: "Ask your archive", href: "#/ask", icon: "sparkles" },
  { label: "Toggle theme", run: async () => (await import("./app.js")).cycleTheme(), icon: "sun" },
  { label: "Show shortcuts", run: () => document.querySelector("[data-open-shortcuts]").click(), icon: "command" },
];
let isOpen = false;
export function openPalette(opener) {
  if (isOpen) return;
  isOpen = true;
  const { dlg, close } = openDialog({
    label: "Search", opener, cls: "dlg--palette", onClose: () => (isOpen = false),
    body: html`<div class="pal__bar">${icon("search")}
      <input class="pal__input" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Search people, channels, messages…" autofocus autocomplete="off" spellcheck="false">
      <kbd>Esc</kbd></div>
      <ul class="pal__list" id="pal-list" role="listbox" aria-label="Results"></ul>
      <footer class="pal__foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></footer>`,
  });
  const input = $(".pal__input", dlg), list = $("#pal-list", dlg);
  let items = [], sel = 0, msgs = [], chans = [];
  channels().then((c) => { chans = c; draw(); }).catch(() => {});
  const fetchMsgs = slot();

  const groups = (q) => {
    const g = [];
    const ql = q.trim().toLowerCase();
    const people = ql ? matchPeople(q, 6) : recents.get().map((id) => store.byId.get(id)).filter(Boolean);
    if (people.length) g.push({ title: ql ? "People" : "Recent", items: people.map((p) => ({ kind: "person", p, href: `#/people/${p.id}` })) });
    if (ql) {
      const ch = chans.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 4);
      if (ch.length) g.push({ title: "Channels", items: ch.map((c) => ({ kind: "chan", c, href: `#/archive/${c.id}` })) });
    }
    const acts = ACTIONS.filter((a) => !ql || a.label.toLowerCase().includes(ql)).slice(0, ql ? 4 : 9);
    const top = people[0];
    if (ql && top?.linkedin.length) acts.unshift({ label: `Copy LinkedIn of ${nameOf(top)}`, copy: top.linkedin[0], icon: "copy" }, { label: `Open LinkedIn of ${nameOf(top)}`, ext: top.linkedin[0], icon: "linkedin" });
    if (acts.length) g.push({ title: "Actions", items: acts.map((a) => ({ kind: "act", a, href: a.href })) });
    if (ql.length >= 2 && msgs.length) g.push({ title: "Messages", items: msgs.slice(0, 5).map((m) => ({ kind: "msg", m, href: `#/archive/${m.channel_id}?ts=${m.ts}${m.thread_ts && m.thread_ts !== m.ts ? "&thread=" + m.thread_ts : ""}` })) });
    if (ql.length >= 2) g.push({ title: "", items: [{ kind: "all", href: `#/archive/search?mode=keyword&q=${encodeURIComponent(q.trim())}` }] });
    return g;
  };
  const row = (it, i) => {
    const id = `pal-${i}`, s = i === sel;
    const attrs = html`id="${id}" role="option" aria-selected="${s}" data-i="${i}" class="pal__row${s ? " is-sel" : ""}"`;
    if (it.kind === "person") {
      const c = chipsOf(it.p)[0];
      return html`<li ${attrs}>${avatar(it.p, 28)}<span class="pal__label">${nameOf(it.p)}<span class="pal__sub">${c ? c.label : it.p.title || "@" + it.p.handle}</span></span><span class="pal__hint">${it.p.linkedin.length ? "in/" + liSlug(it.p.linkedin[0]) : ""}</span></li>`;
    }
    if (it.kind === "chan") return html`<li ${attrs}>${icon(it.c.type === "im" ? "message" : "hash")}<span class="pal__label">${it.c.name.replace(/^#/, "")}</span><span class="pal__hint">${it.c.message_count} msgs</span></li>`;
    if (it.kind === "act") return html`<li ${attrs}>${icon(it.a.icon)}<span class="pal__label">${it.a.label}</span><span class="pal__hint">${it.a.ext ? "↗" : ""}</span></li>`;
    if (it.kind === "msg") return html`<li ${attrs}>${icon("message")}<span class="pal__label"><span class="pal__msg">${nameOf(store.byId.get(it.m.user_id)) !== "Unknown" ? nameOf(store.byId.get(it.m.user_id)) : it.m.user_name}<span class="pal__sub">${it.m.channel} · ${date(it.m.date)}</span></span><span class="pal__excerpt">${plain(it.m.text, 90)}</span></span></li>`;
    return html`<li ${attrs}>${icon("search")}<span class="pal__label">Search all messages for “${input.value.trim()}”</span><span class="pal__hint">↵</span></li>`;
  };
  function draw() {
    const g = groups(input.value);
    items = g.flatMap((x) => x.items);
    if (sel >= items.length) sel = 0;
    let i = 0;
    setHTML(list, items.length
      ? html`${g.map((grp) => html`<li role="presentation" class="pal__group">${grp.title ? html`<span class="pal__gh" id="pg-${esc(grp.title)}">${grp.title}</span>` : ""}
          <ul role="group" ${grp.title ? html`aria-labelledby="pg-${grp.title}"` : html`aria-label="More"`}>${grp.items.map((it) => row(it, i++))}</ul></li>`)}`
      : html`<li class="pal__empty" role="presentation">No matches. Try a first name or a channel.</li>`);
    input.setAttribute("aria-activedescendant", items.length ? `pal-${sel}` : "");
    list.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
  }
  const loadMsgs = debounce(async (q) => {
    if (q.trim().length < 2) { msgs = []; return draw(); }
    try { msgs = await fetchMsgs(`/api/search?mode=keyword&q=${encodeURIComponent(q.trim())}`); } catch (e) { if (e.name !== "AbortError") msgs = []; }
    if (input.value === q) draw();
  }, 250);
  function setSel(i, scroll = true) {
    list.querySelector(".is-sel")?.classList.remove("is-sel");
    list.querySelector("[aria-selected=true]")?.setAttribute("aria-selected", "false");
    sel = i;
    const el = list.querySelector(`#pal-${i}`);
    if (el) { el.classList.add("is-sel"); el.setAttribute("aria-selected", "true"); if (scroll) el.scrollIntoView({ block: "nearest" }); }
    input.setAttribute("aria-activedescendant", `pal-${i}`);
  }
  async function activate(it) {
    if (!it) return;
    if (it.kind === "act" && it.a.copy) { const ok = await copyText(it.a.copy); announce(ok ? "Copied LinkedIn link" : "Couldn't copy"); close(); return; }
    if (it.kind === "act" && it.a.ext) { open(it.a.ext, "_blank", "noreferrer"); close(); return; }
    if (it.kind === "act" && it.a.run) { close(); it.a.run(); return; }
    close();
    (await import("./app.js")).go(it.href);
  }
  input.addEventListener("input", () => { sel = 0; draw(); loadMsgs(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      setSel((sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter") { e.preventDefault(); activate(items[sel]); }
  });
  list.addEventListener("mousemove", (e) => { const r = e.target.closest("[data-i]"); if (r && +r.dataset.i !== sel) setSel(+r.dataset.i, false); });
  list.addEventListener("click", (e) => { const r = e.target.closest("[data-i]"); if (r) activate(items[+r.dataset.i]); });
  draw();
}
