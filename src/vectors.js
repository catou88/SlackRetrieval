// Local embeddings + cosine-similarity vector index. No API key needed: the
// model (all-MiniLM-L6-v2, ~23 MB) downloads once and runs on your CPU.
import { pipeline, env } from "@xenova/transformers";
import fs from "node:fs";
import { readJSON, dataPath, DATA_DIR } from "./store.js";

const MODEL = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
env.cacheDir = `${DATA_DIR}/models`;

let extractor;
async function embedder() {
  extractor ??= await pipeline("feature-extraction", MODEL);
  return extractor;
}

export async function embed(texts) {
  const ex = await embedder();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  const dims = out.dims[1];
  return texts.map((_, i) => out.data.slice(i * dims, (i + 1) * dims));
}

// What actually gets embedded for one message: who said it, where, and the
// thread it belongs to, so "what did the Google mentor say about auth" works.
export function chunkText(m, people, parents) {
  const who = people[m.user_id];
  const role = who?.title ? ` (${who.title})` : "";
  const parent = m.thread_ts ? parents.get(`${m.channel_id}:${m.thread_ts}`) : null;
  const ctx = parent ? `\n[reply to ${parent.user_name}: ${parent.text.slice(0, 200)}]` : "";
  return `${m.channel} — ${m.user_name}${role}: ${m.text}${ctx}`;
}

const INDEX_FILE = "index.bin";
const META_FILE = "index.meta.json";

export async function buildIndex({ log = console.log, batch = 32 } = {}) {
  const messages = readJSON("messages.json", []).filter((m) => m.text.trim());
  const people = readJSON("people.json", {});
  const parents = new Map(messages.map((m) => [m.id, m]));

  const meta = readJSON(META_FILE, { model: MODEL, dims: 0, ids: [] });
  let vectors = [];
  if (meta.model === MODEL && fs.existsSync(dataPath(INDEX_FILE)) && meta.dims) {
    const buf = fs.readFileSync(dataPath(INDEX_FILE));
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    vectors = meta.ids.map((_, i) => all.slice(i * meta.dims, (i + 1) * meta.dims));
  } else {
    meta.ids = [];
    meta.model = MODEL;
  }
  const have = new Set(meta.ids);
  const todo = messages.filter((m) => !have.has(m.id));
  log(`Embedding ${todo.length} new messages (${have.size} already indexed)…`);

  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vecs = await embed(slice.map((m) => chunkText(m, people, parents)));
    slice.forEach((m, j) => {
      meta.ids.push(m.id);
      vectors.push(vecs[j]);
    });
    meta.dims = vecs[0].length;
    if ((i / batch) % 10 === 0) log(`  ${Math.min(i + batch, todo.length)}/${todo.length}`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const flat = new Float32Array(vectors.length * (meta.dims || 0));
  vectors.forEach((v, i) => flat.set(v, i * meta.dims));
  fs.writeFileSync(dataPath(INDEX_FILE), Buffer.from(flat.buffer));
  fs.writeFileSync(dataPath(META_FILE), JSON.stringify(meta));
  log(`Index has ${meta.ids.length} vectors.`);
}

export function loadIndex() {
  const meta = readJSON(META_FILE, null);
  if (!meta || !fs.existsSync(dataPath(INDEX_FILE)))
    throw new Error("No index yet — run `npm run index` first.");
  const buf = fs.readFileSync(dataPath(INDEX_FILE));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { ...meta, flat };
}

// Top-k cosine similarity (vectors are normalized, so dot product == cosine).
// `filter(id)` restricts the search, e.g. to one person's messages.
export async function search(query, { k = 12, filter, index = loadIndex() } = {}) {
  const [q] = await embed([query]);
  const { flat, dims, ids } = index;
  const scored = [];
  for (let i = 0; i < ids.length; i++) {
    if (filter && !filter(ids[i])) continue;
    let s = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) s += flat[off + d] * q[d];
    scored.push([s, ids[i]]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([score, id]) => ({ id, score }));
}
