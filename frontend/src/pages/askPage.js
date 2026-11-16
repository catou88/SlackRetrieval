// Ask: question → Claude answer with cited sources, optionally scoped to one person or mentors.
// With Claude off, the page is an empty state that points to search instead.
import { html, rawHtml, icon } from "../utils/html.js";
import { formatDate } from "../utils/format.js";
import { findElement, setHTML, announce } from "../utils/dom.js";
import { nameOf, matchPeople, cleanName } from "../utils/people.js";
import { renderMarkdown } from "../utils/markdown.js";
import { postJson } from "../services/api.js";
import { store } from "../contexts/appState.js";
import { replaceHashParams } from "../contexts/navigation.js";
import { personAvatar } from "../components/avatar.js";
import { emptyState, errorCard } from "../components/states.js";
import { archiveLinkFor } from "../components/message.js";
import { slackExcerpt } from "../components/slackText.js";

const EXAMPLE_QUESTIONS = ["Who offered resume reviews?", "Which sponsors are hiring interns?", "What did judges say about demos?"];
const MAX_PICKER_MATCHES = 6;
const MAX_SOURCES = 12;
const MAX_INPUT_LINES = 8;
const INPUT_LINE_HEIGHT_PX = 22;
const INPUT_PADDING_PX = 20;
const SLOW_ANSWER_MS = 10000;
// Lets a click on a picker option land before the list hides on blur.
const PICKER_BLUR_DELAY_MS = 100;

/** Document title for Ask. */
export function pageTitle() {
  return "Ask";
}

/** Render Ask into `root`. */
export async function renderPage(root, { params }) {
  if (!store.stats.claude) {
    setHTML(root, renderClaudeOffState());
    return;
  }
  setHTML(root, renderAskForm(params.get("q") || ""));
  const ask = {
    root,
    questionInput: findElement("#aq", root),
    answerBox: findElement("#answer", root),
    personInput: findElement("#who", root),
    personList: findElement("#who-list", root),
    personId: null,
  };
  wirePersonPicker(ask);
  wireQuestionInput(ask);
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    submitQuestion(ask);
  });
  root.addEventListener("click", (event) => {
    const exampleButton = event.target.closest("[data-try]");
    if (exampleButton) {
      ask.questionInput.value = exampleButton.dataset.try;
      growQuestionInput(ask.questionInput);
      submitQuestion(ask);
    }
    if (event.target.closest("[data-action=ask]")) submitQuestion(ask);
  });
  growQuestionInput(ask.questionInput);
  if (params.get("q")) submitQuestion(ask);
}

// ---------- private helpers ----------

function renderClaudeOffState() {
  return html`<header class="page-head ask-head"><h1 class="title">Ask your archive</h1></header>
      ${emptyState({ icon: "sparkles", title: "Ask needs a Claude API key",
        body: html`Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart Lanyard. Until then, search finds messages by meaning or by exact words, all on this computer.`,
        actions: html`<a class="btn btn--primary" href="#/archive/search">${icon("search")}Search the archive</a>
          <button class="btn btn--secondary" type="button" data-copy="ANTHROPIC_API_KEY=" data-copy-msg="Copied setup line">${icon("copy")}<span class="btn__label">Copy setup line</span></button>` })}
      <div class="ask-try"><p class="eyebrow">Questions you could ask once it's on</p><ul class="bare">${EXAMPLE_QUESTIONS.map((question) => html`<li><a href="#/archive/search?mode=semantic&q=${encodeURIComponent(question)}">${question}</a><span class="faint small"> · search by meaning instead</span></li>`)}</ul></div>`;
}

function renderAskForm(initialQuestion) {
  return html`<header class="page-head ask-head"><h1 class="title">Ask your archive</h1>
      <p class="lede">Claude answers from your saved messages and cites them.</p></header>
    <form class="ask" id="ask">
      <label class="sr" for="aq">Question</label>
      <textarea class="ask__input" id="aq" rows="3" placeholder="What do you want to know?">${initialQuestion}</textarea>
      <div class="ask__bar">
        <div class="ask__scope">
          <span class="picker"><label class="sr" for="who">Only messages from</label><input class="input" id="who" placeholder="Anyone" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="who-list"><ul class="picker__list bare" id="who-list" role="listbox" hidden></ul></span>
          <label class="check"><input type="checkbox" id="mentors"> Mentors only</label>
        </div>
        <button class="btn btn--primary" type="submit" id="ask-btn">${icon("sparkles")}<span>Ask</span><kbd>↵</kbd></button>
      </div>
    </form>
    <div class="fchips ask-tries">${EXAMPLE_QUESTIONS.map((question) => html`<button class="fchip" type="button" data-try="${question}">${question}</button>`)}</div>
    <div id="answer" aria-live="polite"></div>`;
}

