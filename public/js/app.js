// Boot, router, shell (rail / tabbar), theme, global delegated actions, shortcuts.
import { html, icon, num, $, $$, setHTML, parseHash, announce, copyText } from "./html.js";
import { store, boot, api, pref, invalidate, channels } from "./store.js";
import { errorCard, finalizeClamps, messageList } from "./ui.js";
import { openPalette, openDialog } from "./palette.js";

const VIEWS = {
  home: () => import("./views/home.js"),
  people: () => import("./views/people.js"),
  person: () => import("./views/person.js"),
  opportunities: () => import("./views/opportunities.js"),
  teammates: () => import("./views/teammates.js"),
  archive: () => import("./views/archive.js"),
  ask: () => import("./views/ask.js"),
};
const NAV = [
  { id: "home", href: "#/", label: "Home", icon: "home" },
  { id: "people", href: "#/people", label: "People", icon: "users", count: () => store.people.length },
  { id: "opportunities", href: "#/opportunities", label: "Opportunities", short: "Opps", icon: "briefcase", count: () => store.oppCount },
  { id: "teammates", href: "#/teammates", label: "Teammates", short: "Team", icon: "handshake", count: () => store.teammates.length },
  { id: "archive", href: "#/archive", label: "Archive", icon: "archive" },
  { id: "ask", href: "#/ask", label: "Ask", icon: "sparkles", rail: true },
];

const view = $("#view");
let cleanup = null, linkNav = false, booted = false, lastHash = null;

function renderShell(active) {
  setHTML($("#rail-nav"), html`${NAV.map((n) => html`<li><a class="rail__item" href="${n.href}" data-tip-rail="${n.label}" aria-label="${n.label}" ${n.id === active ? html`aria-current="page"` : ""}>
      ${icon(n.icon)}<span class="rail__label">${n.label}</span>${n.count?.() ? html`<span class="rail__count">${num(n.count())}</span>` : ""}</a></li>`)}`);
  setHTML($("#tabbar"), html`${NAV.filter((n) => !n.rail).map((n) => html`<a href="${n.href}" ${n.id === active ? html`aria-current="page"` : ""}>${icon(n.icon)}<span>${n.short || n.label}</span></a>`)}`);
}

// ---------- router ----------
function resolve() {
  const { path, params } = parseHash();
  const [a, b] = path;
  if (a === "people" && b) return { name: "person", nav: "people", id: b, params };
  if (a === "archive") return { name: "archive", nav: "archive", id: b, params };
  if (VIEWS[a]) return { name: a, nav: a, params };
  return { name: "home", nav: "home", params };
}

const scrollKey = (h) => "lanyard.scroll:" + h;
let navToken = 0;
async function router() {
  const token = ++navToken;
  const prevHash = lastHash;
  if (prevHash != null) try { sessionStorage.setItem(scrollKey(prevHash), String(scrollY)); } catch {}
  lastHash = location.hash || "#/";
  window.lanyardPrev = prevHash;
  const r = resolve();
  renderShell(r.nav);
  cleanup?.(); cleanup = null;
  closeOverlays();
  const fromLink = linkNav; linkNav = false;
  try {
    const mod = await VIEWS[r.name]();
    if (token !== navToken) return; // superseded by a newer navigation
    view.className = `view view--${r.name}`;
    // Fresh root per route so view-level listeners never accumulate.
    const root = document.createElement("div");
    root.className = "page";
    view.replaceChildren(root);
    cleanup = (await mod.render(root, r)) || null;
    document.title = `${mod.title?.(r) || r.nav[0].toUpperCase() + r.nav.slice(1)} · Lanyard`;
  } catch (e) {
    if (e.name === "AbortError") return;
    console.warn(e);
    setHTML(view, html`<div class="page">${errorCard(e)}</div>`);
  }
  finalizeClamps(view);
  // Scroll: top for link navigation, restored for back/forward.
  let y = 0;
  if (!fromLink && prevHash != null) try { y = +sessionStorage.getItem(scrollKey(lastHash)) || 0; } catch {}
  requestAnimationFrame(() => scrollTo(0, y));
  // Focus the h1 only on a real navigation (never on replaceState filter writes or first load).
  if (prevHash != null) {
    const h1 = $("h1", view);
    if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); announce(h1.textContent); }
  }
}
const route = () => router();
export const go = (hash) => { linkNav = true; location.hash = hash; };

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#/'], a[href='#/']");
  if (a && !e.metaKey && !e.ctrlKey) linkNav = true;
});

