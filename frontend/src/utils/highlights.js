// Profile Outreach highlights: normalizes /api/person highlights into one shape, folds cross-posts
// together, sorts them and explains why each one was tagged. Pure (no DOM, no state).
//
// Accepts both server shapes: collections as plain keys (["offer", "mention"]) or as objects
// ({key, confidence: "high"|"medium"|"low", score, source}); also_in, offer_type, rank and the
// person-level highlight_kind are used when the server sends them and derived here otherwise.

/** Display categories, in priority order. Unknown collection keys are ignored. */
export const KINDS = {
  offer: { label: "Offer", chipClass: "tint-mentor", order: 0 },
  linkedin: { label: "LinkedIn", chipClass: "chip--li", order: 1 },
  mentor_intro: { label: "Intro", chipClass: "chip--intro", order: 2 },
  sponsor_opportunity: { label: "Opportunity", chipClass: "chip--quiet tint-sponsor", order: 3 },
  mention: { label: "Other post", chipClass: "chip--quiet", order: 4 },
};

/** What someone offered, in words that finish "Offered: …". */
export const OFFER_TYPE_LABELS = {
  resume: "resume reviews",
  referral: "referrals",
  interview: "interview prep",
  mentorship: "mentoring",
  coffee: "coffee chats",
  advice: "advice and questions",
  hiring: "open roles",
  office_hours: "office hours",
  connect: "connecting",
};

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };
const DEDUPE_KEY_LENGTH = 200;
// Subtypes that mean "a concrete thing you can ask for" outrank generic offers (critic P1-2).
const TOP_RANK_OFFER_TYPES = new Set(["hiring", "referral", "resume"]);
const DEFAULT_RANK = 9;
// Fallback subtype rules for servers that don't send offer_type. First match wins, and mentoring
// only counts after an offer verb ("happy to mentor"), not "my mentoring experience".
const FALLBACK_OFFER_RULES = [
  ["resume", /\bresumes?\b|résumé|\bcv\b/i],
  ["referral", /\brefer(r(al|als|ing))?\b/i],
  ["interview", /mock interviews?|interview prep/i],
  ["mentorship", /(happy|glad|love|available) to mentor|mentorship (available|offered)|office hours/i],
  ["coffee", /coffee|calendly|grab (some )?time|hop on a call/i],
  ["hiring", /\bwe'?re hiring\b|\bhiring\b|open roles?|apply (here|now|at)|careers?\b/i],
  ["advice", /happy to help|feel free to (reach out|dm|ask)|\b(dm|ping|message) me\b|reach out to me|ask me/i],
];

/**
 * Normalize, fold cross-posts and sort.
 * @param {object[]} rawHighlights  /api/person highlights in either shape
 * @param {{isHelper: boolean, isSponsor: boolean}} authorRole  used to grade old-shape rows
 * @returns {object[]} highlights with collections as objects, also_in, offer_type, confidence, rank
 */
export function prepareHighlights(rawHighlights, authorRole) {
  const normalized = (rawHighlights || []).map((highlight) => normalizeHighlight(highlight, authorRole));
  return foldCrossPosts(normalized.sort(compareHighlights)).sort(compareHighlights);
}

/** Collections of a highlight that have a display category. */
export function kindsOf(highlight) {
  return highlight.collections.filter((collection) => KINDS[collection.key]);
}

/** Does the highlight belong to category `key`? */
export function hasKind(highlight, key) {
  return highlight.collections.some((collection) => collection.key === key);
}

/** Low-confidence highlights go in the collapsed "Possibly relevant" group. */
export function isLowConfidence(highlight) {
  return highlight.confidence === "low";
}

/**
 * The person-level framing for the section heading.
 * @returns {"offered_help"|"shared_linkedin"|"posted_opportunities"|"none"}
 */
export function highlightKindOf(serverKind, highlights) {
  if (serverKind) return serverKind;
  const confident = highlights.filter((highlight) => !isLowConfidence(highlight));
  if (confident.some((highlight) => hasKind(highlight, "offer"))) return "offered_help";
  if (confident.some((highlight) => hasKind(highlight, "linkedin") || hasKind(highlight, "mentor_intro"))) return "shared_linkedin";
  if (confident.some((highlight) => hasKind(highlight, "sponsor_opportunity"))) return "posted_opportunities";
  return "none";
}

/** Distinct offer subtypes across highlights, best first. */
export function offerTypesIn(highlights) {
  const types = highlights.filter((highlight) => !isLowConfidence(highlight)).map((highlight) => highlight.offer_type).filter(Boolean);
  return [...new Set(types)];
}

/** "resume" → "resume reviews"; unknown keys read as words. */
export function offerTypeLabel(offerType) {
  return OFFER_TYPE_LABELS[offerType] || String(offerType || "").replace(/_/g, " ");
}

/** Plain-words reason a highlight was tagged, for the chip tooltip. */
export function whyTagged(collection) {
  const parts = [`${KINDS[collection.key]?.label || collection.key}: ${collection.confidence} confidence`];
  if (typeof collection.score === "number" && collection.score >= 0 && collection.score <= 1) parts[0] += ` (${Math.round(collection.score * 100)}%)`;
  const reason = sourceInWords(collection.source);
  if (reason) parts.push(reason);
  return parts.join(". ") + ".";
}

// ---------- private helpers ----------

function normalizeHighlight(highlight, authorRole) {
  const collections = (highlight.collections || []).map((collection) => normalizeCollection(collection, authorRole));
  const offerType = highlight.offer_type !== undefined ? highlight.offer_type : fallbackOfferType(highlight, collections);
  const normalized = { ...highlight, collections, offer_type: offerType || null, also_in: [...(highlight.also_in || [])] };
  normalized.confidence = bestConfidence(kindsOf(normalized));
  normalized.rank = typeof highlight.rank === "number" ? highlight.rank : fallbackRank(normalized);
  return normalized;
}

function normalizeCollection(collection, authorRole) {
  if (typeof collection !== "string") return { confidence: "high", score: null, source: "", ...collection };
  return { key: collection, confidence: legacyConfidence(collection, authorRole), score: null, source: legacySource(collection) };
}

// Old servers had no confidence: keyword "mention" hits and sponsor-channel chatter from people
// who are not sponsors were mostly noise (critic P1-1, P1-2), so they start low.
function legacyConfidence(key, authorRole) {
  if (key === "mention") return "low";
  if (key === "sponsor_opportunity" && !authorRole.isSponsor) return "low";
  if (key === "linkedin" && !authorRole.isHelper) return "medium";
  return "high";
}

const legacySource = (key) => (key === "mention" ? "keyword" : "categorize");

function fallbackOfferType(highlight, collections) {
  const isOfferLike = collections.some((collection) => collection.key === "offer" || collection.key === "mention");
  if (!isOfferLike) return null;
  return FALLBACK_OFFER_RULES.find(([, pattern]) => pattern.test(highlight.text || ""))?.[0] || null;
}

function fallbackRank(highlight) {
  if (hasKind(highlight, "offer") && TOP_RANK_OFFER_TYPES.has(highlight.offer_type)) return 0;
  const orders = kindsOf(highlight).map((collection) => KINDS[collection.key].order + 1);
  return orders.length ? Math.min(...orders) : DEFAULT_RANK;
}

function bestConfidence(collections) {
  if (!collections.length) return "low";
  return collections.map((collection) => collection.confidence).sort((a, b) => (CONFIDENCE_ORDER[a] ?? 3) - (CONFIDENCE_ORDER[b] ?? 3))[0];
}

function compareHighlights(a, b) {
  return (CONFIDENCE_ORDER[a.confidence] ?? 3) - (CONFIDENCE_ORDER[b.confidence] ?? 3) || a.rank - b.rank || +b.ts - +a.ts;
}

// The same post in #general, #spons-x and #opportunities shows once, with "also in" chips.
function foldCrossPosts(sorted) {
  const byKey = new Map();
  const kept = [];
  for (const highlight of sorted) {
    const key = dedupeKey(highlight.text);
    const original = key && byKey.get(key);
    if (!original) {
      if (key) byKey.set(key, highlight);
      kept.push(highlight);
      continue;
    }
    mergeInto(original, highlight);
  }
  return kept;
}

function mergeInto(original, duplicate) {
  const channels = [duplicate.channel, ...duplicate.also_in].filter((channel) => channel && channel !== original.channel);
  original.also_in = [...new Set([...original.also_in, ...channels])];
  for (const collection of duplicate.collections) {
    if (!hasKind(original, collection.key)) original.collections.push(collection);
  }
}

function dedupeKey(text) {
  return String(text || "")
    .replace(/\[(links|files): [\s\S]*$/, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/[*_~`>]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, DEDUPE_KEY_LENGTH);
}

function sourceInWords(source) {
  const text = String(source || "").toLowerCase();
  if (!text) return "";
  if (/manual|human|review|hand/.test(text)) return "You or a reviewer labeled this post";
  if (/claude|llm|anthropic/.test(text)) return "Claude read the post and labeled it";
  if (/embed|vector|semantic|knn|similar|centroid/.test(text)) return "It reads like other posts in this category";
  if (/keyword|regex|rule|pattern/.test(text)) return "It uses wording like “happy to help” or “DM me”";
  if (/categor/.test(text)) return "Found by the local categorizer";
  return `Source: ${source}`;
}
