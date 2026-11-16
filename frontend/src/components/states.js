// Empty, loading and error states. Error cards explain what happened in plain words based on the
// ApiError code, and say what to do next.
import { html, rawHtml, icon } from "../utils/html.js";

const SKELETON_COUNT = 6;
// What each server error code means to the user, and what to do about it.
const ERROR_COPY = {
  claude_disabled: { title: "AI is off", body: "This needs a Claude API key. Add it to .env and restart Lanyard:", command: "ANTHROPIC_API_KEY=" },
  model_unavailable: { title: "Claude isn't reachable right now", body: "The API didn't answer. Check your connection or key, then retry." },
  model_timeout: { title: "Claude took too long", body: "The request timed out. Retrying usually works." },
  not_found: { title: "Not in the archive", body: "It may have been removed or never synced." },
  invalid_request: { title: "That request didn't work", body: "" },
};

/** Centered empty state. `body` and `actions` may be text or html``. */
export function emptyState({ icon: iconName = "info", title, body = "", actions = "" }) {
  return html`<div class="empty">${icon(iconName, "i i--20")}<h2 class="empty__title">${title}</h2>${body ? html`<p class="empty__body">${body}</p>` : ""}${actions ? html`<div class="empty__actions">${actions}</div>` : ""}</div>`;
}

/** Inline shell command with a copy button. */
export function commandSnippet(command) {
  return html`<span class="cmd"><code>${command}</code><button class="btn btn--icon btn--ghost btn--sm" type="button" data-copy="${command}" data-copy-msg="Copied command" aria-label="Copy command">${icon("copy")}</button></span>`;
}

/**
 * Error card with a retry button.
 * @param {Error} error  ApiError, NetError or anything else
 * @param {string} [retryAction]  data-action value the page listens for ("retry" reloads the route)
 */
export function errorCard(error, retryAction = "retry") {
  if (error?.name === "NetError") {
    return errorShell("Couldn't reach Lanyard", html`<p>The archive server isn't running. Start it with ${commandSnippet("npm start")}, then retry.</p>`, retryAction);
  }
  const copy = ERROR_COPY[error?.code];
  if (!copy) return errorShell("Couldn't load this", html`<p class="mono">${error?.message || String(error)}</p>`, retryAction);
  const detail = copy.body || error.message;
  const body = html`<p>${detail}${copy.command ? html` ${commandSnippet(copy.command)}` : ""}</p>`;
  // A missing key can't be fixed by retrying, so that card shows the setup command instead.
  return errorShell(copy.title, body, copy.command ? "" : retryAction);
}

/** Placeholder blocks while loading. */
export function loadingSkeleton(kind = "rows", count = SKELETON_COUNT) {
  return html`<div class="skel skel--${kind}" aria-hidden="true">${Array.from({ length: count }, () => rawHtml(`<div class="skel__item"></div>`))}</div>`;
}

/** "a · b · c" meta line; falsy parts are dropped. */
export function metaLine(parts) {
  return html`<p class="meta-line">${parts.filter(Boolean).map((part, i) => html`${i ? rawHtml('<span class="sep">·</span>') : ""}${part}`)}</p>`;
}

// ---------- private helpers ----------

function errorShell(title, body, retryAction) {
  const retryButton = retryAction ? html`<button class="btn btn--secondary" type="button" data-action="${retryAction}">${icon("refresh")}Retry</button>` : "";
  return html`<div class="errcard" role="alert"><h2>${title}</h2>${body}${retryButton}</div>`;
}
