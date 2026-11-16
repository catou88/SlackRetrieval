// People cards: the Name Tag badge (grids), the compact mini row (Home lanes) and the person row
// (lists). Badges skip the role in their footer because the strip and chip already say it.
import { html, icon } from "../utils/html.js";
import { formatNumber } from "../utils/format.js";
import { nameOf, howYouMet, subtitleOf, roleChipsOf, roleStripOf } from "../utils/people.js";
import { noteStatusOf } from "../utils/noteStatus.js";
import { teammateOf } from "../contexts/appState.js";
import { personAvatar } from "./avatar.js";
import { roleChip, roleChips, offerChip, linkedInButtons } from "./chips.js";

/**
 * Name Tag badge.
 * @param {object} person
 * @param {{reason?: any, isTilted?: boolean, offers?: number}} [options]  reason is html`` or text
 */
export function nameTagBadge(person, { reason = "", isTilted = false, offers = 0 } = {}) {
  const status = noteStatusOf(person);
  const subtitle = subtitleOf(person);
  const footer = howYouMet(person, teammateOf(person.id), { includeRole: false });
  return html`<article class="badge${isTilted ? " badge--tilt" : ""}" data-strip="${roleStripOf(person, teammateOf(person.id))}" ${status.contacted ? "data-contacted" : ""}>
    <span class="badge__strip" aria-hidden="true"></span><span class="badge__slot" aria-hidden="true"></span>
    ${personAvatar(person, 56)}
    <h3 class="badge__name"><a href="#/people/${person.id}">${nameOf(person)}</a></h3>
    ${subtitle ? html`<p class="badge__line">${subtitle}</p>` : ""}
    <div class="badge__chips">${roleChips(person)}${status.contacted ? html`<span class="chip tint-ok">${icon("check", "i i--12")}Contacted</span>` : ""}${offers ? offerChip(offers) : ""}</div>
    ${reason ? html`<p class="badge__reason">${reason}</p>` : ""}
    <div class="badge__actions">${linkedInButtons(person, { isCompact: true })}</div>
    <footer class="badge__meta">${footer || messageCountLine(person)}</footer>
  </article>`;
}

/**
 * Compact row for Home lanes: avatar + name + sub-line (+ first role chip) + LinkedIn.
 * @param {{showChip?: boolean}} [options]  lanes titled by role pass false so the chip isn't repeated
 */
export function miniPersonRow(person, subLine, { showChip = true } = {}) {
  const firstChip = showChip && roleChipsOf(person, teammateOf(person.id))[0];
  const url = person.linkedin?.[0];
  return html`<li class="mini">
    ${personAvatar(person, 28)}
    <span class="mini__body"><a class="mini__name" href="#/people/${person.id}">${nameOf(person)}</a><span class="mini__sub">${subLine ?? howYouMet(person, teammateOf(person.id))}</span></span>
    ${firstChip ? roleChip(firstChip) : ""}
    ${url ? html`<a class="btn btn--icon btn--ghost btn--sm" href="${url}" target="_blank" rel="noreferrer" aria-label="Open ${nameOf(person)}'s LinkedIn">${icon("linkedin")}</a>` : ""}
  </li>`;
}

/**
 * List row with a reason line, for long lists where a badge grid becomes a wall.
 * @param {{reason?: any, meta?: string}} [options]
 */
export function personRow(person, { reason = "", meta = "" } = {}) {
  return html`<li class="trow">
    ${personAvatar(person, 40)}
    <div class="trow__id"><a class="trow__name" href="#/people/${person.id}">${nameOf(person)}</a>
      ${reason ? html`<span class="trow__reason">${reason}</span>` : ""}</div>
    <span class="trow__meta num">${meta}</span>
    <div class="trow__actions">${linkedInButtons(person, { isCompact: true })}</div>
  </li>`;
}

// ---------- private helpers ----------

function messageCountLine(person) {
  return person.message_count ? `${formatNumber(person.message_count)} messages` : "—";
}
