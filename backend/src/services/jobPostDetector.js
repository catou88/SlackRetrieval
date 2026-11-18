// Rule-based detector for job/internship postings in chat messages (Slack or
// Discord). Rules run first because they are free, deterministic and testable;
// an optional Qwen classifier handles only the ambiguous middle. Pure functions.
import { extractUrls } from "../lib/patterns.js";

const MIN_TEXT_CHARS = 25;
const MAX_FIELD_CHARS = 120;
const CONFIDENT_SCORE = 3;

const HIRING_RE = /\b(we['’]?re hiring|we are hiring|now hiring|is hiring|are hiring|hiring (?:a|an|for|interns?|engineers?)|open (?:roles?|positions?)|job opening|internship (?:opening|opportunity|posting)|new[- ]grad (?:role|position|opening)|(?:summer|fall|winter|spring) 202\d (?:swe |ml |ai )?intern(?:ship)?s?|apply (?:here|now|at|today|by)|join (?:our|the) team|(?:openings?|roles?) (?:on|at) (?:our )?careers?)\b/i;
const ROLE_RE = /\b(engineer|developer|intern(?:ship)?|scientist|researcher|designer|swe|sde|analyst|manager|architect|new[- ]grad|co-?op|fellow(?:ship)?)\b/i;
const JOB_HOST_RE = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|workdayjobs\.com|smartrecruiters\.com|linkedin\.com\/jobs|wellfound\.com|ycombinator\.com\/companies\/[^/\s]+\/jobs|\/careers?\b|\/jobs?\b)/i;
// A person seeking work is the opposite of a posting.
const SEEKER_RE = /\b(i['’]?m|i am|i['’]?ve been)\s+(?:currently\s+)?(?:looking for|seeking|searching for|open to)|\bopen to work\b|\bmy resume\b|\bmy portfolio\b|\bany (?:leads|referrals?) (?:on|for)\b|\bhow (?:do|can) i (?:get|land|find)\b/i;
const LOCATION_RE = /\b(San Francisco|SF|Bay Area|New York(?: City)?|NYC|Seattle|Austin|Boston|Los Angeles|Palo Alto|Mountain View|San Jose|Remote|Hybrid|London|Toronto)\b(?:,\s*(?:CA|NY|WA|TX|MA))?/i;
const LABELLED_LOCATION_RE = /\blocation\s*[:\-]\s*([^\n|,]{2,60})/i;
const COMPANY_PATTERNS = [
  /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\s+(?:is|are|'s|’s)\s+hiring\b/,
  /\bhiring\b.{0,60}?\b(?:at|@)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})/,
  /\b(?:at|@)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\s*(?:[,.!—–|(]|\s+(?:in|is|are|for)\b|$)/m,
  /\bjoin\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,2})\b/,
];
const TITLE_RE = /\b((?:(?:Senior|Staff|Junior|Founding|Summer|Fall|Machine Learning|ML|AI|Software|Backend|Frontend|Full[- ]?Stack|Research|Product|Data|Applied)\s+){0,3}(?:Engineer|Developer|Intern(?:ship)?|Scientist|Researcher|Designer|Analyst|Manager|Architect)(?:\s+Intern)?)\b/;
const STOP_COMPANIES = new Set(["We", "I", "The", "Our", "This", "Apply", "Join", "DM", "Hi", "Hey", "Remote"]);

/**
 * Classify one chat message.
 * @param {{ text: string, channel?: string }} message  Slack mrkdwn or Discord markdown text
 * @returns {{ isJob: boolean, confidence: "high"|"medium"|"low", score: number, reasons: string[], title: string|null,
 *   company: string|null, location: string|null, link: string|null }}
 */
export function detectJobPost({ text = "", channel = "" } = {}) {
  const plain = stripChatMarkup(text);
  const negative = { isJob: false, confidence: "high", score: 0, reasons: [], title: null, company: null, location: null, link: null };
  if (plain.length < MIN_TEXT_CHARS) return negative;
  if (SEEKER_RE.test(plain)) return { ...negative, reasons: ["job seeker, not a posting"] };

  const links = extractUrls(text);
  const jobLink = links.find((u) => JOB_HOST_RE.test(u)) ?? null;
  const { score, reasons } = scoreSignals(plain, channel, Boolean(jobLink));
  const isJob = score >= 2;
  if (!isJob) return { ...negative, score, reasons, confidence: score === 1 ? "medium" : "high" };
  return {
    isJob, score, reasons, confidence: score >= CONFIDENT_SCORE ? "high" : "medium",
    title: findTitle(plain), company: findCompany(plain), location: findLocation(plain), link: jobLink ?? links[0] ?? null,
  };
}

/** Slack `<url|label>`, `<@U1>`, `*bold*` and Discord `**bold**` reduced to plain text. */
export function stripChatMarkup(text = "") {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "$2 $1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<[@#!][^>]*>/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- private helpers
function scoreSignals(plain, channel, hasJobLink) {
  const reasons = [];
  let score = 0;
  if (HIRING_RE.test(plain)) { score += 2; reasons.push("hiring phrase"); }
  if (ROLE_RE.test(plain)) { score += 1; reasons.push("role keyword"); }
  if (hasJobLink) { score += 1; reasons.push("job-board or careers link"); }
  if (/job|career|hiring|intern|opportunit|recruit/i.test(channel)) { score += 1; reasons.push("job-like channel"); }
  // A role word alone is chatter ("the engineer said…"): require a hiring phrase or a job link.
  if (!HIRING_RE.test(plain) && !hasJobLink) return { score: Math.min(score, 1), reasons };
  return { score, reasons };
}

function findTitle(plain) {
  return clip(plain.match(TITLE_RE)?.[1] ?? null);
}

function findCompany(plain) {
  for (const pattern of COMPANY_PATTERNS) {
    const name = plain.match(pattern)?.[1]?.trim();
    if (name && !STOP_COMPANIES.has(name.split(" ")[0])) return clip(name);
  }
  return null;
}

function findLocation(plain) {
  const labelled = plain.match(LABELLED_LOCATION_RE)?.[1];
  return clip(labelled?.trim() ?? plain.match(LOCATION_RE)?.[0] ?? null);
}

function clip(value) {
  return value ? value.slice(0, MAX_FIELD_CHARS) : null;
}
