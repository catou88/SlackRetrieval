// Ask the winners: questions answered by Qwen from the hackathon database, with numbered citations.
// "I don't know" is a normal outcome when the database has no evidence.
import { html } from "../utils/html.js";
import { findElement, setHTML } from "../utils/dom.js";
import { askIntel } from "../services/intelApi.js";
import { errorCard } from "../components/states.js";

const EXAMPLE_QUESTION = "Which winners used LangGraph?";

/** Document title for Ask winners. */
export function pageTitle() {
  return "Ask winners";
}

/** Render the page into `root`. */
export async function renderPage(root) {
  setHTML(root, html`
    <header class="page-head"><h1 class="title">Ask the winners</h1>
      <p class="lede">Answers come only from the stored hackathon projects and cite them. Needs a running Qwen model (see README).</p></header>
    <form class="toolbar" aria-label="Ask a question">
      <label class="field"><span class="sr">Question</span><input class="input" id="iq" maxlength="1000" placeholder="${EXAMPLE_QUESTION}" autocomplete="off" required></label>
      <button class="btn btn--primary" type="submit">Ask</button>
    </form>
    <div id="answer" aria-live="polite"></div>`);
  const input = findElement("#iq", root);
  const out = findElement("#answer", root);
  let pending = false;
  findElement("form", root).addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending) return; // one model call at a time
    const question = input.value.trim();
    if (!question) return;
    setHTML(out, html`<p class="meta-line">Thinking…</p>`);
    pending = true;
    try {
      const result = await askIntel(question);
      setHTML(out, renderAnswer(result));
    } catch (error) {
      setHTML(out, errorCard(error, ""));
    } finally {
      pending = false;
    }
  });
}

// ---------- private helpers ----------

function renderAnswer(result) {
  return html`<section class="card intel-card"><p>${result.answer}</p>
    ${result.citations?.length ? html`<h2 class="sec-head">Sources</h2><ol class="intel-why">${result.citations.map((c) =>
      html`<li>${c.title} <span class="meta-line">(${c.label})</span></li>`)}</ol>` : ""}</section>`;
}
