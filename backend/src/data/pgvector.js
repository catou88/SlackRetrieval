// Owns the optional Postgres + pgvector copy of the archive, organised into
// collections: starting its Docker container (data kept in a named volume,
// listening on 127.0.0.1 only), loading the networking subset of the JSON
// snapshot with each message's vector, semantic search and the per-collection
// views, and a plain-SQL dump into data/.
import pg from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { embedQuery } from "../clients/embedder.js";
import { COLLECTIONS } from "../lib/collections.js";
import { readJSON, dataPath, FILES } from "./jsonStore.js";
import { loadIndex } from "./vectorIndex.js";

const STARTUP_TIMEOUT_SECONDS = 60;
const STARTUP_POLL_MS = 1000;
const INSERT_BATCH_ROWS = 200;
const DEFAULT_SEARCH_LIMIT = 15;
const DEFAULT_COLLECTION_LIMIT = 500;
const DUMP_FILE = "pgvector-dump.sql";
const DUMP_MAX_BYTES = 1 << 30; // pg_dump output is buffered in memory
const MISSING_CONTAINER = "missing";
const GROUP_CHANNEL_TYPES = new Set(["mpim", "private"]);

// Named views a caller can list instead of a raw collection key.
const VIEW_QUERIES = {
  "linkedin-directory": "SELECT * FROM linkedin_directory ORDER BY is_mentor DESC, name",
  mentors: "SELECT * FROM mentor_introductions",
  sponsors: "SELECT * FROM sponsor_opportunities",
  teammates: "SELECT * FROM teammates",
  offers: "SELECT * FROM offers",
};

const PEOPLE_COLUMN_COUNT = 21;
const MESSAGE_COLUMN_COUNT = 17;

/**
 * Start (or create) the pgvector container and wait until Postgres accepts connections.
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<void>}
 * @throws {Error} Docker not running, or Postgres not up within 60s
 */
export async function startPgvectorContainer({ log = console.log } = {}) {
  assertDockerRunning();
  const { container, image, volume, port, user, password, database } = CONFIG.pg;
  const running = containerRunningState();
  if (running === MISSING_CONTAINER) {
    log(`Starting ${image} (first time downloads ~150 MB)…`);
    docker(
      "run", "-d", "--name", container, "--restart", "unless-stopped",
      "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${database}`,
      "-p", `127.0.0.1:${port}:5432`, "-v", `${volume}:/var/lib/postgresql/data`, image
    );
  } else if (running !== "true") {
    docker("start", container);
  }
  await waitForPostgres(log);
}

/**
 * Replace the pgvector database with the networking subset of the snapshot:
 * categorized messages (with vectors), relevant people, channels, collections.
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<void>}
 * @throws {IndexUnavailableError} when there is no vector index yet
 */
export async function loadArchiveIntoPgvector({ log = console.log } = {}) {
  const messages = readJSON(FILES.messages, []);
  const people = readJSON(FILES.people, {});
  const channels = readJSON(FILES.channels, []);
  const categories = readJSON(FILES.categories, {});
  const me = readJSON(FILES.state, {}).me;

  const keptMessages = messages.filter((message) => categories[message.id]);
  const sharedGroups = sharedGroupsWithMe(messages, me);
  const dmPartners = new Set(messages.filter((message) => message.dm_with).map((message) => message.dm_with));
  const keptPeopleIds = peopleWorthKeeping(keptMessages, people, sharedGroups, dmPartners);
  log(`Storing ${keptMessages.length} networking messages and ${keptPeopleIds.size} people (of ${messages.length} total).`);

  const index = loadIndex();
  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query(schemaSql(index.dims));
    await insertCollections(client);
    await insertPeople(client, Object.values(people).filter((person) => keptPeopleIds.has(person.id)), { sharedGroups, dmPartners });
    await insertChannels(client, channels);
    await insertMessages(client, keptMessages, { categories, vectorLiteralOf: vectorLookup(index) });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    await client.end(); // an open connection would keep the CLI process alive
    throw err;
  }
  const { rows } = await client.query("SELECT key, messages, people FROM collection_summary");
  await client.end();
  log(`Loaded ${keptMessages.length} messages into pgvector.`);
  for (const row of rows) log(`  ${row.key.padEnd(15)} ${String(row.messages).padStart(5)} messages from ${row.people} people`);
}