// The textarea grows with its content up to MAX_INPUT_LINES, then scrolls.
function growQuestionInput(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, MAX_INPUT_LINES * INPUT_LINE_HEIGHT_PX + INPUT_PADDING_PX) + "px";
}

function wireQuestionInput(ask) {
  ask.questionInput.addEventListener("input", () => growQuestionInput(ask.questionInput));
  // Enter asks; Shift+Enter adds a line.
  ask.questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask.root.querySelector("form").requestSubmit();
    }
  });
}

function wirePersonPicker(ask) {
  const { personInput, personList } = ask;
  personInput.addEventListener("input", () => {
    const matches = matchPeople(personInput.value, store.people, MAX_PICKER_MATCHES);
    ask.personId = null;
    personList.hidden = !matches.length;
    personInput.setAttribute("aria-expanded", String(!!matches.length));
    setHTML(personList, html`${matches.map((person) => html`<li role="option" data-pid="${person.id}">${personAvatar(person, 28)}${nameOf(person)}</li>`)}`);
  });
  // mousedown (not click) so the choice lands before the input's blur hides the list.
  personList.addEventListener("mousedown", (event) => {
    const option = event.target.closest("[data-pid]");
    if (!option) return;
    event.preventDefault();
    ask.personId = option.dataset.pid;
    personInput.value = nameOf(store.peopleById.get(ask.personId));
    personList.hidden = true;
  });
  personInput.addEventListener("blur", () => setTimeout(() => (personList.hidden = true), PICKER_BLUR_DELAY_MS));
}

async function submitQuestion(ask) {
  const question = ask.questionInput.value.trim();
  if (!question) return;
  replaceHashParams({ q: question });
  const button = findElement("#ask-btn", ask.root);
  const buttonLabel = button.querySelector("span");
  setBusy(button, buttonLabel, true);
  const slowNotice = setTimeout(() => (buttonLabel.textContent = "Still working. Claude can take about 20 seconds."), SLOW_ANSWER_MS);
  try {
    const { answer, sources } = await postJson("/api/ask", { question, person: ask.personId, mentors: findElement("#mentors", ask.root).checked });
    setHTML(ask.answerBox, renderAnswer(answer, sources));
    announce("Answer ready");
  } catch (error) {
    setHTML(ask.answerBox, errorCard(error, "ask"));
  }
  clearTimeout(slowNotice);
  setBusy(button, buttonLabel, false);
}

function setBusy(button, buttonLabel, isBusy) {
  if (isBusy) button.setAttribute("aria-disabled", "true");
  else button.removeAttribute("aria-disabled");
  button.classList.toggle("is-busy", isBusy);
  buttonLabel.textContent = isBusy ? "Thinking…" : "Ask";
}

function renderAnswer(answer, sources) {
  const sourceList = sources?.length
    ? html`<h2 class="eyebrow src-h">Sources</h2><ol class="sources">${sources.slice(0, MAX_SOURCES).map(renderSource)}</ol>`
    : "";
  return html`<article class="answer">${rawHtml(renderMarkdown(answer, { cite: true }))}</article>
        ${sourceList}`;
}

// Numbered to match the [n] citations in the answer, which link to #src-n.
function renderSource(source, index) {
  const person = store.peopleById.get(source.user_id);
  const number = index + 1;
  return html`<li id="src-${number}"><span class="num faint">${number}</span>${personAvatar(person, 28, source.user_name)}<div><b>${person ? nameOf(person) : cleanName(source.user_name)}</b> <span class="num faint">${source.channel} · ${formatDate(source.date)}</span><p>${slackExcerpt(source.text, 200)}</p><a class="msg__jump" href="${archiveLinkFor(source)}">Jump to message ${icon("arrow-right", "i i--12")}</a></div></li>`;
}
