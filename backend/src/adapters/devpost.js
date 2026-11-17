// Adapter for Devpost: San Francisco + 2026 hackathons, their galleries with
// winner badges, project pages (links, stack, team, prizes), profile pages and
// prize sponsors. The parse* functions are pure (HTML/JSON in, records out) so
// they are tested against saved fixtures; fetchRecords only wires them to the
// polite fetcher. Selectors follow Devpost's markup and must be re-validated
// against live captures (plan task L1).
import * as cheerio from "cheerio";
import { makeRecord } from "../lib/records.js";

export const name = "devpost";

const TARGET_CITY = "san francisco";
const TARGET_YEAR = 2026;
const GITHUB_RE = /^https?:\/\/(www\.)?github\.com\/[^/\s]+(\/[^/\s?#]+)?\/?$/i;
const HF_RE = /^https?:\/\/(www\.)?huggingface\.co\//i;
const LINKEDIN_RE = /^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i;
const MAX_HACKATHONS_DEFAULT = 5;
const LIST_URL = "https://devpost.com/api/hackathons?status[]=ended&page=";

/**
 * Fetch records for SF 2026 hackathons.
 * @param {{ maxHackathons?: number, maxPages?: number }} options
 * @param {{ http: { getText(url: string): Promise<string>, getJson(url: string): Promise<any> } }} deps
 * @returns {Promise<object[]>}
 */
export async function fetchRecords(options, { http }) {
  const records = [];
  const max = options.maxHackathons ?? MAX_HACKATHONS_DEFAULT;
  const hackathons = [];
  for (let page = 1; page <= (options.maxPages ?? 3) && hackathons.length < max; page++) {
    hackathons.push(...selectTargetHackathons(await http.getJson(`${LIST_URL}${page}`)));
  }
  for (const hackathon of hackathons.slice(0, max)) {
    const prizeList = parsePrizes(await http.getText(`${hackathon.url}details/prizes`).catch(() => ""));
    records.push(makeRecord("hackathon", name, hackathon.url, { ...hackathon.data, sponsors: sponsorsOf(prizeList) }));
    const gallery = parseGallery(await http.getText(`${hackathon.url}project-gallery`), hackathon.url).filter((g) => g.isWinner);
    for (const item of gallery) records.push(...(await projectRecords(item, hackathon, prizeList, http)));
  }
  return records;
}

/**
 * Keep only hackathons located in San Francisco whose dates touch 2026.
 * @param {{ hackathons: object[] }} listing  Devpost API response
 * @returns {{ url: string, data: object }[]}
 */
export function selectTargetHackathons(listing) {
  return (listing.hackathons ?? [])
    .filter((h) => (h.displayed_location?.location ?? "").toLowerCase().includes(TARGET_CITY))
    .map((h) => ({ url: h.url, title: h.title, years: yearsIn(h.submission_period_dates), dates: h.submission_period_dates }))
    .filter((h) => h.years.includes(TARGET_YEAR))
    .map((h) => ({ url: h.url, data: { name: h.title, city: "San Francisco", region: "CA", year: Math.max(...h.years), url: h.url, dates: h.dates } }));
}

/**
 * @param {string} html  a hackathon's project-gallery page
 * @param {string} baseUrl  used to resolve relative links
 * @returns {{ url: string, title: string, isWinner: boolean }[]}
 */
export function parseGallery(html, baseUrl) {
  const $ = cheerio.load(html);
  return $(".gallery-item").map((_, el) => {
    const link = $(el).find("a.link-to-software").first();
    return {
      url: new URL(link.attr("href") ?? "", baseUrl).href,
      title: link.find("h5").text().trim() || link.text().trim(),
      isWinner: $(el).find(".winner").length > 0,
    };
  }).get().filter((item) => item.url && item.title);
}

/**
 * @param {string} html  a Devpost project page
 * @returns {object} project data (without hackathon linkage)
 */
export function parseProject(html) {
  const $ = cheerio.load(html);
  const links = $("nav.app-links a, #app-links a").map((_, a) => $(a).attr("href")).get();
  return {
    title: $("#app-title").text().trim(),
    tagline: $("p.large").first().text().trim(),
    description: $("#app-details-left").text().replace(/\s+/g, " ").trim(),
    builtWith: $("#built-with .cp-tag").map((_, t) => $(t).text().trim()).get(),
    githubUrl: links.find((l) => GITHUB_RE.test(l)) ?? null,
    hfUrl: links.find((l) => HF_RE.test(l)) ?? null,
    prizes: $(".software-list-content li").map((_, li) => ({
      name: $(li).clone().find(".label").remove().end().text().trim(),
      isWinner: $(li).find(".winner").length > 0,
    })).get().filter((p) => p.name),
    members: $(".software-team-member a.user-profile-link").map((_, a) => ({ name: $(a).text().trim(), url: $(a).attr("href") })).get(),
  };
}

/**
 * LinkedIn is only read from links the person published on their own profile.
 * @param {string} html  a Devpost profile page
 * @returns {{ name: string, bio: string, githubUrl: string | null, linkedinUrl: string | null }}
 */
export function parseProfile(html) {
  const $ = cheerio.load(html);
  const links = $("#portfolio-user-links a").map((_, a) => $(a).attr("href")).get();
  return {
    name: $("#portfolio-user-name").text().trim(),
    bio: $("#portfolio-user-bio").text().trim(),
    githubUrl: links.find((l) => GITHUB_RE.test(l)) ?? null,
    linkedinUrl: links.find((l) => LINKEDIN_RE.test(l)) ?? null,
  };
}

/**
 * @param {string} html  a hackathon's prizes page
 * @returns {{ name: string, sponsor: string | null }[]}
 */
export function parsePrizes(html) {
  const $ = cheerio.load(html);
  return $(".prize").map((_, el) => {
    const sponsor = $(el).find(".sponsor").text().replace(/^\s*sponsored by\s*/i, "").trim();
    return { name: $(el).find("h6").text().trim(), sponsor: sponsor || null };
  }).get().filter((p) => p.name);
}

/**
 * Attach the sponsor of each prize by exact (case-insensitive) prize-name match;
 * a prize not on the list keeps sponsor null rather than a guess.
 * @param {{ name: string, isWinner: boolean }[]} projectPrizes
 * @param {{ name: string, sponsor: string | null }[]} prizeList
 */
export function linkPrizeSponsors(projectPrizes, prizeList) {
  const sponsorByPrize = new Map(prizeList.map((p) => [p.name.toLowerCase(), p.sponsor]));
  return projectPrizes.map((p) => ({ ...p, sponsor: sponsorByPrize.get(p.name.toLowerCase()) ?? null }));
}

// ---------------------------------------------------------------- private helpers
function yearsIn(dateText = "") {
  return [...dateText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
}

function sponsorsOf(prizeList) {
  const names = [...new Set(prizeList.map((p) => p.sponsor).filter(Boolean))];
  return names.map((sponsorName) => ({ name: sponsorName }));
}

async function projectRecords(item, hackathon, prizeList, http) {
  const project = parseProject(await http.getText(item.url));
  const members = [];
  const personRecords = [];
  for (const member of project.members) {
    const profile = parseProfile(await http.getText(member.url).catch(() => ""));
    members.push(member);
    personRecords.push(makeRecord("person", name, member.url, {
      name: member.name, devpostUrl: member.url, githubUrl: profile.githubUrl, linkedinUrl: profile.linkedinUrl, bio: profile.bio || null,
    }));
  }
  const projectRecord = makeRecord("project", name, item.url, {
    ...project, devpostUrl: item.url, hackathonUrl: hackathon.url, hackathonName: hackathon.data.name,
    prizes: linkPrizeSponsors(project.prizes, prizeList), members,
  });
  return [projectRecord, ...personRecords];
}
