// Owns every SQL statement the app runs against data/slack.db (except the
// schema and rebuild in data/db.js). A flat list of functions over a db
// handle; rows come back parsed (JSON columns decoded, 0/1 as booleans).
// Every value is bound with `?`/@name; interpolated SQL is constant text.
import { COLLECTION_KEYS } from "../lib/collections.js";

const MESSAGE_COLUMNS = ["id", "channel_id", "channel", "channel_type", "ts", "date", "user_id", "user_name",
  "text", "thread_ts", "reply_count", "reactions"];
const MESSAGE_SELECT_LIST = aliasedMessageColumns("messages");
const ALIASED_MESSAGE_SELECT_LIST = aliasedMessageColumns("m");
// Per-message collections with confidence, as a JSON array (decoded by parseCollections).
const collectionsSubquery = (alias) => `(SELECT json_group_array(json_object('key', x.collection, 'confidence', x.confidence,
  'score', x.score, 'source', x.source)) FROM message_collections x WHERE x.message_id = ${alias}.id) AS collections`;
const LIKE_ESCAPE = "\\";

const OFFER_COLLECTION = COLLECTION_KEYS.offer;
const LINKEDIN_COLLECTION = COLLECTION_KEYS.linkedin;
const TEAMMATE_COLLECTION = COLLECTION_KEYS.teammate;

const statements = new WeakMap(); // db -> Map(sql -> Statement)

// ---------------------------------------------------------------- people
/** @returns {object | null} a people row with JSON columns decoded and flags as booleans */
export function parsePerson(row) {
  if (!row) return null;
  return {
    ...row,
    linkedin: JSON.parse(row.linkedin || "[]"),
    other_links: JSON.parse(row.other_links || "[]"),
    roles: JSON.parse(row.roles || "[]"),
    role_evidence: JSON.parse(row.role_evidence || "[]"),
    channels: JSON.parse(row.channels || "[]"),
    profile_fields: JSON.parse(row.profile_fields || "[]"),
    is_mentor: !!row.is_mentor,
    likely_mentor: !!row.likely_mentor,
    is_sponsor: !!row.is_sponsor,
    is_organizer: !!row.is_organizer,
    is_me: !!row.is_me,
    has_avatar: !!row.has_avatar,
  };
}

/**
 * People (never yourself) with their note, most-DMed first.
 * @param {{ isMentorsOnly?: boolean, isLinkedInOnly?: boolean, query?: string }} filters
 * @returns {object[]}
 */
export function listPeople(db, { isMentorsOnly = false, isLinkedInOnly = false, query } = {}) {
  const where = ["p.is_me = 0"];
  if (isMentorsOnly) where.push("p.is_mentor = 1");
  if (isLinkedInOnly) where.push("p.linkedin != '[]'");
  if (query) where.push(`(p.name LIKE @like ESCAPE '${LIKE_ESCAPE}' OR p.title LIKE @like ESCAPE '${LIKE_ESCAPE}' OR p.handle LIKE @like ESCAPE '${LIKE_ESCAPE}')`);
  const sql = `SELECT p.*, n.body AS note FROM people p LEFT JOIN notes n ON n.person_id = p.id
               WHERE ${where.join(" AND ")} ORDER BY p.dm_count DESC, p.message_count DESC, p.id`;
  return prepared(db, sql).all({ like: query ? likePattern(query) : null }).map(parsePerson);
}

/** @returns {object | null} one person, parsed */
export function getPerson(db, id) {
  return parsePerson(prepared(db, `SELECT * FROM people WHERE id = ?`).get(id));
}

/** @returns {object[]} people by id (unknown ids skipped), parsed */
export function peopleByIds(db, ids) {
  const select = prepared(db, `SELECT * FROM people WHERE id = ?`);
  return ids.map((id) => parsePerson(select.get(id))).filter(Boolean);
}

/** @returns {string | null} your own Slack user id */
export function myId(db) {
  return prepared(db, `SELECT id FROM people WHERE is_me = 1`).get()?.id ?? null;
}

/**
 * Public-channel posts in the offer/linkedin collections, for People counts.
 * No LIMIT: the People list needs every row to count correctly.
 * @returns {{ id, user_id, channel, ts, text, collection, confidence }[]}
 */
