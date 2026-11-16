// Owns the read-only archive views: channels, a page of a channel, a thread,
// the networking collections with their counts, and one collection's posts.
// Thin on purpose: SQL lives in data/queries.js, labels in lib/collections.js.
import { NotFoundError } from "../lib/errors.js";
import {
  listChannels as listChannelRows, getChannel, channelPage, threadMessages, collectionCounts, collectionRows, getStats,
} from "../data/queries.js";
import { COLLECTIONS } from "../lib/collections.js";

const DEFAULT_CHANNEL_PAGE_SIZE = 200;
const COLLECTION_ROW_LIMIT = 500;

/** @returns {object[]} channels with messages, DMs last, most recent first */
export function listChannels(db) {
  return listChannelRows(db);
}

/**
 * @param {{ limit?: number, offset?: number }} page
 * @returns {{ channel: object, messages: object[] }}
 * @throws {NotFoundError} unknown channel
 */
export function getChannelPage(db, channelId, { limit = DEFAULT_CHANNEL_PAGE_SIZE, offset = 0 } = {}) {
  const channel = getChannel(db, channelId);
  if (!channel) throw new NotFoundError("channel");
  return { channel, messages: channelPage(db, channelId, { limit, offset }) };
}

/** @returns {object[]} the parent message and its replies, oldest first */
export function getThread(db, channelId, ts) {
  return threadMessages(db, channelId, ts);
}

/** @returns {boolean} whether `key` names a networking collection */
export function isKnownCollection(key) {
  return Object.hasOwn(COLLECTIONS, key);
}

/** @returns {{ key, label, messages, people }[]} every collection, including empty ones */
export function listCollectionsWithCounts(db) {
  const countsByKey = new Map(collectionCounts(db).map((row) => [row.key, row]));
  return Object.entries(COLLECTIONS).map(([key, collection]) => ({
    key,
    label: collection.label,
    messages: countsByKey.get(key)?.messages || 0,
    people: countsByKey.get(key)?.people || 0,
  }));
}

/**
 * @param {string} key  a known collection key
 * @param {{ text?: string }} [filter]  matches message text, author name or title
 * @returns {object[]} newest first, with author fields
 */
export function getCollectionMessages(db, key, { text } = {}) {
  return collectionRows(db, key, { text, limit: COLLECTION_ROW_LIMIT });
}

/** @returns {object} archive totals for the home page */
export function getArchiveStats(db) {
  return getStats(db);
}
