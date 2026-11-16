#!/usr/bin/env node
// Draws a deterministic, stratified held-out sample of Slack messages for
// evaluating backend/src/services/categorize.js and writes it to data/eval/heldout.json
// (git-ignored — it contains message text; this script contains none).
//
//   node backend/scripts/eval/sample.js [--seed 13] [--size 200] [--force]
//
// Strata (each message lands in the first stratum that picks it; deduped):
//   pos:<collection>   ~15 predicted positives per collection: about half the
//                      ones closest to the similarity threshold, the rest random
//   near:<collection>  ~8 predicted negatives just below the threshold
//   kw                 ~40 predicted negatives that contain outreach keywords
//   random             random eligible messages, filling up to --size
// Eligible = not a Slack system row (raw.subtype), text >= 12 chars, not a DM.
// Deduped by id and by normalized text.
// Each item gets split "dev" (60%) or "test" (40%), stratified by stratum.
// Everything the classifier said goes in `prediction` so labeling can be blind.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// backend/scripts/eval -> repo root (where data/ lives) is three levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(ROOT); // relative paths printed below (and any relative DATA_DIR) are against the repo root

const args = parseArgs(process.argv.slice(2));
const SEED = Number(args.seed ?? 13);
const SIZE = Number(args.size ?? 200);
const PER_POS = Number(args["per-pos"] ?? 15);
const PER_NEAR = Number(args["per-near"] ?? 8);
const N_KW = Number(args.kw ?? 40);
const OUT = path.join(ROOT, "data", "eval", "heldout.json");

if (fs.existsSync(OUT) && !args.force) {
  console.error(`${path.relative(ROOT, OUT)} already exists (labels refer to it). Pass --force to overwrite.`);
  process.exit(1);
}

const { rng, shuffle, outreachMention, KEYWORD_RE, confidenceOf, THRESHOLD, SIM_CLASSES, CLASSES, findSrc, readData } = await import("./common.js");
const { embed } = await import(findSrc("embedder.js"));
const { loadIndex } = await import(findSrc("vectorIndex.js"));
const { COLLECTIONS } = await import(findSrc("categorize.js"));

const messages = readData("messages.json", []);
const people = readData("people.json", {});
const categories = readData("categories.json", null);
if (!categories) throw new Error("data/categories.json missing — run `npm run categorize` first.");
const index = loadIndex();
const pos = new Map(index.ids.map((id, i) => [id, i]));
const { flat, dims } = index;

// Same similarity as categorize.js: max dot product (= cosine, vectors are
// normalized) between the message vector and the collection's example sentences.
const protos = {};
for (const key of SIM_CLASSES) protos[key] = await embed(COLLECTIONS[key].examples);
const sim = (i, vecs) => {
  let best = -1;
  for (const v of vecs) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += flat[i * dims + d] * v[d];
    if (s > best) best = s;
  }
  return best;
};

const SELF_MENTOR_RE =
  /\b(?:(?:i['’]?m|i am|i['’]?ll be)\s+(?:a|an|one of the|your|the)\s+(?:[\w-]+\s+){0,3}|(?:joining|here|attending)\s+(?:[\w.]+\s+){0,3}as\s+(?:a\s+|an\s+)?(?:[\w-]+\s+){0,2})(mentor|judge|recruiter)s?\b/i;
const LINKEDIN_RE = /linkedin\.com\/(in|pub)\//i;

const eligible = messages.filter(
  (m) => !m.raw?.subtype && m.text && m.text.trim().length >= 12 && m.channel_type !== "im" && !/^DM with /.test(m.channel)
);
const rows = eligible.map((m) => {
  const i = pos.get(m.id);
  const scores = {};
  for (const key of SIM_CLASSES) scores[key] = i === undefined ? null : round(sim(i, protos[key]));
  return { m, scores, predicted: categories[m.id] || [] };
});
console.log(`${eligible.length} eligible of ${messages.length} messages; ${Object.keys(categories).length} categorized.`);

const random = rng(SEED);
const picked = new Map(); // id -> stratum
const pickedText = new Set(); // dedupe identical texts too (sponsors paste the same reply to many threads)
const normText = (t) => t.trim().toLowerCase().replace(/s+/g, " ");
const take = (list, n, stratum) => {
  let k = 0;
  for (const r of list) {
    if (k >= n) break;
    if (picked.has(r.m.id) || pickedText.has(normText(r.m.text))) continue;
    picked.set(r.m.id, stratum);
    pickedText.add(normText(r.m.text));
    k++;
  }
  return k;
};
const strataCounts = {};