export function networkingPostRows(db) {
  return prepared(db, `SELECT m.id, m.user_id, m.channel, m.ts, m.text, mc.collection, mc.confidence
    FROM message_collections mc JOIN messages m ON m.id = mc.message_id
    WHERE mc.collection IN ('${OFFER_COLLECTION}', '${LINKEDIN_COLLECTION}') AND m.channel_type = 'public'
    ORDER BY m.ts, m.id`).all();
}

// ---------------------------------------------------------------- messages
/** @returns {object[]} DMs with a person, oldest first, with files and collections */
export function dmsWith(db, personId) {
  const sql = `SELECT ${MESSAGE_SELECT_LIST}, ${collectionsSubquery("messages")} FROM messages WHERE dm_with = ? ORDER BY ts, id`;
  return hydrate(db, prepared(db, sql).all(personId)).map(withCollectionKeys);
}

/** @returns {object[]} a person's non-DM messages, newest first (at most `limit`), with files and collections */
export function channelMessagesBy(db, personId, { limit }) {
  const sql = `SELECT ${MESSAGE_SELECT_LIST}, ${collectionsSubquery("messages")} FROM messages
               WHERE user_id = ? AND channel_type != 'im' ORDER BY ts DESC, id DESC LIMIT ?`;
  return hydrate(db, prepared(db, sql).all(personId, limit)).map(withCollectionKeys);
}

/**
 * Every public-channel message by a person (thread replies included), newest
 * first, with subtype and collections. Group DMs and private channels are
 * excluded: their text should not be quoted as a public "highlight".
 * Files are not attached here; call withFiles() on the rows you keep.
 */
export function publicMessagesBy(db, personId) {
  const sql = `SELECT ${MESSAGE_SELECT_LIST}, subtype, ${collectionsSubquery("messages")} FROM messages
               WHERE user_id = ? AND channel_type = 'public' ORDER BY ts DESC, id DESC`;
  return prepared(db, sql).all(personId).map(parseMessage);
}

/** @returns {object[]} channels with messages, DMs last, most recent first */
export function listChannels(db) {
  return prepared(db, `SELECT * FROM channels WHERE message_count > 0 ORDER BY type = 'im', last_ts DESC, id`).all();
}

/** @returns {object | null} */
export function getChannel(db, id) {
  return prepared(db, `SELECT * FROM channels WHERE id = ?`).get(id) ?? null;
}

/** @returns {object[]} one page of a channel's top-level messages, oldest first within the page */
export function channelPage(db, channelId, { limit, offset }) {
  const sql = `SELECT ${MESSAGE_SELECT_LIST} FROM messages WHERE channel_id = ? AND thread_ts IS NULL
               ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`;
  return hydrate(db, prepared(db, sql).all(channelId, limit, offset).reverse());
}

/** @returns {object[]} a thread: the parent and its replies, oldest first */
export function threadMessages(db, channelId, ts) {
  const sql = `SELECT ${MESSAGE_SELECT_LIST} FROM messages WHERE channel_id = @channel AND (ts = @ts OR thread_ts = @ts) ORDER BY ts, id`;
  return hydrate(db, prepared(db, sql).all({ channel: channelId, ts }));
}

/**
 * Full-text search.
 * @param {string} ftsQuery  an FTS5 MATCH expression (quoted terms, built by services/search)
 * @returns {object[]}
 */
export function ftsSearch(db, ftsQuery, { limit }) {
  const sql = `SELECT ${ALIASED_MESSAGE_SELECT_LIST} FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
               WHERE messages_fts MATCH ? ORDER BY rank, m.id LIMIT ?`;
  return hydrate(db, prepared(db, sql).all(ftsQuery, limit));
}

/** @returns {object[]} messages in the order of `ids` (unknown ids skipped), with files */
export function messagesByIds(db, ids) {
  const select = prepared(db, `SELECT ${MESSAGE_SELECT_LIST} FROM messages WHERE id = ?`);
  return hydrate(db, ids.map((id) => select.get(id)).filter(Boolean));
}

/** Attach `files` and decode `reactions` (mutation-free). */
export function withFiles(db, rows) {
  const selectFiles = prepared(db, `SELECT name, title, mimetype, size, local_path, permalink FROM files WHERE message_id = ?`);
  return rows.map((row) => ({ ...row, reactions: JSON.parse(row.reactions || "[]"), files: selectFiles.all(row.id) }));
}

