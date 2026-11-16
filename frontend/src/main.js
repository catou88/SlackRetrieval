// Entry point: loads session data, applies the theme, wires the shell and the app-wide delegated
// listeners, then starts the hash router. The only module with import-time side effects.
import { html } from "./utils/html.js";
import { findElement, setHTML } from "./utils/dom.js";
import { invalidateCache } from "./services/api.js";
import { store, loadInitialState, loadChannels, loadCollections } from "./contexts/appState.js";
import { markLinkNavigation } from "./contexts/navigation.js";
import { applyTheme, currentTheme, cycleTheme } from "./contexts/theme.js";
import { renderNavigation, renderAiStatus, wireAiStatusPopover } from "./components/appShell.js";
import { fallbackToMonogram } from "./components/avatar.js";
import { openPalette } from "./components/commandPalette.js";
import { handleCopyButton } from "./components/copyButton.js";
import { toggleClamp, toggleThread } from "./components/message.js";
import { openShortcutsDialog, handleGlobalKeydown } from "./components/shortcutsDialog.js";
import { errorCard } from "./components/states.js";
import { wireTooltips } from "./components/tooltip.js";
import { resolveRoute, showCurrentRoute } from "./router.js";

const pageContainer = findElement("#view");

wireShell();
startApp();

// ---------- private helpers ----------

function wireShell() {
  for (const selector of ["#theme-btn", "#theme-btn-m"]) findElement(selector).addEventListener("click", cycleTheme);
  applyTheme(currentTheme());
  wireAiStatusPopover();
  wireTooltips();
  document.addEventListener("click", rememberLinkNavigation);
  document.addEventListener("click", handleDelegatedClick);
  document.addEventListener("keydown", (event) => handleGlobalKeydown(event, pageContainer));
  // Error events don't bubble, so one capturing listener catches every broken avatar image.
  document.addEventListener("error", (event) => fallbackToMonogram(event.target), true);
}

async function startApp() {
  history.scrollRestoration = "manual";
  try {
    await loadInitialState();
  } catch (error) {
    setHTML(pageContainer, html`<div class="page">${errorCard(error)}</div>`);
    return;
  }
  // Warm caches the palette and nav counts use; failures only cost those extras.
  loadChannels().catch(() => {});
  loadCollections().then(() => renderNavigation(resolveRoute().nav)).catch(() => {});
  renderAiStatus(store.stats.claude);
  addEventListener("hashchange", showCurrentRoute);
  showCurrentRoute();
}

// Plain clicks on in-app links scroll the next page to the top; Ctrl/Cmd-clicks open new tabs.
function rememberLinkNavigation(event) {
  const link = event.target.closest("a[href^='#/'], a[href='#/']");
  if (link && !event.metaKey && !event.ctrlKey) markLinkNavigation();
}

// Buttons anywhere in the app declare their behaviour with data attributes.
function handleDelegatedClick(event) {
  const target = event.target;
  const copyButton = target.closest("[data-copy]");
  if (copyButton) {
    event.preventDefault();
    handleCopyButton(copyButton);
    return;
  }
  const clampToggle = target.closest("[data-unclamp]");
  if (clampToggle) {
    toggleClamp(clampToggle);
    return;
  }
  const threadToggle = target.closest("[data-thread]");
  if (threadToggle) toggleThread(threadToggle);
  const paletteButton = target.closest("[data-open-palette]");
  if (paletteButton) openPalette(paletteButton);
  const shortcutsButton = target.closest("[data-open-shortcuts]");
  if (shortcutsButton) openShortcutsDialog(shortcutsButton);
  if (target.closest("[data-action=retry]")) {
    invalidateCache("/api/");
    showCurrentRoute();
  }
}