// ---------- theme ----------
const THEMES = ["system", "light", "dark"];
const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  for (const b of [$("#theme-btn"), $("#theme-btn-m")]) {
    b.querySelector("use").setAttribute("href", `#i-${THEME_ICON[t]}`);
    b.setAttribute("aria-label", `Theme: ${t[0].toUpperCase() + t.slice(1)}`);
    const l = b.querySelector(".rail__label"); if (l) l.textContent = `Theme: ${t[0].toUpperCase() + t.slice(1)}`;
  }
}
export function cycleTheme() {
  const t = THEMES[(THEMES.indexOf(pref.get("theme", "system")) + 1) % 3];
  pref.set("theme", t); applyTheme(t); announce(`Theme: ${t}`);
}
$("#theme-btn").addEventListener("click", cycleTheme);
$("#theme-btn-m").addEventListener("click", cycleTheme);
applyTheme(pref.get("theme", "system"));

// ---------- AI pill ----------
const pop = $("#ai-pop"), pill = $("#ai-pill");
function closeOverlays() { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); }
pill.addEventListener("click", () => {
  const open = pop.hidden;
  pop.hidden = !open; pill.setAttribute("aria-expanded", String(open));
  if (open) pop.focus?.();
});
document.addEventListener("click", (e) => { if (!pop.hidden && !e.target.closest("#ai-pop, #ai-pill")) closeOverlays(); });

// ---------- tooltips (real element; hover + focus) ----------
const tip = $("#tip");
function showTip(el) {
  const text = el.dataset.tip || (document.body.classList.contains("rail-icons") || matchMedia("(min-width:768px) and (max-width:1023px)").matches ? el.dataset.tipRail : "");
  if (!text) return;
  tip.textContent = text; tip.hidden = false;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const rail = el.dataset.tipRail && !el.dataset.tip;
  let x = rail ? r.right + 8 : r.left + r.width / 2 - t.width / 2, y = rail ? r.top + r.height / 2 - t.height / 2 : r.top - t.height - 6;
  if (y < 4) y = r.bottom + 6;
  tip.style.left = Math.max(4, Math.min(innerWidth - t.width - 4, x)) + "px"; tip.style.top = y + "px";
}
const hideTip = () => (tip.hidden = true);
document.addEventListener("pointerover", (e) => { const el = e.target.closest("[data-tip],[data-tip-rail]"); el ? showTip(el) : hideTip(); });
document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip],[data-tip-rail]"); el ? showTip(el) : hideTip(); });
document.addEventListener("focusout", hideTip);
addEventListener("scroll", hideTip, { passive: true });

// ---------- global delegated actions ----------
document.addEventListener("click", async (e) => {
  const t = e.target;
  const c = t.closest("[data-copy]");
  if (c) {
    e.preventDefault();
    const ok = await copyText(c.dataset.copy);
    const lab = c.querySelector(".btn__label");
    if (ok) {
      announce(c.dataset.copyMsg || "Copied");
      c.classList.add("is-copied");
      if (lab) { lab.dataset.was ??= lab.textContent; lab.textContent = "Copied"; }
      setTimeout(() => { c.classList.remove("is-copied"); if (lab) lab.textContent = lab.dataset.was; }, 1500);
    } else { announce("Press Ctrl+C to copy"); if (lab) lab.textContent = "Press Ctrl+C"; }
    return;
  }
  const u = t.closest("[data-unclamp]");
  if (u) {
    const txt = u.previousElementSibling, open = u.getAttribute("aria-expanded") === "true";
    txt.classList.toggle("clamp", open); u.setAttribute("aria-expanded", String(!open)); u.textContent = open ? "Show more" : "Show less";
    return;
  }
  const th = t.closest("[data-thread]");
  if (th) toggleThread(th);
  if (t.closest("[data-open-palette]")) openPalette(t.closest("[data-open-palette]"));
  if (t.closest("[data-open-shortcuts]")) openShortcuts(t.closest("[data-open-shortcuts]"));
  if (t.closest("[data-action=retry]")) { invalidate("/api/"); route(); }
});

