// Owns the networking classifier: which messages belong to which collection,
// with a confidence ('high'|'medium'|'low'), a similarity score and the source
// of the decision.
//   linkedin            – someone sharing their LinkedIn to connect
//   mentor_intro        – a mentor, judge or recruiter introducing themselves
//   offer               – someone offering help: advice, mentorship, resume
//                         reviews, referrals, coffee chats, "DM me"
//   sponsor_opportunity – sponsor reps/organizers posting jobs, events, credits
//   teammate            – people looking for teams / to hack together
// Exact signals use rules; fuzzier ones use similarity to example sentences
// (all local). classify() is pure; categorize() reads the snapshot and writes
// data/categories.json (keys) + data/category-details.json (confidence).
import { CONFIG } from "../config.js";
import { embed } from "../clients/embedder.js";
import { readJSON, writeJSON, FILES } from "../data/jsonStore.js";
import { loadIndex, maxSimilarity } from "../data/vectorIndex.js";
import { COLLECTIONS } from "../lib/collections.js";
import {
  MIN_MESSAGE_CHARS, MENTOR_INTRO_ROLES, OFFER_PHRASE_RE, HACKER_RE,
  hasLinkedInProfile, selfIntroRole, isQuestion, isSponsorChannel,
} from "../lib/patterns.js";

// Collection metadata lives in lib/ so the data layer can use it too; callers
// keep importing it from here.
export { COLLECTIONS };

export const CONFIDENCE_LEVELS = ["high", "medium", "low"];

// Thresholds. Similarity margins are relative to the base threshold
// (CATEGORY_THRESHOLD, default 0.45); confidence uses the same scale as
// scripts/eval: |score - threshold| >= 0.10 high, >= 0.04 medium, else low.
const MIN_SENTENCE_CHARS = 80; // semantic matches need a real sentence, not "got it resolved"
const MIN_ANNOUNCEMENT_CHARS = 60; // a sponsor announcement / team post, not a one-liner
const OFFER_PHRASE_SLACK = 0.1; // an explicit offer phrase may be this far below the threshold
const OFFER_SEMANTIC_MARGIN = 0.05; // a helper's offer with no phrase needs this much above
const NON_HELPER_OFFER_MARGIN = 0.12; // a hacker "offer" must be very offer-like
const OPPORTUNITY_MARGIN = 0.05; // sponsor-channel post with no rep rule
const NOISY_CHANNEL_TEAM_MARGIN = 0.08; // team posts in #ask/#general need more evidence
const HIGH_CONFIDENCE_MARGIN = 0.1;
const MEDIUM_CONFIDENCE_MARGIN = 0.04;
const MIN_SPONSOR_REP_POSTS = 2; // announcements before someone counts as a sponsor rep
const HACKER_REP_SCORE = -99; // one project pitch disqualifies a would-be rep

const TEAM_FORMATION_CHANNEL_RE = /team|intro|first-time/i;
const TEAM_CHANNEL_RE = /team|intro|looking/i;
const NOISY_CHANNEL_RE = /ask|announce|general|director|spons|cohost/i;
const LOOKING_FOR_TEAM_RE = /looking for|team ?mates?|join (a|your) team|team up/i;

// One rule per collection, applied in order. Each returns a decision
// { confidence, score, source } or null. See classify() for `ctx`.
const RULES = [
  { key: "linkedin", decide: decideLinkedIn },
  { key: "mentor_intro", decide: decideMentorIntro },
  { key: "offer", decide: decideOffer },
  { key: "sponsor_opportunity", decide: decideSponsorOpportunity },
  { key: "teammate", decide: decideTeammate },
];

/**
 * Classify one message. Pure: everything it needs is in `ctx`.
 * @param {{ text: string, channel: string, thread_ts?: string, raw?: object }} message
 * @param {{ author?: object, isSponsorRep: boolean, threshold: number,
 *   scores: { mentor_intro?: number|null, offer?: number|null, sponsor_opportunity?: number|null, teammate?: number|null } }} ctx
 *   scores: similarity to each collection's examples, null when the message has no vector
 * @returns {{ key: string, confidence: "high"|"medium"|"low", score: number|null, source: string }[]}
 */
export function classify(message, ctx) {
  const text = message.text ?? "";
  if (text.trim().length < MIN_MESSAGE_CHARS || message.raw?.subtype) return []; // joins, renames, bot notices
  const facts = messageFacts(message, text, ctx);
  const decisions = [];
  for (const rule of RULES) {
    const decision = rule.decide(facts, ctx);
    if (decision) decisions.push({ key: rule.key, ...decision });
  }
  return decisions;
}

