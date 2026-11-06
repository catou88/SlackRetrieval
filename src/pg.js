// Postgres + pgvector copy of the archive, organised into collections.
// Runs in Docker (container "slack-pgvector", data kept in the
// "slack-pgvector-data" volume) and listens on localhost:5433 only.
import pg from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readJSON, dataPath } from "./store.js";
import { loadIndex, embed } from "./vectors.js";
import { COLLECTIONS } from "./categorize.js";

const CONTAINER = "slack-pgvector";
const VOLUME = "slack-pgvector-data";
const IMAGE = "pgvector/pgvector:pg17";
export const PG_URL = process.env.PG_URL || "postgres://slack:slack@127.0.0.1:5433/slack";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

export async function pgUp({ log = console.log } = {}) {
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("Docker isn't running. Open Docker Desktop, wait until it says 'Engine running', then retry.");
  }
  const state = (() => {
    try {
      return docker("inspect", "-f", "{{.State.Running}}", CONTAINER);
    } catch {
      return "missing";
    }
  })();
  if (state === "missing") {
    log(`Starting ${IMAGE} (first time downloads ~150 MB)…`);
    docker(
      "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "-e", "POSTGRES_USER=slack", "-e", "POSTGRES_PASSWORD=slack", "-e", "POSTGRES_DB=slack",
      "-p", "127.0.0.1:5433:5432", "-v", `${VOLUME}:/var/lib/postgresql/data`, IMAGE
    );
  } else if (state !== "true") {
    docker("start", CONTAINER);
  }
  for (let i = 0; i < 60; i++) {
    try {
      const c = new pg.Client(PG_URL);
      await c.connect();
      await c.end();
      log(`pgvector ready at ${PG_URL}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres did not start within 60s; check `docker logs slack-pgvector`.");
}

const SCHEMA = (dims) => `
CREATE EXTENSION IF NOT EXISTS vector;
DROP VIEW IF EXISTS linkedin_directory, mentor_introductions, offers, sponsor_opportunities, teammates, collection_summary;
DROP TABLE IF EXISTS message_collections, messages, channels, people, collections CASCADE;

CREATE TABLE collections (key text PRIMARY KEY, label text NOT NULL);

CREATE TABLE people (
  id text PRIMARY KEY, name text, handle text, title text, email text, pronouns text, timezone text,
  linkedin text[], other_links text[], roles text[], is_mentor boolean, is_me boolean,
  message_count int, dm_count int, first_seen timestamptz, last_seen timestamptz,
  channels text[], profile_fields jsonb,
  worked_with_me boolean, shared_groups text[], dmed_with_me boolean
);

CREATE TABLE channels (
  id text PRIMARY KEY, name text, type text, dm_with text, topic text, purpose text
);

CREATE TABLE messages (
  id text PRIMARY KEY,
  channel_id text, channel text, channel_type text, dm_with text,
  ts text, sent_at timestamptz, user_id text, user_name text,
  text text, thread_ts text, reply_count int,
  collections text[] NOT NULL DEFAULT '{}',
  files jsonb, reactions jsonb, raw jsonb,
  embedding vector(${dims})
);
CREATE INDEX messages_embedding_hnsw ON messages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX messages_collections ON messages USING gin (collections);
CREATE INDEX messages_user ON messages (user_id);
CREATE INDEX messages_channel ON messages (channel_id, ts);

-- Everyone with a LinkedIn, with their best intro / LinkedIn-sharing message.
CREATE VIEW linkedin_directory AS
SELECT p.name, p.title, p.roles, p.is_mentor, unnest(p.linkedin) AS linkedin, p.email,
       (SELECT m.text FROM messages m WHERE m.user_id = p.id AND m.collections && ARRAY['mentor_intro','linkedin']
        ORDER BY length(m.text) DESC LIMIT 1) AS introduction
FROM people p WHERE cardinality(p.linkedin) > 0 AND NOT p.is_me;

-- Mentor & judge intros: who they are, how to reach them.
CREATE VIEW mentor_introductions AS
SELECT p.name, p.title, p.linkedin, m.channel, m.sent_at, m.text
FROM messages m JOIN people p ON p.id = m.user_id
WHERE p.is_mentor AND (m.collections && ARRAY['mentor_intro','offer','linkedin'])
ORDER BY p.name, m.sent_at;

-- Everything someone offered: resume reviews, mentorship, referrals, advice.
CREATE VIEW offers AS
SELECT p.name, p.title, p.linkedin, p.is_mentor, m.channel, m.sent_at, m.text
FROM messages m JOIN people p ON p.id = m.user_id
WHERE 'offer' = ANY(m.collections) ORDER BY p.is_mentor DESC, p.name, m.sent_at;

-- Jobs, events, credits and other info posted by sponsors.
CREATE VIEW sponsor_opportunities AS
SELECT m.channel AS sponsor_channel, p.name, p.title, p.linkedin, m.sent_at, m.text, m.files
FROM messages m LEFT JOIN people p ON p.id = m.user_id
WHERE 'sponsor_opportunity' = ANY(m.collections) ORDER BY m.channel, m.sent_at;

-- Hackers to team up with next time: people you hacked with (group DMs /
-- private channels), people you DMed, and anyone who posted looking for a team.
CREATE VIEW teammates AS
SELECT p.name, p.title, p.linkedin, p.other_links, p.email, p.worked_with_me, p.shared_groups, p.dmed_with_me,
       (SELECT string_agg(m.text, E'
---
' ORDER BY m.sent_at) FROM messages m
        WHERE m.user_id = p.id AND m.collections && ARRAY['teammate','linkedin']) AS posts
FROM people p
WHERE NOT p.is_me AND NOT p.is_mentor AND (p.worked_with_me OR p.dmed_with_me OR EXISTS (
  SELECT 1 FROM messages m WHERE m.user_id = p.id AND 'teammate' = ANY(m.collections)))
ORDER BY p.worked_with_me DESC, p.dmed_with_me DESC, p.name;

CREATE VIEW collection_summary AS
SELECT c.key, c.label, count(m.id) AS messages, count(DISTINCT m.user_id) AS people
FROM collections c LEFT JOIN messages m ON c.key = ANY(m.collections)
GROUP BY c.key, c.label ORDER BY messages DESC;
`;

export async function pgLoad({ log = console.log } = {}) {
  const messages = readJSON("messages.json", []);
  const people = readJSON("people.json", {});
  const channels = readJSON("channels.json", []);
  const categories = readJSON("categories.json", {});
  const kept = messages.filter((m) => categories[m.id]);
  const keepPeople = new Set(kept.map((m) => m.user_id));
  // Who you actually hacked with: other posters in your group DMs / private channels.
  const me = readJSON("state.json", {}).me;
  const groups = {};
  for (const m of messages) if (m.channel_type === "mpim" || m.channel_type === "private") (groups[m.channel_id] ??= { name: m.channel, users: new Set() }).users.add(m.user_id);
  const sharedGroups = {};
  for (const g of Object.values(groups)) {
    if (!g.users.has(me)) continue;
    for (const u of g.users) if (u !== me) (sharedGroups[u] ??= []).push(g.name);
  }
  const dmed = new Set(messages.filter((m) => m.dm_with).map((m) => m.dm_with));
  for (const p of Object.values(people))
    if (p.linkedin?.length || p.is_mentor || sharedGroups[p.id] || dmed.has(p.id)) keepPeople.add(p.id);
  log(`Storing ${kept.length} networking messages and ${keepPeople.size} people (of ${messages.length} total).`);
  const index = loadIndex();
  const pos = new Map(index.ids.map((id, i) => [id, i]));
  const vec = (id) => {
    const i = pos.get(id);
    return i === undefined ? null : "[" + Array.from(index.flat.subarray(i * index.dims, (i + 1) * index.dims)).join(",") + "]";
  };

  const c = new pg.Client(PG_URL);
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(SCHEMA(index.dims));
    for (const [key, { label }] of Object.entries(COLLECTIONS))
      await c.query("INSERT INTO collections VALUES ($1,$2)", [key, label]);

    for (const p of Object.values(people).filter((p) => keepPeople.has(p.id))) {
      await c.query(
        `INSERT INTO people VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [p.id, p.name, p.handle, p.title, p.email, p.pronouns, p.timezone, p.linkedin, p.other_links, p.roles,
         !!p.is_mentor, !!p.is_me, p.message_count, p.dm_count, p.first_seen, p.last_seen, p.channels,
         JSON.stringify(p.profile_fields || []),
         !!sharedGroups[p.id], sharedGroups[p.id] || [], dmed.has(p.id)]
      );
    }
    for (const ch of channels) {
      await c.query(`INSERT INTO channels VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [
        ch.id, ch.name, ch.type, ch.dm_with, ch.topic, ch.purpose,
      ]);
    }

    const BATCH = 200;
    for (let i = 0; i < kept.length; i += BATCH) {
      const slice = kept.slice(i, i + BATCH);
      const values = [];
      const rows = slice.map((m, j) => {
        const b = j * 17;
        values.push(
          m.id, m.channel_id, m.channel, m.channel_type, m.dm_with || null, m.ts, m.date, m.user_id, m.user_name,
          m.text, m.thread_ts || null, m.reply_count || 0, categories[m.id] || [],
          JSON.stringify(m.files || []), JSON.stringify(m.reactions || []), JSON.stringify(m.raw || null), vec(m.id)
        );
        return "(" + Array.from({ length: 17 }, (_, k) => `$${b + k + 1}`).join(",") + ")";
      });
      await c.query(`INSERT INTO messages VALUES ${rows.join(",")}`, values);
      
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  }
  const { rows } = await c.query("SELECT key, messages, people FROM collection_summary");
  await c.end();
  log(`Loaded ${kept.length} messages into pgvector.`);
  for (const r of rows) log(`  ${r.key.padEnd(15)} ${String(r.messages).padStart(5)} messages from ${r.people} people`);
}

// Semantic search inside pgvector, optionally within one collection.
export async function pgSearch(query, { collection, k = 15 } = {}) {
  const [q] = await embed([query]);
  const c = new pg.Client(PG_URL);
  await c.connect();
  const { rows } = await c.query(
    `SELECT sent_at, channel, user_name, text, collections, 1 - (embedding <=> $1) AS score
     FROM messages WHERE ($2::text IS NULL OR $2 = ANY(collections)) AND embedding IS NOT NULL
     ORDER BY embedding <=> $1 LIMIT $3`,
    ["[" + Array.from(q).join(",") + "]", collection || null, k]
  );
  await c.end();
  return rows;
}

export async function pgCollection(key, { limit = 500 } = {}) {
  const c = new pg.Client(PG_URL);
  await c.connect();
  const { rows } =
    key === "linkedin-directory"
      ? await c.query(`SELECT * FROM linkedin_directory ORDER BY is_mentor DESC, name`)
      : key === "mentors"
        ? await c.query(`SELECT * FROM mentor_introductions`)
        : key === "sponsors"
          ? await c.query(`SELECT * FROM sponsor_opportunities`)
          : key === "teammates"
            ? await c.query(`SELECT * FROM teammates`)
        : key === "offers"
          ? await c.query(`SELECT * FROM offers`)
          : await c.query(
            `SELECT sent_at, channel, user_name, text FROM messages WHERE $1 = ANY(collections) ORDER BY sent_at LIMIT $2`,
            [key, limit]
          );
  await c.end();
  return rows;
}

// Plain-SQL backup of the pgvector database, kept alongside the rest of data/.
export function pgDump({ log = console.log } = {}) {
  const out = dataPath("pgvector-dump.sql");
  fs.writeFileSync(out, execFileSync("docker", ["exec", CONTAINER, "pg_dump", "-U", "slack", "slack"], { maxBuffer: 1 << 30 }));
  log(`pgvector dump → ${out}`);
}