export async function toggleThread(btn, highlight) {
  const box = btn.nextElementSibling;
  const open = btn.getAttribute("aria-expanded") === "true";
  if (open && !highlight) { box.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }
  btn.setAttribute("aria-expanded", "true"); box.hidden = false;
  if (!box.dataset.loaded) {
    box.innerHTML = `<p class="muted small">Loading replies…</p>`;
    const [ch, ts] = btn.dataset.thread.split("|");
    try {
      const rows = (await api(`/api/thread?channel=${ch}&ts=${ts}`)).filter((m) => m.ts !== ts).slice(0, 150);
      setHTML(box, html`${messageList(rows, { days: false, thread: false, lines: 8 })}`);
      box.dataset.loaded = "1"; finalizeClamps(box);
    } catch (err) { setHTML(box, errorCard(err)); }
  }
  if (highlight) {
    const el = box.querySelector(`[data-ts="${CSS.escape(highlight)}"]`);
    if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "center" }); }
  }
}

// ---------- shortcuts ----------
function openShortcuts(opener) {
  const rows = [["Ctrl K or /", "Search people, channels, messages"], ["Esc", "Close a dialog · go back from a person"], ["?", "Show this list"],
    ["L", "On a person: open LinkedIn"], ["C", "On a person: copy LinkedIn link"], ["X", "On a person: toggle contacted"]];
  openDialog({ label: "Keyboard shortcuts", opener, cls: "dlg--sm", body: html`<h2 class="dlg__title">Keyboard shortcuts</h2>
    <dl class="keys">${rows.map(([k, d]) => html`<div><dt>${k.split(" or ").map((x, i) => html`${i ? " or " : ""}${x.split(" ").map((y) => html`<kbd>${y}</kbd>`)}`)}</dt><dd>${d}</dd></div>`)}</dl>` });
}
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(document.activeElement); return; }
  if (document.querySelector(".dlg-scrim")) return;
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); openPalette(document.activeElement); }
  else if (e.key === "?") { e.preventDefault(); openShortcuts(document.activeElement); }
  else if (e.key === "Escape" && !pop.hidden) closeOverlays();
  else view.firstElementChild?.dispatchEvent(new CustomEvent("viewkey", { detail: e }));
});

// ---------- boot ----------
async function start() {
  history.scrollRestoration = "manual";
  try { await boot(); }
  catch (e) { setHTML(view, html`<div class="page">${errorCard(e)}</div>`); return; }
  channels().catch(() => {});
  api("/api/collections").then((c) => { store.collections = c; store.oppCount = c.find((x) => x.key === "sponsor_opportunity")?.messages; renderShell(resolve().nav); }).catch(() => {});
  const on = store.stats.claude;
  pill.classList.toggle("is-on", on);
  $("#ai-label").textContent = on ? "AI on" : "AI off";
  setHTML(pop, on
    ? html`<p><b>Claude is connected.</b> Reconnect briefs and Ask use your API key. Message search and everything else run on this computer.</p>`
    : html`<p><b>AI is off.</b> Reconnect briefs and Ask need a Claude API key. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart. Everything else works offline.</p>`);
  booted = true;
  addEventListener("hashchange", route);
  route();
}
start();
