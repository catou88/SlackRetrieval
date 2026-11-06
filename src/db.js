// Local SQLite database (data/slack.db) built from the JSON snapshot.
// Slack tables are rebuilt on every sync; your own `notes` and `briefs`
// tables are never touched by a rebuild.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { readJSON, dataPath, DATA_DIR } from "./store.js";
import { localFileName } from "./ingest.js";

let db;
export function openDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(dataPath("slack.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      person_id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT, goal TEXT, body TEXT, created_at TEXT
    );
  `);
  return db;
}

export function rebuildDb({ log = console.log } = {}) {
  const d = openDb();
  const messages = readJSON("messages.json", []);
  const people = readJSON("people.json", {});
  const channels = readJSON("channels.json", []);
  const categories = readJSON("categories.json", {});

  d.exec(`
    DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS people;   DROP TABLE IF EXISTS channels; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS message_collections;
    CREATE TABLE people (
      id TEXT PRIMARY KEY, name TEXT, handle TEXT, title TEXT, email TEXT, pronouns TEXT, timezone TEXT,
      linkedin TEXT, other_links TEXT, roles TEXT, role_evidence TEXT, is_mentor INTEGER, likely_mentor INTEGER, is_sponsor INTEGER, is_organizer INTEGER, org TEXT, is_me INTEGER,
      message_count INTEGER, dm_count INTEGER, first_seen TEXT, last_seen TEXT, channels TEXT,
      profile_fields TEXT, has_avatar INTEGER
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, dm_with TEXT, topic TEXT, purpose TEXT,
      message_count INTEGER, last_ts TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, channel_id TEXT, channel TEXT, channel_type TEXT, dm_with TEXT,
      ts TEXT, date TEXT, user_id TEXT, user_name TEXT, text TEXT, thread_ts TEXT,
      reply_count INTEGER, reactions TEXT, raw TEXT
    );
    CREATE INDEX messages_channel ON messages(channel_id, ts);
    CREATE INDEX messages_user ON messages(user_id);
    CREATE INDEX messages_thread ON messages(channel_id, thread_ts);
    CREATE TABLE files (
      id TEXT, message_id TEXT, name TEXT, title TEXT, mimetype TEXT, size INTEGER,
      local_path TEXT, permalink TEXT
    );
    CREATE TABLE message_collections (message_id TEXT, collection TEXT, PRIMARY KEY (message_id, collection));
    CREATE INDEX message_collections_c ON message_collections(collection);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, user_name, channel, content='messages', content_rowid='rowid');
  `);

  const insP = d.prepare(`INSERT INTO people VALUES (@id,@name,@handle,@title,@email,@pronouns,@timezone,
    @linkedin,@other_links,@roles,@role_evidence,@is_mentor,@likely_mentor,@is_sponsor,@is_organizer,@org,@is_me,@message_count,@dm_count,@first_seen,@last_seen,
    @channels,@profile_fields,@has_avatar)`);
  const insC = d.prepare(`INSERT OR REPLACE INTO channels VALUES (@id,@name,@type,@dm_with,@topic,@purpose,0,NULL)`);
  const insM = d.prepare(`INSERT OR REPLACE INTO messages VALUES (@id,@channel_id,@channel,@channel_type,@dm_with,
    @ts,@date,@user_id,@user_name,@text,@thread_ts,@reply_count,@reactions,@raw)`);
  const insF = d.prepare(`INSERT INTO files VALUES (@id,@message_id,@name,@title,@mimetype,@size,@local_path,@permalink)`);

  d.transaction(() => {
    for (const p of Object.values(people)) {
      insP.run({
        handle: "", title: "", email: "", pronouns: "", timezone: "", first_seen: null, last_seen: null,
        ...p,
        linkedin: JSON.stringify(p.linkedin),
        other_links: JSON.stringify(p.other_links),
        roles: JSON.stringify(p.roles),
        role_evidence: JSON.stringify(p.role_evidence),
        channels: JSON.stringify(p.channels),
        profile_fields: JSON.stringify(p.profile_fields),
        is_mentor: p.is_mentor ? 1 : 0,
        likely_mentor: p.likely_mentor ? 1 : 0,
        is_sponsor: p.is_sponsor ? 1 : 0,
        is_organizer: p.is_organizer ? 1 : 0,
        org: p.org || "",
        is_me: p.is_me ? 1 : 0,
        has_avatar: fs.existsSync(dataPath(`avatars/${p.id}.jpg`)) ? 1 : 0,
      });
    }
    for (const c of channels) insC.run({ dm_with: null, topic: "", purpose: "", ...c });
    for (const m of messages) {
      insM.run({
        dm_with: null,
        thread_ts: null,
        reply_count: 0,
        ...m,
        reactions: JSON.stringify(m.reactions || []),
        raw: JSON.stringify(m.raw || null),
      });
      for (const f of m.files || []) {
        const local = path.join("files", localFileName(f));
        insF.run({
          title: "", mimetype: "", size: 0, permalink: "",
          ...f,
          message_id: m.id,
          local_path: fs.existsSync(dataPath(local)) ? local.replace(/\\/g, "/") : null,
        });
      }
    }
    // Channels seen only through messages (e.g. from an older snapshot).
    d.exec(`INSERT OR IGNORE INTO channels (id,name,type,dm_with)
            SELECT channel_id, channel, channel_type, dm_with FROM messages GROUP BY channel_id`);
    d.exec(`UPDATE channels SET
              message_count = (SELECT COUNT(*) FROM messages m WHERE m.channel_id = channels.id),
              last_ts = (SELECT MAX(ts) FROM messages m WHERE m.channel_id = channels.id)`);
    const insMC = d.prepare(`INSERT OR IGNORE INTO message_collections VALUES (?, ?)`);
    for (const [id, cats] of Object.entries(categories)) for (const c of cats) insMC.run(id, c);
    d.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  })();

  log(`Database: ${messages.length} messages, ${Object.keys(people).length} people → ${dataPath("slack.db")}`);
}

export const parsePerson = (row) =>
  row && {
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
  };
