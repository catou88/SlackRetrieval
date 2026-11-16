// Tooltips as one real element (#tip), shown on hover and keyboard focus. [data-tip] always shows;
// [data-tip-rail] shows only while the rail is collapsed to icons, where the labels are hidden.
import { findElement } from "../utils/dom.js";

const TOOLTIP_TARGET_SELECTOR = "[data-tip],[data-tip-rail]";
const ICON_RAIL_MEDIA_QUERY = "(min-width:768px) and (max-width:1023px)";
const VIEWPORT_MARGIN_PX = 4;
const RAIL_GAP_PX = 8;
const ABOVE_GAP_PX = 6;

/** Listen for hover, focus and scroll to show and hide the shared tooltip. */
export function wireTooltips() {
  const tooltip = findElement("#tip");
  const hideTooltip = () => (tooltip.hidden = true);
  const showForEventTarget = (event) => {
    const target = event.target.closest(TOOLTIP_TARGET_SELECTOR);
    if (target) showTooltip(tooltip, target);
    else hideTooltip();
  };
  document.addEventListener("pointerover", showForEventTarget);
  document.addEventListener("focusin", showForEventTarget);
  document.addEventListener("focusout", hideTooltip);
  addEventListener("scroll", hideTooltip, { passive: true });
}

// ---------- private helpers ----------

function tooltipText(target) {
  if (target.dataset.tip) return target.dataset.tip;
  const isIconRail = document.body.classList.contains("rail-icons") || matchMedia(ICON_RAIL_MEDIA_QUERY).matches;
  return isIconRail ? target.dataset.tipRail : "";
}

function showTooltip(tooltip, target) {
  const text = tooltipText(target);
  if (!text) return;
  tooltip.textContent = text;
  tooltip.hidden = false;
  const targetBox = target.getBoundingClientRect();
  const tooltipBox = tooltip.getBoundingClientRect();
  // Rail tooltips sit to the right of the icon; everything else sits above (or below near the top).
  const isRailTip = target.dataset.tipRail && !target.dataset.tip;
  const left = isRailTip ? targetBox.right + RAIL_GAP_PX : targetBox.left + targetBox.width / 2 - tooltipBox.width / 2;
  let top = isRailTip ? targetBox.top + targetBox.height / 2 - tooltipBox.height / 2 : targetBox.top - tooltipBox.height - ABOVE_GAP_PX;
  if (top < VIEWPORT_MARGIN_PX) top = targetBox.bottom + ABOVE_GAP_PX;
  tooltip.style.left = Math.max(VIEWPORT_MARGIN_PX, Math.min(innerWidth - tooltipBox.width - VIEWPORT_MARGIN_PX, left)) + "px";
  tooltip.style.top = top + "px";
}