/**
 * Semantic search inside pgvector, optionally within one collection.
 * @param {string} query
 * @param {{ collection?: string, k?: number }} [opts]
 * @returns {Promise<{ sent_at: Date, channel: string, user_name: string, text: string, collections: string[], score: number }[]>}
 */
export async function searchPgvector(query, { collection, k = DEFAULT_SEARCH_LIMIT } = {}) {
  const queryVector = await embedQuery(query);
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sent_at, channel, user_name, text, collections, 1 - (embedding <=> $1) AS score
       FROM messages WHERE ($2::text IS NULL OR $2 = ANY(collections)) AND embedding IS NOT NULL
       ORDER BY embedding <=> $1 LIMIT $3`,
      [vectorLiteral(queryVector), collection || null, k]
    );
    return rows;
  });
}

/**
 * Rows of a named view ("linkedin-directory", "mentors", "sponsors",
 * "teammates", "offers") or, for any other key, the messages in that collection.
 * @param {string} key
 * @param {{ limit?: number }} [opts]  applies to collection keys only
 * @returns {Promise<object[]>}
 */
export async function listPgvectorCollection(key, { limit = DEFAULT_COLLECTION_LIMIT } = {}) {
  return withClient(async (client) => {
    const viewQuery = VIEW_QUERIES[key];
    const { rows } = viewQuery
      ? await client.query(viewQuery)
      : await client.query(
        "SELECT sent_at, channel, user_name, text FROM messages WHERE $1 = ANY(collections) ORDER BY sent_at LIMIT $2",
        [key, limit]
      );
    return rows;
  });
}

/**
 * Plain-SQL backup of the pgvector database, kept alongside the rest of data/.
 * @param {{ log?: (line: string) => void }} [opts]
 * @throws {Error} when the container is not running
 */
export function dumpPgvectorDatabase({ log = console.log } = {}) {
  const { container, user, database } = CONFIG.pg;
  const target = dataPath(DUMP_FILE);
  const dump = execFileSync("docker", ["exec", container, "pg_dump", "-U", user, database], { maxBuffer: DUMP_MAX_BYTES });
  fs.writeFileSync(target, dump);
  log(`pgvector dump → ${target}`);
}

// ---------------------------------------------------------------- private helpers: docker
function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function assertDockerRunning() {
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("Docker isn't running. Open Docker Desktop, wait until it says 'Engine running', then retry.");
  }
}

/** @returns {string} "true", "false", or MISSING_CONTAINER */
function containerRunningState() {
  try {
    return docker("inspect", "-f", "{{.State.Running}}", CONFIG.pg.container);
  } catch {
    return MISSING_CONTAINER;
  }
}

async function waitForPostgres(log) {
  for (let attempt = 0; attempt < STARTUP_TIMEOUT_SECONDS; attempt++) {
    try {
      const client = await connect();
      await client.end();
      log(`pgvector ready at ${CONFIG.pg.url}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS)); // still booting
    }
  }
  throw new Error(`Postgres did not start within ${STARTUP_TIMEOUT_SECONDS}s; check \`docker logs ${CONFIG.pg.container}\`.`);
}

// ---------------------------------------------------------------- private helpers: connections
async function connect() {
  const client = new pg.Client(CONFIG.pg.url);
  await client.connect();
  return client;
}

