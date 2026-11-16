// Pure people helpers: display names, roles (the single source of truth for role chips, badge
// strips and "how you met"), search matching and sponsor company grouping. Nothing here reads app
// state: callers pass the person and, where it matters, their teammate record.

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const NAME_TAG_RE = /\s*[[(][^\])]{2,40}[\])]/g;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;
const LINKEDIN_PREFIX_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in\/)?/i;
const ROLE_WORD_TITLES = new Set(["mentor", "judge", "sponsor", "organizer", "hacker"]);
const SPONSOR_CHANNEL_RE = /^#?(?:spons|cohost|partner)[-_](.+)$/i;
const UPPERCASE_WORDS = new Set(["ai", "yc", "mlh", "api", "crs", "si", "dev", "ibm", "aws"]);
const MATCH_SCORE = { prefix: 3, wordStart: 2, substring: 1 };
const MENTOR_MATCH_BONUS = 0.5;
const DM_MATCH_BONUS_CAP = 20;

/** Display name without Slack name-tag suffixes ("Ana [Mentor]") or invisible characters. */
export function cleanName(name, handle) {
  const cleaned = String(name || "").replace(ZERO_WIDTH_RE, "").replace(NAME_TAG_RE, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || String(handle || "").replace(ZERO_WIDTH_RE, "") || "Unknown";
}

/** A person's display name. */
export function nameOf(person) {
  return cleanName(person?.name, person?.handle);
}

/** First word of the display name. */
export function firstName(person) {
  return nameOf(person).split(/\s+/)[0];
}

/**
 * The name to greet someone by in a draft, or null when all we have is a raw Slack user id.
 * Handles like "pavan.singara" become "Pavan".
 */
export function greetingName(person) {
  const name = nameOf(person);
  if (SLACK_USER_ID_RE.test(name) || name === "Unknown") return null;
  const first = name.split(/[\s.]+/).filter(Boolean)[0] || "";
  if (!first || SLACK_USER_ID_RE.test(first)) return null;
  return first === first.toLowerCase() ? first[0].toUpperCase() + first.slice(1) : first;
}

/** Up to two initials for the avatar monogram. */
export function initials(name) {
  const words = cleanName(name).replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return ((words[0]?.[0] || "?") + last).toUpperCase();
}

/** "https://www.linkedin.com/in/ana-b/?x" → "ana-b". */
export function linkedInSlug(url) {
  return String(url).replace(LINKEDIN_PREFIX_RE, "").replace(/\?.*$/, "").replace(/\/+$/, "");
}

/** LinkedIn people-search URL for someone who never shared a profile link. */
export function linkedInSearchUrl(person) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(nameOf(person))}`;
}

/** "#3-ask-mentors" → "#ask-mentors" (the event's numeric ordering prefixes mean nothing to people). */
export function shortChannelName(channel) {
  return String(channel || "").replace(/^#\d+-/, "#");
}

/**
 * Role flags for a person.
 * @param {object} person  a /api/people row
 * @param {object} [teammate]  their /api/teammates row, if any
 */
export function roleOf(person, teammate) {
  if (!person) return { any: false, helper: false };
  const tags = new Set(person.roles || []);
  const judge = tags.has("judge");
  const mentor = !!person.is_mentor && (tags.has("mentor") || !judge);
  const isTeammate = !!teammate && teammate.shared_groups.length > 0;
  const seeking = !!teammate && !isTeammate && teammate.team_posts.length > 0;
  const likely = (!!person.likely_mentor || tags.has("mentor?")) && !person.is_mentor;
  const role = { mentor, judge, sponsor: !!person.is_sponsor, organizer: !!person.is_organizer, teammate: isTeammate, seeking, likely, org: person.org || "" };
  role.helper = mentor || judge || role.sponsor || role.organizer;
  role.any = role.helper || isTeammate || seeking || likely;
  return role;
}

/** Badge strip colour key ("mentor", "sponsor", "dual", …). */
export function roleStripOf(person, teammate) {
  const role = roleOf(person, teammate);
  if ((role.mentor || role.judge) && role.sponsor) return "dual";
  if (role.mentor || role.judge) return "mentor";
  if (role.sponsor) return "sponsor";
  if (role.organizer) return "organizer";
  if (role.teammate || role.seeking) return "teammate";
  if (role.likely) return "likely";
  return "none";
}

/** Role chips in priority order: Mentor > Judge > Sponsor > Organizer > Teammate > Possible mentor. */
export function roleChipsOf(person, teammate) {
  const role = roleOf(person, teammate);
  const chips = [];
  if (role.mentor) chips.push({ kind: "mentor", label: "Mentor" });
  if (role.judge) chips.push({ kind: "mentor", label: "Judge" });
  if (role.sponsor) chips.push({ kind: "sponsor", label: role.org || "Sponsor", aria: `Sponsor: ${role.org || "unknown company"}` });
  if (role.organizer) chips.push({ kind: "organizer", label: "Cal Hacks team" });
  if (role.teammate) chips.push({ kind: "teammate", label: "Teammate" });
  if (role.seeking) chips.push({ kind: "teammate", label: "Looking for team" });
  if (role.likely) chips.push({ kind: "likely", label: "Possible mentor", tip: "Answered questions in a mentor channel. Not confirmed." });
  return chips;
}

/**
 * "How you met": the first line that applies. With `includeRole: false` the role-derived lines are
 * skipped, for places where a role chip already says it (badges, the profile header).
 */
export function howYouMet(person, teammate, { includeRole = true } = {}) {
  if (person.dm_count > 0) return `DMed ${person.dm_count}×`;
  if (teammate?.shared_groups.length) return `In ${teammate.shared_groups[0]} with you`;
  const roleLine = includeRole ? roleMetLine(person, teammate) : "";
  if (roleLine) return roleLine;
  if (teammate?.team_posts.length) return `Posted in ${shortChannelName(teammate.team_posts[0].channel)}`;
  const busiest = person.channels?.[0];
  return busiest ? `Active in ${shortChannelName(busiest)}` : "";
}

/** Card subtitle: their own title (unless it only repeats a role word) and pronouns, else org. */
export function subtitleOf(person) {
  const title = person.title && !ROLE_WORD_TITLES.has(person.title.trim().toLowerCase()) ? person.title : "";
  return [title, person.pronouns].filter(Boolean).join(" · ") || person.org || "";
}

/** Palette / picker matcher: prefix > word start > substring, then mentors and people you DMed. */
export function matchPeople(query, people, limit = 6) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const wordStart = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const scored = [];
  for (const person of people) {
    const score = matchScore(person, needle, wordStart);
    if (score) scored.push([score + (person.is_mentor ? MENTOR_MATCH_BONUS : 0) + Math.min(person.dm_count, DM_MATCH_BONUS_CAP) / 100, person]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, person]) => person);
}

/** "spacexsi" → "SpaceX SI", "ai-dev" → "AI.dev": sponsor slugs as company names. */
export function companyNameFromSlug(slug) {
  return String(slug).split(/[-_\s]+/).filter(Boolean)
    .map((word) => (UPPERCASE_WORDS.has(word.toLowerCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ")
    .replace(/^Spacexsi$/i, "SpaceX SI").replace(/^A16z$/i, "a16z").replace(/ Dev$/, ".dev");
}

/** "#spons-coinbase" → "coinbase"; "" for non-sponsor channels. */
export function sponsorSlugOf(channel) {
  return String(channel || "").match(SPONSOR_CHANNEL_RE)?.[1] || "";
}

/** Which company "booth" a collection row belongs to. @returns {{key: string, label: string, channel: string}} */
export function companyOf(row) {
  if (row.channel_type === "im" || row.channel_type === "mpim") return { key: "dm", label: "Private messages", channel: "" };
  if (row.author_is_sponsor && row.author_org) return companyFromLabel(companyNameFromSlug(row.author_org), row.channel);
  const slug = sponsorSlugOf(row.channel);
  if (slug) return companyFromLabel(companyNameFromSlug(slug), row.channel);
  return { key: row.channel, label: row.channel, channel: "" };
}

// ---------- private helpers ----------

function roleMetLine(person, teammate) {
  const role = roleOf(person, teammate);
  if (role.judge) return "Judged at Cal Hacks";
  if (role.sponsor && role.org) return `${role.org} booth`;
  if (role.mentor) {
    const mentorChannel = person.channels?.find((channel) => /mentor/.test(channel));
    return mentorChannel ? `Mentor in ${shortChannelName(mentorChannel)}` : "Mentor at Cal Hacks";
  }
  if (role.organizer) return "Ran Cal Hacks 13.0";
  return "";
}

function matchScore(person, needle, wordStart) {
  const name = nameOf(person).toLowerCase();
  const haystack = `${name} ${person.handle || ""} ${person.title || ""} ${person.org || ""}`.toLowerCase();
  if (name.startsWith(needle)) return MATCH_SCORE.prefix;
  if (wordStart.test(haystack)) return MATCH_SCORE.wordStart;
  return haystack.includes(needle) ? MATCH_SCORE.substring : 0;
}

function companyFromLabel(label, channel) {
  return { key: label.toLowerCase(), label, channel };
}