/**
 * Who speaks for a sponsor: posts announcements in sponsor channels and never
 * pitches their own hack ("our project at table 74"), or has the sponsor role.
 * @returns {Set<string>} user ids
 */
export function findSponsorReps(messages, people) {
  const announcements = {};
  for (const message of messages) {
    if (!isSponsorChannel(message.channel) || message.raw?.subtype) continue;
    const text = message.text ?? "";
    if (HACKER_RE.test(text)) announcements[message.user_id] = HACKER_REP_SCORE;
    else if (!message.thread_ts && text.length > MIN_ANNOUNCEMENT_CHARS && !isQuestion(text))
      announcements[message.user_id] = (announcements[message.user_id] || 0) + 1;
  }
  const reps = new Set(Object.keys(announcements).filter((id) => announcements[id] >= MIN_SPONSOR_REP_POSTS));
  for (const person of Object.values(people)) if (person.roles?.includes("sponsor")) reps.add(person.id);
  return reps;
}

/**
 * Classify every message.
 * @param {{ messages: object[], people: object, index?: object, prototypes: Record<string, Float32Array[]>, threshold?: number }} args
 * @returns {{ categories: Record<string, string[]>, details: Record<string, Record<string, object>> }}
 */
export function classifyAll({ messages, people, index, prototypes, threshold = CONFIG.categoryThreshold }) {
  const reps = findSponsorReps(messages, people);
  const rowOf = new Map((index?.ids || []).map((id, row) => [id, row]));
  const categories = {};
  const details = {};
  for (const message of messages) {
    const row = rowOf.get(message.id);
    const scores = row === undefined ? {} : similarityScores(index, row, prototypes);
    const decisions = classify(message, { author: people[message.user_id], isSponsorRep: reps.has(message.user_id), threshold, scores });
    if (!decisions.length) continue;
    categories[message.id] = decisions.map((decision) => decision.key);
    details[message.id] = Object.fromEntries(decisions.map(({ key, ...decision }) => [key, decision]));
  }
  return { categories, details };
}

/**
 * Re-classify the whole snapshot and write categories.json + category-details.json.
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<ReturnType<typeof classifyAll>>}
 */
export async function categorize({ log = console.log } = {}) {
  const messages = readJSON(FILES.messages, []);
  const people = readJSON(FILES.people, {});
  const prototypes = await embedPrototypes();
  const result = classifyAll({ messages, people, index: loadIndex(), prototypes });
  writeJSON(FILES.categoryDetails, result.details); // details first: a reader of keys never lacks them
  writeJSON(FILES.categories, result.categories);
  log(`Kept ${Object.keys(result.categories).length} of ${messages.length} messages — ${describeCounts(countByConfidence(result.details))}`);
  return result;
}