// ---------------------------------------------------------------- collections
/** @returns {{ key, messages, people }[]} counts per collection that has rows */
export function collectionCounts(db) {
  return prepared(db, `SELECT mc.collection AS key, COUNT(*) AS messages, COUNT(DISTINCT m.user_id) AS people
    FROM message_collections mc JOIN messages m ON m.id = mc.message_id GROUP BY mc.collection`).all();
}

/**
 * Messages in one collection with their author, newest first.
 * @param {{ text?: string, limit: number }} opts  text filters message, author name and title
 */
export function collectionRows(db, key, { text, limit }) {
  const sql = `SELECT ${ALIASED_MESSAGE_SELECT_LIST},
      p.title AS author_title, p.linkedin AS author_linkedin, p.is_mentor AS author_is_mentor,
      p.has_avatar AS author_has_avatar, p.roles AS author_roles,
      p.is_sponsor AS author_is_sponsor, p.is_organizer AS author_is_organizer, p.org AS author_org,
      mc.confidence, mc.score, mc.source, ${collectionsSubquery("m")}
    FROM message_collections mc JOIN messages m ON m.id = mc.message_id
    LEFT JOIN people p ON p.id = m.user_id
    WHERE mc.collection = @key AND (@like IS NULL OR m.text LIKE @like ESCAPE '${LIKE_ESCAPE}'
      OR m.user_name LIKE @like ESCAPE '${LIKE_ESCAPE}' OR p.title LIKE @like ESCAPE '${LIKE_ESCAPE}')
    ORDER BY m.ts DESC, m.id DESC LIMIT @limit`;
  const rows = prepared(db, sql).all({ key, like: text ? likePattern(text) : null, limit });
  return hydrate(db, rows).map(withCollectionKeys).map(parseAuthor);
}

// ---------------------------------------------------------------- teammates inputs
/** @returns {{ user_id, channel }[]} other posters in group DMs / private channels you also posted in */
export function sharedGroupRows(db, me) {
  return prepared(db, `SELECT DISTINCT a.user_id, a.channel FROM messages a
    WHERE a.channel_type IN ('mpim','private') AND a.user_id != @me
      AND EXISTS (SELECT 1 FROM messages b WHERE b.channel_id = a.channel_id AND b.user_id = @me)
    ORDER BY a.user_id, a.channel`).all({ me: me ?? "" });
}

/** @returns {{ user_id, text, channel, date }[]} team-formation posts, oldest first */
export function teamPostRows(db) {
  return prepared(db, `SELECT m.user_id, m.text, m.channel, m.date FROM message_collections mc
    JOIN messages m ON m.id = mc.message_id WHERE mc.collection = '${TEAMMATE_COLLECTION}' ORDER BY m.ts, m.id`).all();
}

/** @returns {string[]} everyone you have a DM conversation with */
export function dmPartnerIds(db) {
  return prepared(db, `SELECT DISTINCT dm_with FROM messages WHERE dm_with IS NOT NULL ORDER BY dm_with`)
    .all()
    .map((row) => row.dm_with);
}

// ---------------------------------------------------------------- notes, briefs, stats
/** @returns {{ body, updated_at } | null} */
export function noteFor(db, personId) {
  return prepared(db, `SELECT body, updated_at FROM notes WHERE person_id = ?`).get(personId) ?? null;
}

/** Insert or replace a person's note. */
export function upsertNote(db, personId, body, nowIso) {
  prepared(db, `INSERT INTO notes (person_id, body, updated_at) VALUES (?,?,?)
    ON CONFLICT(person_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`).run(personId, body, nowIso);
}

/** @returns {object[]} saved briefs for a person, newest first */
export function briefsFor(db, personId) {
  return prepared(db, `SELECT * FROM briefs WHERE person_id = ? ORDER BY id DESC`).all(personId);
}

/** @returns {number | null} id of an identical saved brief */
export function findBrief(db, { personId, goal, body }) {
  const sql = `SELECT id FROM briefs WHERE person_id = ? AND goal = ? AND body = ? ORDER BY id DESC LIMIT 1`;
  return prepared(db, sql).get(personId, goal, body)?.id ?? null;
}

/** @returns {number} the new brief's id */
export function insertBrief(db, { personId, goal, body, createdAt }) {
  const info = prepared(db, `INSERT INTO briefs (person_id, goal, body, created_at) VALUES (?,?,?,?)`)
    .run(personId, goal, body, createdAt);
  return Number(info.lastInsertRowid);
}