async function withClient(work) {
  const client = await connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------- private helpers: loading
/** @returns {Record<string, string[]>} user id -> names of your group DMs / private channels they posted in */
function sharedGroupsWithMe(messages, me) {
  const groups = {};
  for (const message of messages) {
    if (!GROUP_CHANNEL_TYPES.has(message.channel_type)) continue;
    groups[message.channel_id] ??= { name: message.channel, posters: new Set() };
    groups[message.channel_id].posters.add(message.user_id);
  }
  // Who you actually hacked with: other posters in groups you posted in too.
  const sharedGroups = {};
  for (const group of Object.values(groups)) {
    if (!group.posters.has(me)) continue;
    for (const posterId of group.posters) if (posterId !== me) (sharedGroups[posterId] ??= []).push(group.name);
  }
  return sharedGroups;
}

function peopleWorthKeeping(keptMessages, people, sharedGroups, dmPartners) {
  const keep = new Set(keptMessages.map((message) => message.user_id));
  for (const person of Object.values(people)) {
    if (person.linkedin?.length || person.is_mentor || sharedGroups[person.id] || dmPartners.has(person.id)) keep.add(person.id);
  }
  return keep;
}

/** @returns {(messageId: string) => string | null} pgvector literal of a message's vector, null when unindexed */
function vectorLookup(index) {
  const rowOf = new Map(index.ids.map((id, row) => [id, row]));
  return (messageId) => {
    const row = rowOf.get(messageId);
    return row === undefined ? null : vectorLiteral(index.flat.subarray(row * index.dims, (row + 1) * index.dims));
  };
}

function vectorLiteral(vector) {
  return "[" + Array.from(vector).join(",") + "]";
}

function placeholders(columnCount, offset = 0) {
  return "(" + Array.from({ length: columnCount }, (_, column) => `$${offset + column + 1}`).join(",") + ")";
}

async function insertCollections(client) {
  for (const [key, { label }] of Object.entries(COLLECTIONS)) {
    await client.query("INSERT INTO collections VALUES ($1,$2)", [key, label]);
  }
}

async function insertPeople(client, people, { sharedGroups, dmPartners }) {
  for (const person of people) {
    await client.query(`INSERT INTO people VALUES ${placeholders(PEOPLE_COLUMN_COUNT)}`, [
      person.id, person.name, person.handle, person.title, person.email, person.pronouns, person.timezone,
      person.linkedin, person.other_links, person.roles, !!person.is_mentor, !!person.is_me,
      person.message_count, person.dm_count, person.first_seen, person.last_seen, person.channels,
      JSON.stringify(person.profile_fields || []),
      !!sharedGroups[person.id], sharedGroups[person.id] || [], dmPartners.has(person.id),
    ]);
  }
}

async function insertChannels(client, channels) {
  for (const channel of channels) {
    await client.query("INSERT INTO channels VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
      channel.id, channel.name, channel.type, channel.dm_with, channel.topic, channel.purpose,
    ]);
  }
}

// Multi-row inserts: one round trip per INSERT_BATCH_ROWS messages.
async function insertMessages(client, messages, { categories, vectorLiteralOf }) {
  for (let start = 0; start < messages.length; start += INSERT_BATCH_ROWS) {
    const batch = messages.slice(start, start + INSERT_BATCH_ROWS);
    const values = batch.flatMap((message) => messageRow(message, categories, vectorLiteralOf));
    const rows = batch.map((_, position) => placeholders(MESSAGE_COLUMN_COUNT, position * MESSAGE_COLUMN_COUNT));
    await client.query(`INSERT INTO messages VALUES ${rows.join(",")}`, values);
  }
}

function messageRow(message, categories, vectorLiteralOf) {
  return [
    message.id, message.channel_id, message.channel, message.channel_type, message.dm_with || null,
    message.ts, message.date, message.user_id, message.user_name,
    message.text, message.thread_ts || null, message.reply_count || 0, categories[message.id] || [],
    JSON.stringify(message.files || []), JSON.stringify(message.reactions || []), JSON.stringify(message.raw || null),
    vectorLiteralOf(message.id),
  ];
}

function schemaSql(dims) {
  return `
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
}