/** @returns {Record<string, { high: number, medium: number, low: number, total: number }>} */
export function countByConfidence(details) {
  const counts = Object.fromEntries(Object.keys(COLLECTIONS).map((key) => [key, { high: 0, medium: 0, low: 0, total: 0 }]));
  for (const byKey of Object.values(details)) {
    for (const [key, { confidence }] of Object.entries(byKey)) {
      counts[key][confidence]++;
      counts[key].total++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------- rules
function decideLinkedIn(facts) {
  return hasLinkedInProfile(facts.text) ? { confidence: "high", score: null, source: "rule:linkedin_url" } : null;
}

function decideMentorIntro(facts, ctx) {
  const score = ctx.scores.mentor_intro ?? null;
  if (facts.isSelfMentorIntro) return { confidence: "high", score, source: "rule:self_intro" };
  const isCandidate = facts.isAuthorMentor && facts.isLong && !facts.isReply && score !== null;
  return isCandidate && score >= ctx.threshold ? similarityDecision(score, ctx.threshold) : null;
}

// Offers need a concrete phrase or a strong semantic match and are never
// questions ("can anyone review my resume?") or project chatter. A hacker
// saying "DM me" while looking for a team is a teammate post, not an offer.
function decideOffer(facts, ctx) {
  if (facts.isQuestion || facts.isHackerChatter) return null;
  const score = ctx.scores.offer ?? 0;
  const threshold = ctx.threshold;
  if (facts.isAuthorHelper) {
    if (facts.hasOfferPhrase && score >= threshold - OFFER_PHRASE_SLACK)
      return { confidence: score >= threshold ? "high" : "medium", score, source: "rule:offer_phrase" };
    if (facts.isLong && score >= threshold + OFFER_SEMANTIC_MARGIN) return similarityDecision(score, threshold);
    return null;
  }
  const isHackerOffer = !facts.isTeamFormationChannel && facts.hasOfferPhrase && score >= threshold + NON_HELPER_OFFER_MARGIN;
  return isHackerOffer ? { confidence: "medium", score, source: "rule:offer_phrase" } : null;
}

// Only sponsor reps and organizers post opportunities; hackers in #spons-*
// channels are asking for support. A rep's post that does not look like an
// opportunity (tech support, "judges are remote") is kept at low confidence.
function decideSponsorOpportunity(facts, ctx) {
  if (facts.isQuestion || facts.isHackerChatter || !(ctx.isSponsorRep || facts.isAuthorOrganizer)) return null;
  const score = ctx.scores.sponsor_opportunity ?? 0;
  const threshold = ctx.threshold;
  if (ctx.isSponsorRep && facts.isSponsorChannel && facts.isAnnouncement)
    return { confidence: repPostConfidence(score, threshold), score, source: "rule:sponsor_rep" };
  const isStrongInSponsorChannel = facts.isSponsorChannel && score >= threshold + OPPORTUNITY_MARGIN;
  const isRepElsewhere = ctx.isSponsorRep && score >= threshold;
  return facts.isLong && (isStrongInSponsorChannel || isRepElsewhere) ? similarityDecision(score, threshold) : null;
}

function decideTeammate(facts, ctx) {
  if (facts.isAuthorMentor || ctx.isSponsorRep || !facts.isAnnouncement) return null;
  const score = ctx.scores.teammate ?? 0;
  const threshold = ctx.threshold;
  if (facts.isNoisyChannel && score < threshold + NOISY_CHANNEL_TEAM_MARGIN) return null;
  if (score >= threshold) return similarityDecision(score, threshold);
  const isTeamPost = facts.isTeamChannel && LOOKING_FOR_TEAM_RE.test(facts.text);
  return isTeamPost ? { confidence: "medium", score, source: "rule:team_post" } : null;
}

// ---------------------------------------------------------------- private helpers
function messageFacts(message, text, ctx) {
  const author = ctx.author;
  const role = selfIntroRole(text);
  return {
    text,
    isLong: text.length > MIN_SENTENCE_CHARS,
    isAnnouncement: text.length > MIN_ANNOUNCEMENT_CHARS,
    isReply: !!message.thread_ts,
    isQuestion: isQuestion(text),
    isHackerChatter: HACKER_RE.test(text),
    hasOfferPhrase: OFFER_PHRASE_RE.test(text),
    isSelfMentorIntro: !!role && MENTOR_INTRO_ROLES.has(role),
    isAuthorMentor: !!author?.is_mentor,
    isAuthorOrganizer: !!author?.is_organizer,
    isAuthorHelper: !!(author?.is_mentor || author?.is_sponsor || author?.is_organizer),
    isSponsorChannel: isSponsorChannel(message.channel),
    isTeamFormationChannel: TEAM_FORMATION_CHANNEL_RE.test(message.channel),
    isTeamChannel: TEAM_CHANNEL_RE.test(message.channel),
    isNoisyChannel: NOISY_CHANNEL_RE.test(message.channel),
  };
}

function similarityDecision(score, threshold) {
  return { confidence: confidenceFromMargin(score - threshold), score, source: "similarity" };
}

function confidenceFromMargin(margin) {
  const distance = Math.abs(margin);
  if (distance >= HIGH_CONFIDENCE_MARGIN) return "high";
  if (distance >= MEDIUM_CONFIDENCE_MARGIN) return "medium";
  return "low";
}

function repPostConfidence(score, threshold) {
  if (score < threshold) return "low";
  return score >= threshold + HIGH_CONFIDENCE_MARGIN ? "high" : "medium";
}

function similarityScores(index, row, prototypes) {
  const scores = {};
  for (const [key, vectors] of Object.entries(prototypes)) scores[key] = maxSimilarity(index, row, vectors);
  return scores;
}

async function embedPrototypes() {
  const prototypes = {};
  for (const [key, collection] of Object.entries(COLLECTIONS))
    if (collection.examples.length) prototypes[key] = await embed(collection.examples);
  return prototypes;
}

function describeCounts(counts) {
  return Object.entries(counts)
    .map(([key, c]) => `${COLLECTIONS[key].label}: ${c.total} (high ${c.high} · medium ${c.medium} · low ${c.low})`)
    .join(" · ");
}
