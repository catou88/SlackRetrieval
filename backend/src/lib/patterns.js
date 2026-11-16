// The one home for text patterns shared across the app: LinkedIn and URL
// extraction, self-introductions ("I'm a mentor…"), offer phrasing (index-time
// classifier vocabulary and the stricter first-person outreach net), offer
// types, hacker/project chatter, sponsor and logistics channel names, Slack
// name tags, question detection, and cross-post normalization.
// Pure functions and constants only.

/** Messages shorter than this are reactions ("thanks!", "connect?"), never signals. */
export const MIN_MESSAGE_CHARS = 12;

/** Cross-posts are compared on this many normalized characters. */
export const DEDUPE_PREFIX_CHARS = 200;

const LINKEDIN_URL_RE = /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9_\-%.]+\/?/gi;
const LINKEDIN_BARE_RE = /(?<![/\w])(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_\-%.]+\/?/gi;
const HAS_LINKEDIN_PROFILE_RE = /linkedin\.com\/(?:in|pub)\//i;
const URL_RE = /<?(https?:\/\/[^\s|>]+)/g;

/** "I'm a mentor", "joining as a judge", "we're the sponsors": group 1 is the role. */
export const SELF_INTRO_RE =
  /\b(?:(?:i['’]?m|i am|i['’]?ll be|we['’]?re)\s+(?:a|an|one of the|your|the)\s+(?:[\w-]+\s+){0,3}|(?:joining|here|attending)\s+(?:[\w.]+\s+){0,3}as\s+(?:a\s+|an\s+)?(?:[\w-]+\s+){0,2})(mentor|judge|sponsor|recruiter|organizer)s?\b/i;

/** Roles whose self-introduction counts as a mentor/judge intro. */
export const MENTOR_INTRO_ROLES = new Set(["mentor", "judge", "recruiter"]);

/** Index-time offer vocabulary (combined with similarity by the classifier). */
export const OFFER_PHRASE_RE =
  /\b(review(ing)? (your )?resumes?|resume review|send (me )?your resume|dm me|reach out|happy to (help|chat|connect|review|mentor)|coffee chat|refer(ral|rals)?|mock interviews?|office hours|mentorship)\b/i;

// Request-time outreach net: first-person offers only. Bare "mentor",
// "connect(ed)", "resume" and "referring" were ~85% false positives
// ("goated mentor", "connected to wifi", "when will it resume?").
const OUTREACH_OFFER_RE =
  /\b(happy|glad|feel free) to (help|chat|connect|review|refer|mentor)\b|\b(dm|ping|message) me\b|\breach out to me\b|\bmy (linkedin|calendly)\b|\bbook (a )?time\b|\boffice hours\b|\bresume (review|feedback|drop)s?\b|\breview (your |any )?resumes?\b|\bcoffee chats?\b|\breferrals?\b|\bwe['’]?re hiring\b|\bopen roles?\b|\bapply (here|now|at|today)\b/i;

/** A hacker talking about their own project or table: never an offer or announcement. */
export const HACKER_RE =
  /\b(table ?#?\d+[a-z]?|at \d{2,3}[a-z]?\b|our (project|team|hack|demo|submission|table)|we (built|made|are building|'re building)|check out our|my team(mate)?s?|come (check|see|visit)|i (built|developed|made))/i;

/** #spons-*, #sponsor-*, #cohost-*, #partner-* style channels. */
export const SPONSOR_CHANNEL_RE = /spons|sponsor|cohost|partner/i;

/** Sponsor channels named after the company: group 1 is the company slug. */
export const SPONSOR_ORG_CHANNEL_RE = /^#(?:spons|sponsor|cohost)-(.+)$/i;

// Event logistics: posts here are about the venue, travel or hardware desk.
const LOGISTICS_CHANNEL_RE = /^#(?:\d+-)?(?:ask-directors|travel|hardware|announcements)/i;

/** Slack name tags: "Alex [Judge]", "Jordan Lee (Acme Corp)". Global: use with matchAll. */
export const NAME_TAG_RE = /[[(]([^\])]{2,40})[\])]/g;

const INTERROGATIVE_START_RE = /^(any|anyone|is|are|does|do|did|can|could|where|when|how|what|who|why|has|have|will|would|should)\b/i;
const ASKS_SOMEONE_RE = /\b(can|could) (someone|anyone)\b/i;
const EXTRA_LABELS = ["links", "files"]; // the order ingest appends them, reversed

/**
 * What someone offered, most specific first. `id` is the API's `offer_type`.
 * Mentorship needs an offer verb ("happy to mentor"), not "mentoring experience".
 */
export const OFFER_TYPES = Object.freeze([
  { id: "referral", re: /\breferrals?\b|\b(happy|glad|can|could) to refer\b|\brefer (you|people|folks|candidates)\b/i },
  { id: "hiring", re: /\bwe['’]?re hiring\b|\bhiring\b|\bopen roles?\b|\bnew grads?\b|\bapply (here|now|at|today|through|via)\b|\bcareers? (page|site)\b|\bjob (postings?|openings?)\b|\binternships?\b/i },
  { id: "resume", re: /\bresume (review|feedback|drop)s?\b|\breview(ing)? (your |any )?resumes?\b|\bsend (me )?(your )?resumes?\b|\blook (over|at) (your )?resumes?\b|résumé|\bcv\b/i },
  { id: "interview", re: /\bmock interviews?\b|\binterview prep\b/i },
  { id: "mentorship", re: /\b(happy|glad|available|open) to mentor\b|\bmentorship (available|sessions?|hours)\b|\bmentoring (sessions?|hours)\b|\boffer(ing)? mentorship\b/i },
  { id: "coffee", re: /\bcoffee chats?\b|\bcalendly\b|\bgrab (some )?time\b|\bhop on a call\b|\bbook (a )?time\b/i },
  { id: "advice", re: /\bhappy to (help|chat)\b|\bfeel free to (reach out|dm|ping|message|ask)\b|\b(dm|ping|message) me\b|\breach out to me\b|\bask me (anything|about)\b|\boffice hours\b/i },
]);

/** Offer types that rank a highlight first: a concrete door (job, referral). */
// Broad keyword net for profile highlights, independent of the classifier so
// nothing useful is missed (low precision by design; shown as "mention").
// scripts/eval/common.js keeps a copy (the eval must not import app code): keep in sync.
export const OUTREACH_KEYWORD_RE =
  /linkedin\.com\/in\/|\bconnect(ing|ed)?\b|\bresumes?\b|\bdm me\b|reach out|coffee chats?|\breferr(al|als|ing)?\b|office hours|\bmentor(s|ing|ship)?\b|\bhiring\b|\bintern(s|ship|ships)?\b/i;

export const TOP_RANK_OFFER_TYPES = new Set(["referral", "hiring"]);

/** @returns {string[]} every http(s) URL in raw Slack text */
export function extractUrls(text = "") {
  return [...text.matchAll(URL_RE)].map((match) => match[1]);
}

/** @returns {string[]} distinct normalized LinkedIn profile URLs in the text */
export function extractLinkedIn(text = "") {
  const found = [
    ...(text.match(LINKEDIN_URL_RE) || []),
    ...(text.match(LINKEDIN_BARE_RE) || []).map((url) => "https://" + url),
  ].map(normalizeLinkedIn);
  return [...new Set(found)];
}

/** @returns {string} "https://www.linkedin.com/in/slug" (lowercase, no trailing punctuation) */
export function normalizeLinkedIn(url) {
  return url
    .replace(/^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?/i, "https://www.")
    .replace(/[).,;]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** @returns {boolean} whether the text links a LinkedIn profile */
export function hasLinkedInProfile(text = "") {
  return HAS_LINKEDIN_PROFILE_RE.test(text);
}

/** @returns {string | null} the role someone introduces themselves as ("recruiter" stays as is) */
export function selfIntroRole(text = "") {
  const match = SELF_INTRO_RE.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** @returns {boolean} a question or a request for help, not an offer */
export function isQuestion(text = "") {
  const trimmed = text.trim();
  if (/\?\s*$/.test(trimmed) || ASKS_SOMEONE_RE.test(trimmed)) return true;
  return INTERROGATIVE_START_RE.test(trimmed) && trimmed.includes("?");
}

/** @returns {boolean} a sponsor channel (#spons-*, #cohost-*, …) */
export function isSponsorChannel(channel = "") {
  return SPONSOR_CHANNEL_RE.test(channel);
}

/** @returns {boolean} an event-logistics channel (directors desk, travel, hardware, announcements) */
export function isLogisticsChannel(channel = "") {
  return LOGISTICS_CHANNEL_RE.test(channel);
}

/**
 * First-person offer phrasing for the outreach net ("happy to help", "DM me",
 * "we're hiring"); questions never qualify.
 * @returns {boolean}
 */
export function isFirstPersonOffer(text = "") {
  const { body } = splitExtras(text);
  return body.trim().length >= MIN_MESSAGE_CHARS && !isQuestion(body) && OUTREACH_OFFER_RE.test(body);
}

/** @returns {string[]} OFFER_TYPES ids the text matches, most specific first */
export function offerTypesOf(text = "") {
  const { body } = splitExtras(text);
  return OFFER_TYPES.filter((type) => type.re.test(body)).map((type) => type.id);
}

/**
 * Split our appended "[files: …]" / "[links: …]" lines from what the person typed.
 * @returns {{ body: string, extras: string }}
 */
export function splitExtras(text = "") {
  let body = text;
  const extras = [];
  // ingest appends files first, then links, so peel them off from the end.
  for (const label of EXTRA_LABELS) {
    const marker = `\n[${label}: `;
    const start = body.lastIndexOf(marker);
    const end = body.trimEnd().length - 1;
    if (start === -1 || body[end] !== "]") continue;
    extras.unshift(body.slice(start + marker.length, end));
    body = body.slice(0, start);
  }
  return { body, extras: extras.join(" | ") };
}

/**
 * Key for spotting cross-posts: lowercase, without URLs, emoji codes, Slack
 * formatting and punctuation, first DEDUPE_PREFIX_CHARS characters.
 * @returns {string} "" when nothing comparable is left
 */
export function dedupeKey(text = "") {
  const { body, extras } = splitExtras(text);
  const source = body.trim() ? body : extras; // a share-only post is its link preview
  return source
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, DEDUPE_PREFIX_CHARS);
}
