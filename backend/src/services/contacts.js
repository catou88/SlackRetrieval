// Owns the contact views the website shows: the People list (with how many
// distinct posts each person offered help in), one person's profile (DMs,
// recent messages, outreach highlights, note, saved briefs), the teammates
// list, and saving notes. Reads through data/queries.js only.
import { checkText, InvalidInputError, NotFoundError } from "../lib/errors.js";
import { dedupeKey, offerTypesOf, MIN_MESSAGE_CHARS, OUTREACH_KEYWORD_RE } from "../lib/patterns.js";
import { COLLECTION_KEYS, OUTREACH_COLLECTION_KEYS } from "../lib/collections.js";
import {
  listPeople, getPerson, peopleByIds, myId, networkingPostRows, dmsWith, channelMessagesBy, publicMessagesBy,
  withFiles, sharedGroupRows, teamPostRows, dmPartnerIds, noteFor, upsertNote, briefsFor,
} from "../data/queries.js";

export const MAX_PERSON_ID_CHARS = 200;
const MAX_NOTE_CHARS = 20_000;
const PROFILE_RECENT_MESSAGES = 300;

// Highlights: posts in an outreach collection, plus keyword-net hits tagged "mention".
const MENTION_COLLECTION = { key: "mention", confidence: "low", score: null, source: "keyword" };
const THREAD_BROADCAST_SUBTYPE = "thread_broadcast";

/**
 * People (never yourself) with their note, offer_count and offer_types.
 * @param {import("better-sqlite3").Database} db
 * @param {{ isMentorsOnly?: boolean, isLinkedInOnly?: boolean, query?: string }} filters
 * @returns {object[]}
 */
export function listContacts(db, filters) {
  const offersByPerson = summarizeOffersByPerson(networkingPostRows(db));
  return listPeople(db, filters).map((person) => {
    const offers = offersByPerson.get(person.id);
    return { ...person, offer_count: offerCountFor(person, offers), offer_types: offers ? [...offers.types] : [] };
  });
}

/**
 * Everything the person page shows.
 * @returns {{ person, dms, messages, highlights, note, briefs }}
 * @throws {NotFoundError} unknown id
 */
export function getPersonProfile(db, personId) {
  const person = getPerson(db, personId);
  if (!person) throw new NotFoundError("person");
  return {
    person,
    dms: dmsWith(db, personId),
    messages: channelMessagesBy(db, personId, { limit: PROFILE_RECENT_MESSAGES }),
    highlights: outreachHighlights(db, personId),
    note: noteFor(db, personId),
    briefs: briefsFor(db, personId),
  };
}

/**
 * People to hack with again: shared group DMs / private channels, DM
 * partners and team-formation posters (never mentors, sponsors, organizers).
 * @returns {object[]} people with shared_groups and team_posts, best match first
 */
export function listTeammates(db) {
  const sharedGroupsByPerson = groupBy(sharedGroupRows(db, myId(db)), (row) => row.user_id, (row) => row.channel);
  const teamPostsByPerson = groupBy(teamPostRows(db), (row) => row.user_id, ({ text, channel, date }) => ({ text, channel, date }));
  const candidateIds = new Set([...sharedGroupsByPerson.keys(), ...teamPostsByPerson.keys(), ...dmPartnerIds(db)]);
  return peopleByIds(db, [...candidateIds])
    .filter((person) => !person.is_me && !person.is_mentor && !person.is_sponsor && !person.is_organizer)
    .map((person) => ({
      ...person,
      shared_groups: sharedGroupsByPerson.get(person.id) || [],
      team_posts: teamPostsByPerson.get(person.id) || [],
    }))
    .sort(compareTeammates);
}

/**
 * Save (or clear) your private note about a person.
 * @throws {InvalidInputError} bad person_id or body
 */
export function saveNote(db, { person_id: personId, body }) {
  checkText(personId, "person_id", { isRequired: true, maxChars: MAX_PERSON_ID_CHARS });
  if (body !== undefined && body !== null && typeof body !== "string") throw new InvalidInputError("body must be a string");
  if (body && body.length > MAX_NOTE_CHARS) throw new InvalidInputError(`body is too long (max ${MAX_NOTE_CHARS})`);
  upsertNote(db, personId, body || "", new Date().toISOString());
}

// ---------------------------------------------------------------- private helpers
// Per person: distinct posts (cross-posts folded by dedupeKey) by collection, and offer types.
function summarizeOffersByPerson(rows) {
  const summaries = new Map();
  for (const row of rows) {
    if (!summaries.has(row.user_id)) summaries.set(row.user_id, { offerPosts: new Set(), linkedinPosts: new Set(), types: new Set() });
    const summary = summaries.get(row.user_id);
    const postKey = dedupeKey(row.text) || row.id;
    if (row.collection === COLLECTION_KEYS.offer) {
      summary.offerPosts.add(postKey);
      for (const type of offerTypesOf(row.text)) summary.types.add(type);
    }
    if (row.collection === COLLECTION_KEYS.linkedin) summary.linkedinPosts.add(postKey);
  }
  return summaries;
}

// A LinkedIn share only counts as an offer from mentors, judges, sponsors and organizers.
function offerCountFor(person, offers) {
  if (!offers) return 0;
  const isHelper = person.is_mentor || person.is_sponsor || person.is_organizer;
  const hasOffered = offers.offerPosts.size > 0 || (offers.linkedinPosts.size > 0 && isHelper);
  return hasOffered ? new Set([...offers.offerPosts, ...offers.linkedinPosts]).size : 0;
}

function outreachHighlights(db, personId) {
  const highlights = publicMessagesBy(db, personId).map(asHighlight).filter(Boolean);
  return withFiles(db, highlights);
}

// Returns the message shaped as a highlight, or null when it is not one.
function asHighlight({ subtype, ...message }) {
  const inThread = !!message.thread_ts && message.thread_ts !== message.ts;
  const hasOutreachCollection = message.collections.some((collection) => OUTREACH_COLLECTION_KEYS.has(collection.key));
  if (hasOutreachCollection) return { ...message, in_thread: inThread };
  if (!isKeywordMention(message.text, subtype)) return null;
  return { ...message, collections: [...message.collections, MENTION_COLLECTION], in_thread: inThread };
}

// Slack system rows (topic changes, tombstones) are not something they said.
function isKeywordMention(text, subtype) {
  if (subtype && subtype !== THREAD_BROADCAST_SUBTYPE) return false;
  return text.trim().length >= MIN_MESSAGE_CHARS && OUTREACH_KEYWORD_RE.test(text);
}

function groupBy(rows, keyOf, valueOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(valueOf(row));
  }
  return groups;
}

function compareTeammates(a, b) {
  return b.shared_groups.length - a.shared_groups.length || b.dm_count - a.dm_count || a.name.localeCompare(b.name);
}
