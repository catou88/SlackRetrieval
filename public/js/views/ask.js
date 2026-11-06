// Ask: question → Claude answer with cited sources. With Claude off, the view is an empty state.
import { html, raw, icon, date, setHTML, $, replaceParams, announce, copyText } from "../html.js";
import { store, post, nameOf, matchPeople, cleanName } from "../store.js";
import { empty, cmd, avatar, errorCard, archiveHref } from "../ui.js";
import { plain } from "../slack.js";
import { md } from "./brief.js";

export const title = () => "Ask";
const TRY = ["Who offered resume reviews?", "Which sponsors are hiring interns?", "What did judges say about demos?"];

export async function render(el, { params }) {
  if (!store.stats.claude) {
    setHTML(el, html`<header class="page-head ask-head"><h1 class="title">Ask your archive</h1></header>
      ${empty({ icon: "sparkles", title: "Ask needs a Claude API key",
        body: html`Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart Lanyard. Until then, search finds messages by meaning or by exact words, all on this computer.`,
        actions: html`<a class="btn btn--primary" href="#/archive/search">${icon("search")}Search the archive</a>
          <button class="btn btn--secondary" type="button" data-copy="ANTHROPIC_API_KEY=" data-copy-msg="Copied setup line">${icon("copy")}<span class="btn__label">Copy setup line</span></button>` })}
      <div class="ask-try"><p class="eyebrow">Questions you could ask once it's on</p><ul class="bare">${TRY.map((t) => html`<li><a href="#/archive/search?mode=semantic&q=${encodeURIComponent(t)}">${t}</a><span class="faint small"> · search by meaning instead</span></li>`)}</ul></div>`);
    return;
  }
  let person = null;
  setHTML(el, html`<header class="page-head ask-head"><h1 class="title">Ask your archive</h1>
      <p class="lede">Claude answers from your saved messages and cites them.</p></header>
    <form class="ask" id="ask">
      <label class="sr" for="aq">Question</label>
      <textarea class="ask__input" id="aq" rows="3" placeholder="What do you want to know?">${params.get("q") || ""}</textarea>
      <div class="ask__bar">
        <div class="ask__scope">
          <span class="picker"><label class="sr" for="who">Only messages from</label><input class="input" id="who" placeholder="Anyone" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="who-list"><ul class="picker__list bare" id="who-list" role="listbox" hidden></ul></span>
          <label class="check"><input type="checkbox" id="mentors"> Mentors only</label>
        </div>
        <button class="btn btn--primary" type="submit" id="ask-btn">${icon("sparkles")}<span>Ask</span><kbd>↵</kbd></button>
      </div>
    </form>
    <div class="fchips ask-tries">${TRY.map((t) => html`<button class="fchip" type="button" data-try="${t}">${t}</button>`)}</div>
    <div id="answer" aria-live="polite"></div>`);
  const ta = $("#aq", el), out = $("#answer", el), who = $("#who", el), list = $("#who-list", el);
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 8 * 22 + 20) + "px"; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.querySelector("form").requestSubmit(); } });
  who.addEventListener("input", () => {
    const m = matchPeople(who.value, 6);
    person = null;
    list.hidden = !m.length; who.setAttribute("aria-expanded", String(!!m.length));
    setHTML(list, html`${m.map((p) => html`<li role="option" data-pid="${p.id}">${avatar(p, 28)}${nameOf(p)}</li>`)}`);
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("[data-pid]"); if (li) { e.preventDefault(); person = li.dataset.pid; who.value = nameOf(store.byId.get(person)); list.hidden = true; } });
  who.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));

  async function ask() {
    const question = ta.value.trim();
    if (!question) return;
    replaceParams({ q: question });
    const btn = $("#ask-btn", el), lab = btn.querySelector("span");
    btn.setAttribute("aria-disabled", "true"); btn.classList.add("is-busy"); lab.textContent = "Thinking…";
    const slow = setTimeout(() => (lab.textContent = "Still working. Claude can take about 20 seconds."), 10000);
    try {
      const { answer, sources } = await post("/api/ask", { question, person, mentors: $("#mentors", el).checked });
      setHTML(out, html`<article class="answer">${raw(md(answer, { cite: true }))}</article>
        ${sources?.length ? html`<h2 class="eyebrow src-h">Sources</h2><ol class="sources">${sources.slice(0, 12).map((s, i) => {
          const p = store.byId.get(s.user_id);
          return html`<li id="src-${i + 1}"><span class="num faint">${i + 1}</span>${avatar(p, 28, s.user_name)}<div><b>${p ? nameOf(p) : cleanName(s.user_name)}</b> <span class="num faint">${s.channel} · ${date(s.date)}</span><p>${plain(s.text, 200)}</p><a class="msg__jump" href="${archiveHref(s)}">Jump to message ${icon("arrow-right", "i i--12")}</a></div></li>`;
        })}</ol>` : ""}`);
      announce("Answer ready");
    } catch (e) { setHTML(out, errorCard(e, "ask")); }
    clearTimeout(slow);
    btn.removeAttribute("aria-disabled"); btn.classList.remove("is-busy"); lab.textContent = "Ask";
  }
  el.addEventListener("submit", (e) => { e.preventDefault(); ask(); });
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-try]");
    if (t) { ta.value = t.dataset.try; grow(); ask(); }
    if (e.target.closest("[data-action=ask]")) ask();
  });
  grow();
  if (params.get("q")) ask();
}
