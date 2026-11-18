// Practice: get a real past prize track, brainstorm against a timer, then reveal who actually won it.
import { html } from "../utils/html.js";
import { findElement, setHTML, announce } from "../utils/dom.js";
import { fetchPracticeTrack, revealPracticeTrack } from "../services/intelApi.js";
import { emptyState, errorCard } from "../components/states.js";

const SECOND_MS = 1000;
const SECONDS_PER_MINUTE = 60;

/** Document title for Practice. */
export function pageTitle() {
  return "Practice";
}

/** Render Practice into `root`; returns a cleanup that stops the timer. */
export async function renderPage(root) {
  let timer;
  let run = 0; // bumped per track so late responses from an earlier track are dropped
  const stopTimer = () => clearInterval(timer);

  async function start() {
    stopTimer();
    const myRun = ++run;
    let pick;
    try {
      pick = await fetchPracticeTrack();
    } catch (error) {
      if (myRun === run) setHTML(root, errorCard(error));
      return;
    }
    if (myRun !== run) return;
    if (!pick.track) {
      setHTML(root, emptyState({ icon: "sparkles", title: "No past tracks yet", body: "Ingest hackathon winners first (npm run intel:ingest)." }));
      return;
    }
    setHTML(root, renderPrompt(pick));
    timer = runTimer(root, pick.minutes * SECONDS_PER_MINUTE);
    findElement("#track", root).focus(); // the clicked button was replaced; keep keyboard users oriented
  }

  root.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "again") return start();
    if (action !== "reveal") return;
    stopTimer();
    const myRun = run;
    const { hackathon, prize } = event.target.closest("[data-action]").dataset;
    try {
      const { winners } = await revealPracticeTrack({ hackathonId: hackathon, prize });
      if (myRun === run) setHTML(findElement("#reveal", root), renderWinners(winners));
    } catch (error) {
      if (myRun === run) setHTML(findElement("#reveal", root), errorCard(error));
    }
  });
  await start();
  return stopTimer;
}

// ---------- private helpers ----------

function runTimer(root, totalSeconds) {
  const deadline = Date.now() + totalSeconds * SECOND_MS; // wall clock: survives throttled background tabs
  let left = totalSeconds;
  const clock = findElement("#clock", root);
  const draw = () => { clock.textContent = `${Math.floor(left / SECONDS_PER_MINUTE)}:${String(left % SECONDS_PER_MINUTE).padStart(2, "0")}`; };
  draw();
  return setInterval(() => {
    left = Math.max(0, Math.ceil((deadline - Date.now()) / SECOND_MS));
    draw();
    if (left === 0) announce("Time is up");
  }, SECOND_MS);
}

function renderPrompt({ track, minutes }) {
  return html`
    <header class="page-head"><h1 class="title">Practice</h1>
      <p class="lede">Pitch a project for this real prize track before looking at who won.</p></header>
    <section class="card intel-card" aria-labelledby="track">
      <h2 class="intel-card__title" id="track" tabindex="-1">${track.prize}</h2>
      <p class="meta-line">${track.hackathon || "Unknown hackathon"}${track.sponsor ? ` · sponsored by ${track.sponsor}` : ""}</p>
      <p>${minutes} minutes: pick a problem, a user, a stack and a demo you could finish in a weekend.</p>
      <p class="intel-clock" role="timer" aria-label="Time left"><span id="clock">--:--</span></p>
      <p class="intel-links">
        <button class="btn btn--primary" type="button" data-action="reveal" data-hackathon="${track.hackathonId}" data-prize="${track.prize}">Reveal winners</button>
        <button class="btn btn--secondary" type="button" data-action="again">Another track</button></p>
    </section>
    <div id="reveal" class="intel-section" aria-live="polite"></div>`;
}

function renderWinners(winners) {
  if (!winners.length) return html`<p class="meta-line">No winners recorded for this track.</p>`;
  return html`<h2 class="sec-head">Who won</h2><ul class="intel-members">${winners.map((w) =>
    html`<li class="card intel-member"><h3 class="intel-member__name"><a href="#/winners/${w.id}">${w.title}</a></h3><p>${w.tagline || ""}</p></li>`)}</ul>`;
}
