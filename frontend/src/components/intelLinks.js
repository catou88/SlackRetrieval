// External links for hackathon data (Devpost, GitHub, LinkedIn…): shown only when the URL is safe https.
import { html, NEW_TAB_NOTICE } from "../utils/html.js";
import { safeHttpsUrl } from "../utils/safeLink.js";

/** One external link, or nothing when `url` is missing or unsafe. */
export function externalLink(label, url) {
  const href = safeHttpsUrl(url);
  return href ? html`<a class="linkbtn" href="${href}" target="_blank" rel="noopener noreferrer">${label}${NEW_TAB_NOTICE}</a>` : "";
}

/** Row of links for a project or person; `links` maps label to url. */
export function linkRow(links) {
  const rendered = Object.entries(links).map(([label, url]) => externalLink(label, url)).filter(Boolean);
  return rendered.length ? html`<p class="intel-links">${rendered}</p>` : "";
}
