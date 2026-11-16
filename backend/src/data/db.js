// Owns the SQLite database (data/slack.db): opening it, its schema, and the
// rebuild of the Slack tables from the JSON snapshot. Your own tables (notes,
// briefs, llm_cache) are created once and never touched by a rebuild.
// All queries live in data/queries.js.
import Database from "better-sqlite3";
import { readJSON, dataPath, hasDataFile, relativeFilePath, avatarPath, FILES } from "./jsonStore.js";

/**
 * Bump when the rebuilt tables change shape; a server that finds an older
 * database rebuilds it from the snapshot on start (notes are kept).
 * v2: messages.subtype, message_collections confidence/score/source, files index.
 */
export const SCHEMA_VERSION = 2;

/** Confidence used for categories.json entries written before confidence existed. */
const LEGACY_CONFIDENCE = "medium";

const SLACK_TABLES_DDL = `
  DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS messages_fts;
  DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS channels; DROP TABLE IF EXISTS files;
  DROP TABLE IF EXISTS message_collections;
  CREATE TABLE people (
    id TEXT PRIMARY KEY, name TEXT, handle TEXT, title TEXT, email TEXT, pronouns TEXT, timezone TEXT,
    linkedin TEXT, other_links TEXT, roles TEXT, role_evidence TEXT, is_mentor INTEGER, likely_mentor INTEGER,
    is_sponsor INTEGER, is_organizer INTEGER, org TEXT, is_me INTEGER,
    message_count INTEGER, dm_count INTEGER, first_seen TEXT, last_seen TEXT, channels TEXT,
    profile_fields TEXT, has_avatar INTEGER
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY, name TEXT, type TEXT, dm_with TEXT, topic TEXT, purpose TEXT,
    message_count INTEGER, last_ts TEXT
  );
  -- raw: the full original Slack payload (JSON), kept so nothing is lost;
  -- subtype is promoted out of it because highlights filter on it.
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, channel_id TEXT, channel TEXT, channel_type TEXT, dm_with TEXT,
    ts TEXT, date TEXT, user_id TEXT, user_name TEXT, text TEXT, thread_ts TEXT,
    reply_count INTEGER, reactions TEXT, subtype TEXT, raw TEXT
  );
  CREATE INDEX messages_channel ON messages(channel_id, ts);
  CREATE INDEX messages_user ON messages(user_id);
  CREATE INDEX messages_thread ON messages(channel_id, thread_ts);
  CREATE INDEX messages_dm ON messages(dm_with);
  CREATE TABLE files (
    id TEXT, message_id TEXT, name TEXT, title TEXT, mimetype TEXT, size INTEGER,
    local_path TEXT, permalink TEXT
  );
  CREATE INDEX files_message ON files(message_id);
  -- confidence: 'high' | 'medium' | 'low'; score: similarity (NULL for pure rules);
  -- source: what decided it, e.g. 'rule:linkedin_url', 'similarity', 'keyword'.
  CREATE TABLE message_collections (
    message_id TEXT, collection TEXT,
    confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
    score REAL, source TEXT NOT NULL,
    PRIMARY KEY (message_id, collection)
  );
  CREATE INDEX message_collections_c ON message_collections(collection);
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, user_name, channel, content='messages', content_rowid='rowid');
`;

/**
 * Open (creating if needed) a connection in WAL mode with the user tables.
 * Each call returns a new connection; the server keeps one for its lifetime.
 * @param {string} [file]  defaults to data/slack.db
 * @returns {import("better-sqlite3").Database}
 */
export function openDb(file = dataPath(FILES.database)) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  // A note POST during an external rebuild (~1–2 s) waits instead of failing.
  db.pragma("busy_timeout = 10000");
  createUserTables(db);
  return db;
}

/**
 * Create the tables a rebuild never touches: your notes, saved briefs and the
 * Claude response cache. Exported so tests can use an in-memory database.
 * @param {import("better-sqlite3").Database} db
 * @returns {import("better-sqlite3").Database} the same database
 */
export function createUserTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      person_id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT, goal TEXT, body TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_cache (
      key TEXT PRIMARY KEY, kind TEXT, model TEXT, answer TEXT, usage TEXT,
      created_at TEXT, expires_at INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT
    );
  `);
  return db;
}

/** @returns {boolean} whether the Slack tables are missing or older than SCHEMA_VERSION */
export function needsRebuild(db) {
  const hasMessages = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages'`).get();
  return !hasMessages || db.pragma("user_version", { simple: true }) < SCHEMA_VERSION;
}

/**
 * Read the JSON snapshot rebuildDb() needs (missing files are empty).
 * @returns {{ messages: object[], people: object, channels: object[], categories: object, categoryDetails: object }}
 */
export function loadSnapshot() {
  return {
    messages: readJSON(FILES.messages, []),
    people: readJSON(FILES.people, {}),
    channels: readJSON(FILES.channels, []),
    categories: readJSON(FILES.categories, {}),
    categoryDetails: readJSON(FILES.categoryDetails, {}),
  };
}

