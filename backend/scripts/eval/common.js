// Shared helpers for the classifier evaluation scripts. No message text here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// backend/scripts/eval -> repo root (where data/ lives) is three levels up.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || "data");
export const EVAL_DIR = path.join(ROOT, "data", "eval");

/** Reads data/<name> (JSON) or returns fallback. Independent of the app's store module. */
export function readData(name, fallback) {
  const file = path.join(DATA_DIR, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

/**
 * Finds an app module under backend/src/ by file name (e.g. "categorize.js"), so
 * these scripts survive the src/ layout being reorganized. Prefers the shallowest match.
 */
export function findSrc(basename) {
  const hits = [];
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && e.name !== "node_modules") walk(p, depth + 1);
      else if (e.isFile() && e.name === basename) hits.push({ p, depth });
    }
  };
  walk(path.join(ROOT, "backend", "src"), 0);
  if (!hits.length) throw new Error(`backend/src/**/${basename} not found`);
  hits.sort((a, b) => a.depth - b.depth);
  return pathToFileURL(hits[0].p).href;
}
export const CLASSES = ["linkedin", "mentor_intro", "offer", "sponsor_opportunity", "teammate"];
export const SIM_CLASSES = ["mentor_intro", "offer", "sponsor_opportunity", "teammate"]; // have example sentences
export const THRESHOLD = Number(process.env.CATEGORY_THRESHOLD) || 0.45; // same default as backend/src/config.js

// Hard-negative keywords (sampling only).
export const KEYWORD_RE = /linkedin|\bresumes?\b|\bdm me\b|\bmentor|\bhiring\b|\bintern(s|ship|ships)?\b|\bteam|\bconnect|\breferr?al/i;

// Copy of OUTREACH_KEYWORD_RE in backend/src/lib/patterns.js (kept separate so the eval never imports app code). Keep in sync.
const OUTREACH_COLLECTIONS = new Set(["linkedin", "mentor_intro", "offer", "sponsor_opportunity"]);
const OUTREACH_RE =
  /linkedin\.com\/in\/|\bconnect(ing|ed)?\b|\bresumes?\b|\bdm me\b|reach out|coffee chats?|\breferr(al|als|ing)?\b|office hours|\bmentor(s|ing|ship)?\b|\bhiring\b|\bintern(s|ship|ships)?\b/i;
/** True when the server would add the "mention" tag (keyword hit, not already an outreach collection). */
export function outreachMention(text, collections) {
  if (collections.some((c) => OUTREACH_COLLECTIONS.has(c))) return false;
  return text.trim().length >= 12 && OUTREACH_RE.test(text);
}
export { OUTREACH_COLLECTIONS };

/** mulberry32 — small seeded PRNG returning floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Confidence of the classifier's decision for one class.
 * Rule hits (LinkedIn URL, "I'm a mentor") are "high". For similarity classes
 * the distance of the score from THRESHOLD decides: >=0.10 high, >=0.04 medium,
 * else low. linkedin without a rule hit is a confident negative ("high").
 */
export function confidenceOf(key, { predicted, score, ruleHit }) {
  if (key === "linkedin") return "high";
  if (predicted && ruleHit) return "high";
  if (score === null || score === undefined) return predicted ? "medium" : "high";
  const margin = Math.abs(score - THRESHOLD);
  return margin >= 0.1 ? "high" : margin >= 0.04 ? "medium" : "low";
}

export function readJSONFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function loadHeldout() {
  const file = path.join(EVAL_DIR, "heldout.json");
  if (!fs.existsSync(file)) throw new Error("data/eval/heldout.json missing — run `node backend/scripts/eval/sample.js` first.");
  return readJSONFile(file);
}
/** Prefer reviewed labels, else Claude's. Returns { file, data } or null. */
export function loadGold({ prefer } = {}) {
  const order = prefer ? [prefer] : ["labels.reviewed.json", "labels.claude.json"];
  for (const name of order) {
    const file = path.isAbsolute(name) ? name : path.join(EVAL_DIR, name);
    if (fs.existsSync(file)) return { file, data: readJSONFile(file) };
  }
  return null;
}
/** Normalizes a label list: drops "none", unknown classes, duplicates. */
export function goldSet(labels) {
  return new Set((labels || []).filter((l) => CLASSES.includes(l)));
}
