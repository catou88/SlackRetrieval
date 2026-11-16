// Small inline labels: role chips, follow-up/contacted status, the "offered help" count and the
// LinkedIn icon buttons used on rows and badges.
import { html, icon } from "../utils/html.js";
import { formatIsoDate, pluralize } from "../utils/format.js";
import { nameOf, roleChipsOf, linkedInSlug, linkedInSearchUrl } from "../utils/people.js";
import { noteStatusOf } from "../utils/noteStatus.js";
import { teammateOf } from "../contexts/appState.js";

/** One role chip from roleChipsOf(). */
export function roleChip(chipData) {
  if (chipData.kind === "likely") return html`<span class="chip chip--likely" data-tip="${chipData.tip}">${chipData.label}</span>`;
  return html`<span class="chip tint-${chipData.kind}" aria-label="${chipData.aria || chipData.label}">${chipData.label}</span>`;
}

/** Up to `max` role chips, plus a "+N" chip when `showMore`. */
export function roleChips(person, max = 2, showMore = true) {
  const all = roleChipsOf(person, teammateOf(person.id));
  const shown = all.slice(0, max).map(roleChip);
  if (showMore && all.length > max) {
    const hiddenLabels = all.slice(max).map((chipData) => chipData.label).join(", ");
    shown.push(html`<span class="chip chip--more" aria-label="${hiddenLabels}" data-tip="${hiddenLabels}">+${all.length - max}</span>`);
  }
  return shown;
}

/** Contacted / follow-up chips from the person's note. */
export function statusChips(person) {
  const status = noteStatusOf(person);
  const chips = [];
  if (status.contacted) chips.push(html`<span class="chip tint-ok">${icon("check", "i i--12")}Contacted</span>`);
  if (status.followUp) {
    const when = status.overdue ? "overdue" : formatIsoDate(status.followUp);
    chips.push(html`<span class="chip ${status.due ? "tint-due" : "chip--quiet"}">Follow up · ${when}</span>`);
  }
  return chips;
}

/** "Offered help in N posts" chip; tooltip and screen-reader text say the same thing. */
export function offerChip(count) {
  const words = `Offered help in ${pluralize(count, "post")}`;
  return html`<span class="chip chip--offer" data-tip="${words}">${icon("handshake", "i i--12")}<span aria-hidden="true">${count}</span><span class="sr">${words}</span></span>`;
}

/**
 * LinkedIn actions with one consistent shape: [open or search] + [copy link or copy name], so
 * every row and badge has the same two slots.
 */
export function linkedInButtons(person, { isCompact = false } = {}) {
  const name = nameOf(person);
  const url = person.linkedin?.[0];
  if (!url) {
    return html`<a class="btn btn--icon btn--ghost" href="${linkedInSearchUrl(person)}" target="_blank" rel="noreferrer" aria-label="Search LinkedIn for ${name}" data-tip="Search LinkedIn for ${name}">${icon("search")}</a>
      <button class="btn btn--icon btn--ghost" type="button" data-copy="${name}" data-copy-msg="Copied name" aria-label="Copy ${name}'s name" data-tip="Copy name to search">${icon("copy")}</button>`;
  }
  return html`<a class="btn btn--icon ${isCompact ? "btn--ghost" : "btn--li"}" href="${url}" target="_blank" rel="noreferrer" aria-label="Open ${name}'s LinkedIn" data-tip="in/${linkedInSlug(url)}">${icon("linkedin")}</a>
    <button class="btn btn--icon btn--ghost" type="button" data-copy="${url}" data-copy-msg="Copied LinkedIn link" aria-label="Copy ${name}'s LinkedIn link" data-tip="Copy link">${icon("copy")}</button>`;
}