/**
 * Replace the Slack tables with the snapshot. DDL and data run in ONE
 * transaction (SQLite DDL is transactional), so a running server reading via
 * WAL sees either the old tables or the new ones, never missing or half-filled.
 * @param {import("better-sqlite3").Database} db
 * @param {ReturnType<typeof loadSnapshot>} snapshot
 * @param {{ log?: (line: string) => void, fileExists?: (relativePath: string) => boolean }} [opts]
 */
export function rebuildDb(db, snapshot, { log = console.log, fileExists = hasDataFile } = {}) {
  db.transaction(() => {
    db.exec(SLACK_TABLES_DDL);
    insertPeople(db, snapshot.people, fileExists);
    insertChannels(db, snapshot.channels);
    insertMessages(db, snapshot.messages, fileExists);
    insertCollections(db, snapshot.categories, snapshot.categoryDetails);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  log(`Database: ${snapshot.messages.length} messages, ${Object.keys(snapshot.people).length} people → ${db.name}`);
}

// ---------------------------------------------------------------- private helpers
function insertPeople(db, people, fileExists) {
  const insert = db.prepare(`INSERT INTO people VALUES (@id,@name,@handle,@title,@email,@pronouns,@timezone,
    @linkedin,@other_links,@roles,@role_evidence,@is_mentor,@likely_mentor,@is_sponsor,@is_organizer,@org,@is_me,
    @message_count,@dm_count,@first_seen,@last_seen,@channels,@profile_fields,@has_avatar)`);
  for (const person of Object.values(people)) insert.run(personRow(person, fileExists(avatarPath(person.id))));
}

function personRow(person, hasAvatar) {
  return {
    handle: "", title: "", email: "", pronouns: "", timezone: "", first_seen: null, last_seen: null,
    message_count: 0, dm_count: 0,
    ...person,
    linkedin: JSON.stringify(person.linkedin || []),
    other_links: JSON.stringify(person.other_links || []),
    roles: JSON.stringify(person.roles || []),
    role_evidence: JSON.stringify(person.role_evidence || []),
    channels: JSON.stringify(person.channels || []),
    profile_fields: JSON.stringify(person.profile_fields || []),
    is_mentor: person.is_mentor ? 1 : 0,
    likely_mentor: person.likely_mentor ? 1 : 0,
    is_sponsor: person.is_sponsor ? 1 : 0,
    is_organizer: person.is_organizer ? 1 : 0,
    org: person.org || "",
    is_me: person.is_me ? 1 : 0,
    has_avatar: hasAvatar ? 1 : 0,
  };
}

function insertChannels(db, channels) {
  const insert = db.prepare(`INSERT OR REPLACE INTO channels VALUES (@id,@name,@type,@dm_with,@topic,@purpose,0,NULL)`);
  for (const channel of channels) insert.run({ dm_with: null, topic: "", purpose: "", ...channel });
}

function insertMessages(db, messages, fileExists) {
  const insertMessage = db.prepare(`INSERT OR REPLACE INTO messages VALUES (@id,@channel_id,@channel,@channel_type,@dm_with,
    @ts,@date,@user_id,@user_name,@text,@thread_ts,@reply_count,@reactions,@subtype,@raw)`);
  const insertFile = db.prepare(`INSERT INTO files VALUES (@id,@message_id,@name,@title,@mimetype,@size,@local_path,@permalink)`);
  for (const message of messages) {
    insertMessage.run({
      dm_with: null, thread_ts: null, reply_count: 0,
      ...message,
      text: message.text ?? "",
      reactions: JSON.stringify(message.reactions || []),
      subtype: message.raw?.subtype ?? null,
      raw: JSON.stringify(message.raw || null),
    });
    for (const file of message.files || []) {
      const local = relativeFilePath(file);
      insertFile.run({
        title: "", mimetype: "", size: 0, permalink: "",
        ...file,
        message_id: message.id,
        local_path: fileExists(local) ? local : null,
      });
    }
  }
  // Channels seen only through messages (e.g. from an older snapshot).
  db.exec(`INSERT OR IGNORE INTO channels (id,name,type,dm_with)
           SELECT channel_id, channel, channel_type, dm_with FROM messages GROUP BY channel_id`);
  db.exec(`UPDATE channels SET
             message_count = (SELECT COUNT(*) FROM messages m WHERE m.channel_id = channels.id),
             last_ts = (SELECT MAX(ts) FROM messages m WHERE m.channel_id = channels.id)`);
}

function insertCollections(db, categories, categoryDetails) {
  const insert = db.prepare(`INSERT OR IGNORE INTO message_collections VALUES (?, ?, ?, ?, ?)`);
  for (const [messageId, keys] of Object.entries(categories)) {
    for (const key of keys) {
      const detail = categoryDetails[messageId]?.[key];
      insert.run(messageId, key, detail?.confidence ?? LEGACY_CONFIDENCE, detail?.score ?? null, detail?.source ?? "legacy");
    }
  }
}