/** @returns {object} archive totals for the home page */
export function getStats(db) {
  const count = (sql) => prepared(db, sql).get().n;
  return {
    messages: count(`SELECT COUNT(*) n FROM messages`),
    people: count(`SELECT COUNT(*) n FROM people WHERE is_me = 0`),
    mentors: count(`SELECT COUNT(*) n FROM people WHERE is_mentor = 1`),
    linkedin: count(`SELECT COUNT(*) n FROM people WHERE linkedin != '[]'`),
    channels: count(`SELECT COUNT(*) n FROM channels`),
    files: count(`SELECT COUNT(*) n FROM files WHERE local_path IS NOT NULL`),
    last_message: prepared(db, `SELECT MAX(date) d FROM messages`).get().d,
  };
}

/**
 * Changes whenever ANOTHER connection commits (`npm run db`, `sync`, the CLI),
 * independent of file mtimes. Our own writes are tracked by the HTTP layer.
 * @returns {number}
 */
export function dataVersion(db) {
  return db.pragma("data_version", { simple: true });
}

// ---------------------------------------------------------------- llm cache
/**
 * Persistent store for the Claude response cache, backed by llm_cache.
 * @param {import("better-sqlite3").Database} db  must have createUserTables() applied
 * @returns {{ get, touch, put, remove, prune: (nowMs: number) => number, size: (nowMs: number) => object }}
 */
export function llmStore(db) {
  const selectRow = db.prepare(`SELECT answer, created_at, expires_at FROM llm_cache WHERE key = ?`);
  const recordHit = db.prepare(`UPDATE llm_cache SET hits = hits + 1, last_hit_at = ? WHERE key = ?`);
  const deleteRow = db.prepare(`DELETE FROM llm_cache WHERE key = ?`);
  const upsertRow = db.prepare(`INSERT OR REPLACE INTO llm_cache (key, kind, model, answer, usage, created_at, expires_at)
                                VALUES (@key, @kind, @model, @answer, @usage, @created_at, @expires_at)`);
  const sizeQuery = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(LENGTH(answer)),0) b FROM llm_cache WHERE expires_at > ?`);
  const pruneExpired = db.prepare(`DELETE FROM llm_cache WHERE expires_at IS NULL OR expires_at <= ?`);
  return {
    get: (key) => selectRow.get(key),
    touch: (key, nowMs) => recordHit.run(new Date(nowMs).toISOString(), key),
    put: (row) => upsertRow.run({ ...row, usage: JSON.stringify(row.usage ?? null) }),
    remove: (key) => deleteRow.run(key),
    prune: (nowMs) => pruneExpired.run(nowMs).changes,
    size: (nowMs) => {
      const row = sizeQuery.get(nowMs);
      return { entries: row.n, bytes: row.b };
    },
  };
}

const llmStores = new WeakMap(); // one set of prepared statements per connection

/** @returns {ReturnType<typeof llmStore>} the memoized llmStore() for this connection */
export function llmStoreFor(db) {
  if (!llmStores.has(db)) llmStores.set(db, llmStore(db));
  return llmStores.get(db);
}

// ---------------------------------------------------------------- private helpers
function aliasedMessageColumns(alias) {
  return MESSAGE_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}

function prepared(db, sql) {
  if (!statements.has(db)) statements.set(db, new Map());
  const cache = statements.get(db);
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
}

function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (char) => LIKE_ESCAPE + char)}%`;
}

function hydrate(db, rows) {
  return withFiles(db, rows.map(parseMessage));
}

function parseMessage(row) {
  if (!("collections" in row)) return row;
  return { ...row, collections: parseCollections(row.collections) };
}

function parseCollections(json) {
  return JSON.parse(json || "[]").sort((a, b) => a.key.localeCompare(b.key));
}

// Most endpoints send collection keys only; highlights send the full objects.
function withCollectionKeys(row) {
  return { ...row, collections: row.collections.map((collection) => collection.key) };
}

function parseAuthor(row) {
  return {
    ...row,
    author_linkedin: JSON.parse(row.author_linkedin || "[]"),
    author_roles: JSON.parse(row.author_roles || "[]"),
    author_is_mentor: !!row.author_is_mentor,
    author_is_sponsor: !!row.author_is_sponsor,
    author_is_organizer: !!row.author_is_organizer,
  };
}
