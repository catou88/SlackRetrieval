// Local website: http://localhost:3000 — only reachable from this computer.
import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { openDb, parsePerson } from "./db.js";
import { DATA_DIR } from "./store.js";
import { ask, brief } from "./rag.js";
import { search } from "./vectors.js";
import { COLLECTIONS } from "./categorize.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve("public");
const db = openDb();
// First run before any sync: create the (empty) tables so the site still loads.
if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages'`).get()) {
  const { rebuildDb } = await import("./db.js");
  rebuildDb({ log: () => {} });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
};

const msgCols = `id, channel_id, channel, channel_type, ts, date, user_id, user_name, text, thread_ts, reply_count, reactions`;
const withFiles = (rows) => {
  const q = db.prepare(`SELECT name, title, mimetype, size, local_path, permalink FROM files WHERE message_id = ?`);
  return rows.map((r) => ({ ...r, reactions: JSON.parse(r.reactions || "[]"), files: q.all(r.id) }));
};

const routes = {
  "GET /api/stats": () => ({
    messages: db.prepare(`SELECT COUNT(*) n FROM messages`).get().n,
    people: db.prepare(`SELECT COUNT(*) n FROM people WHERE is_me = 0`).get().n,
    mentors: db.prepare(`SELECT COUNT(*) n FROM people WHERE is_mentor = 1`).get().n,
    linkedin: db.prepare(`SELECT COUNT(*) n FROM people WHERE linkedin != '[]'`).get().n,
    channels: db.prepare(`SELECT COUNT(*) n FROM channels`).get().n,
    files: db.prepare(`SELECT COUNT(*) n FROM files WHERE local_path IS NOT NULL`).get().n,
    last_message: db.prepare(`SELECT MAX(date) d FROM messages`).get().d,
    claude: !!(
      (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes("your-key")) ||
      process.env.ANTHROPIC_AUTH_TOKEN
    ),
  }),

  "GET /api/people": (q) => {
    const where = ["is_me = 0"];
    const args = {};
    if (q.get("mentors")) where.push("is_mentor = 1");
    if (q.get("linkedin")) where.push("linkedin != '[]'");
    if (q.get("q")) where.push("(name LIKE @q OR title LIKE @q OR handle LIKE @q)"), (args.q = `%${q.get("q")}%`);
    return db
      .prepare(`SELECT p.*, n.body AS note FROM people p LEFT JOIN notes n ON n.person_id = p.id
                WHERE ${where.join(" AND ")} ORDER BY dm_count DESC, message_count DESC`)
      .all(args)
      .map(parsePerson);
  },

  "GET /api/person": (q) => {
    const id = q.get("id");
    const person = parsePerson(db.prepare(`SELECT * FROM people WHERE id = ?`).get(id));
    if (!person) return { error: "not found" };
    const dms = db.prepare(`SELECT ${msgCols} FROM messages WHERE dm_with = ? ORDER BY ts`).all(id);
    const theirs = db
      .prepare(`SELECT ${msgCols} FROM messages WHERE user_id = ? AND channel_type != 'im' ORDER BY ts DESC LIMIT 300`)
      .all(id);
    const note = db.prepare(`SELECT body, updated_at FROM notes WHERE person_id = ?`).get(id);
    const briefs = db.prepare(`SELECT * FROM briefs WHERE person_id = ? ORDER BY id DESC`).all(id);
    return { person, dms: withFiles(dms), messages: withFiles(theirs), note, briefs };
  },

  "GET /api/channels": () =>
    db.prepare(`SELECT * FROM channels WHERE message_count > 0 ORDER BY type = 'im', last_ts DESC`).all(),

  "GET /api/channel": (q) => {
    const id = q.get("id");
    const channel = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id);
    const rows = db
      .prepare(`SELECT ${msgCols} FROM messages WHERE channel_id = ? AND thread_ts IS NULL ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(id, Number(q.get("limit")) || 200, Number(q.get("offset")) || 0)
      .reverse();
    return { channel, messages: withFiles(rows) };
  },

  "GET /api/thread": (q) =>
    withFiles(
      db
        .prepare(`SELECT ${msgCols} FROM messages WHERE channel_id = ? AND (ts = @t OR thread_ts = @t) ORDER BY ts`)
        .all(q.get("channel"), { t: q.get("ts") })
    ),

  "GET /api/search": async (q) => {
    const text = (q.get("q") || "").trim();
    if (!text) return [];
    if (q.get("mode") === "keyword") {
      const fts = text.split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
      return withFiles(
        db
          .prepare(`SELECT ${msgCols.split(", ").map((c) => "m." + c).join(", ")} FROM messages_fts f
                    JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT 100`)
          .all(fts)
      );
    }
    const hits = await search(text, { k: 50 });
    const get = db.prepare(`SELECT ${msgCols} FROM messages WHERE id = ?`);
    return withFiles(hits.map((h) => ({ ...get.get(h.id), score: h.score })).filter((m) => m.id));
  },

  // Networking collections: mentor_intro | offer | sponsor_opportunity | teammate | linkedin
  "GET /api/collections": () => {
    const labels = Object.fromEntries(Object.entries(COLLECTIONS).map(([k, v]) => [k, v.label]));
    const rows = db
      .prepare(`SELECT mc.collection AS key, COUNT(*) AS messages, COUNT(DISTINCT m.user_id) AS people
                FROM message_collections mc JOIN messages m ON m.id = mc.message_id GROUP BY mc.collection`)
      .all();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    return Object.keys(labels).map((key) => ({ key, label: labels[key], messages: byKey[key]?.messages || 0, people: byKey[key]?.people || 0 }));
  },

  "GET /api/collection": (q) => {
    const key = q.get("key");
    const text = q.get("q") ? `%${q.get("q")}%` : null;
    const rows = db
      .prepare(`SELECT ${msgCols.split(", ").map((c) => "m." + c).join(", ")},
                       p.title AS author_title, p.linkedin AS author_linkedin, p.is_mentor AS author_is_mentor,
                       p.has_avatar AS author_has_avatar, p.roles AS author_roles,
                       p.is_sponsor AS author_is_sponsor, p.is_organizer AS author_is_organizer, p.org AS author_org,
                       (SELECT group_concat(collection) FROM message_collections x WHERE x.message_id = m.id) AS collections
                FROM message_collections mc JOIN messages m ON m.id = mc.message_id
                LEFT JOIN people p ON p.id = m.user_id
                WHERE mc.collection = @key AND (@text IS NULL OR m.text LIKE @text OR m.user_name LIKE @text OR p.title LIKE @text)
                ORDER BY m.ts DESC LIMIT 500`)
      .all({ key, text });
    return withFiles(rows).map((r) => ({
      ...r,
      author_linkedin: JSON.parse(r.author_linkedin || "[]"),
      author_roles: JSON.parse(r.author_roles || "[]"),
      author_is_mentor: !!r.author_is_mentor,
      author_is_sponsor: !!r.author_is_sponsor,
      author_is_organizer: !!r.author_is_organizer,
      collections: (r.collections || "").split(",").filter(Boolean),
    }));
  },

  // People to hack with again: shared group DMs / private channels, DMs, team-formation posts.
  "GET /api/teammates": () => {
    const me = db.prepare(`SELECT id FROM people WHERE is_me = 1`).get()?.id;
    const shared = {};
    for (const r of db
      .prepare(`SELECT DISTINCT a.user_id AS uid, a.channel AS channel FROM messages a
                WHERE a.channel_type IN ('mpim','private') AND a.user_id != @me
                  AND EXISTS (SELECT 1 FROM messages b WHERE b.channel_id = a.channel_id AND b.user_id = @me)`)
      .all({ me: me || "" }))
      (shared[r.uid] ??= []).push(r.channel);
    const posts = {};
    for (const r of db
      .prepare(`SELECT m.user_id AS uid, m.text, m.channel, m.date FROM message_collections mc
                JOIN messages m ON m.id = mc.message_id WHERE mc.collection = 'teammate' ORDER BY m.ts`)
      .all())
      (posts[r.uid] ??= []).push({ text: r.text, channel: r.channel, date: r.date });
    const ids = new Set([...Object.keys(shared), ...Object.keys(posts)]);
    for (const r of db.prepare(`SELECT id FROM people WHERE dm_count > 0 AND is_mentor = 0 AND is_me = 0`).all()) ids.add(r.id);
    const get = db.prepare(`SELECT * FROM people WHERE id = ?`);
    return [...ids]
      .map((id) => parsePerson(get.get(id)))
      .filter((p) => p && !p.is_me && !p.is_mentor && !p.is_sponsor && !p.is_organizer)
      .map((p) => ({ ...p, shared_groups: shared[p.id] || [], team_posts: posts[p.id] || [] }))
      .sort((a, b) => b.shared_groups.length - a.shared_groups.length || b.dm_count - a.dm_count || a.name.localeCompare(b.name));
  },

  "POST /api/ask": async (_, body) => {
    const { answer, hits } = await ask(body.question, { person: body.person || undefined, mentorsOnly: !!body.mentors });
    return { answer, sources: hits.map((h) => ({ score: h.score, ...h.message, raw: undefined })) };
  },

  "POST /api/brief": async (_, body) => {
    const { person, answer } = await brief(body.person, { goal: body.goal || "" });
    db.prepare(`INSERT INTO briefs (person_id, goal, body, created_at) VALUES (?,?,?,?)`).run(
      person.id, body.goal || "", answer, new Date().toISOString()
    );
    return { answer };
  },

  "POST /api/note": (_, body) => {
    db.prepare(`INSERT INTO notes (person_id, body, updated_at) VALUES (?,?,?)
                ON CONFLICT(person_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`).run(
      body.person_id, body.body || "", new Date().toISOString()
    );
    return { ok: true };
  },
};

function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// Resolve a URL path inside `root`, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const p = path.resolve(root, "." + decodeURIComponent(urlPath));
  return p.startsWith(root + path.sep) || p === root ? p : null;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      if (handler) {
        let body = {};
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          body = JSON.parse(raw || "{}");
        }
        const result = await handler(url.searchParams, body);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      for (const dir of ["files", "avatars"]) {
        if (url.pathname.startsWith(`/${dir}/`)) {
          const root = path.resolve(DATA_DIR, dir);
          const p = safeJoin(root, url.pathname.slice(dir.length + 1));
          return p ? sendFile(res, p) : res.writeHead(403).end();
        }
      }
      const p = url.pathname === "/" ? path.join(PUBLIC, "index.html") : safeJoin(PUBLIC, url.pathname);
      return p ? sendFile(res, p) : res.writeHead(403).end();
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Slack archive running at http://localhost:${PORT}`));