for (const key of CLASSES) {
  const positives = rows.filter((r) => r.predicted.includes(key));
  let n = 0;
  if (SIM_CLASSES.includes(key)) {
    // Borderline half: closest to THRESHOLD (either side — many rules use T±δ).
    const byMargin = [...positives].sort((a, b) => Math.abs(a.scores[key] - THRESHOLD) - Math.abs(b.scores[key] - THRESHOLD));
    n += take(byMargin, Math.ceil(PER_POS / 2), `pos:${key}`);
  }
  n += take(shuffle(positives, random), PER_POS - n, `pos:${key}`);
  strataCounts[`pos:${key}`] = n;
}
for (const key of SIM_CLASSES) {
  const near = rows
    .filter((r) => !r.predicted.includes(key) && r.scores[key] !== null && r.scores[key] < THRESHOLD && r.scores[key] >= THRESHOLD - 0.08 && r.m.text.length > 60)
    .sort((a, b) => b.scores[key] - a.scores[key]);
  // Random among the band so we don't only get one channel's near-misses.
  strataCounts[`near:${key}`] = take(shuffle(near.slice(0, 60), random), PER_NEAR, `near:${key}`);
}
const kw = rows.filter((r) => !r.predicted.length && KEYWORD_RE.test(r.m.text));
strataCounts.kw = take(shuffle(kw, random), N_KW, "kw");
strataCounts.random = take(shuffle(rows, random), Math.max(0, SIZE - picked.size), "random");

// Stratified 60/40 dev/test split.
const byStratum = {};
for (const [id, s] of picked) (byStratum[s] ||= []).push(id);
const split = new Map();
for (const ids of Object.values(byStratum)) {
  const sh = shuffle(ids, random);
  const nDev = Math.round(sh.length * 0.6);
  sh.forEach((id, j) => split.set(id, j < nDev ? "dev" : "test"));
}

const rowById = new Map(rows.map((r) => [r.m.id, r]));
const roleInfo = (uid) => {
  const p = people[uid] || {};
  const roles = p.roles || [];
  return {
    is_mentor: !!p.is_mentor,
    judge: roles.includes("judge"),
    sponsor: !!p.is_sponsor,
    organizer: !!p.is_organizer,
    org: p.org || "",
    title: p.title || "",
    roles,
  };
};

// Shuffled order so the file doesn't reveal strata while labeling.
const items = shuffle([...picked.keys()], random).map((id) => {
  const { m, scores, predicted } = rowById.get(id);
  const ruleHits = {
    linkedin: LINKEDIN_RE.test(m.text),
    mentor_intro: SELF_MENTOR_RE.test(m.text),
  };
  const confidence = {};
  for (const key of CLASSES) confidence[key] = confidenceOf(key, { predicted: predicted.includes(key), score: scores[key], ruleHit: ruleHits[key] });
  return {
    id,
    split: split.get(id),
    channel: m.channel,
    date: m.date,
    author: m.user_name,
    author_id: m.user_id,
    author_roles: roleInfo(m.user_id),
    in_thread: !!m.thread_ts && m.thread_ts !== m.ts,
    is_thread_parent: !!m.thread_ts && m.thread_ts === m.ts,
    text: m.text,
    prediction: {
      collections: predicted,
      mention: outreachMention(m.text, predicted),
      scores,
      threshold: THRESHOLD,
      confidence,
      rule_hits: ruleHits,
      stratum: picked.get(id),
    },
  };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      meta: {
        created: new Date().toISOString(),
        seed: SEED,
        size: items.length,
        threshold: THRESHOLD,
        categories_mtime: fs.statSync(path.join(ROOT, "data", "categories.json")).mtime.toISOString(),
        strata: strataCounts,
        splits: { dev: items.filter((x) => x.split === "dev").length, test: items.filter((x) => x.split === "test").length },
      },
      items,
    },
    null,
    2
  )
);
console.log(`Wrote ${items.length} items to ${path.relative(ROOT, OUT)}`, strataCounts);

function round(x) {
  return Math.round(x * 10000) / 10000;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}
