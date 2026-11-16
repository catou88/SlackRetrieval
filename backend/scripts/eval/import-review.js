#!/usr/bin/env node
// Copies a labels.reviewed.json exported from review.html into data/eval/.
//
//   node backend/scripts/eval/import-review.js ~/Downloads/labels.reviewed.json [--force]
//
// Validates it against data/eval/heldout.json before copying; refuses to
// overwrite an existing reviewed file that has more reviewed items unless --force.
import fs from "node:fs";
import path from "node:path";
import { EVAL_DIR, CLASSES, loadHeldout, readJSONFile } from "./common.js";

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("usage: node backend/scripts/eval/import-review.js <path to labels.reviewed.json> [--force]");
  process.exit(1);
}
const data = readJSONFile(path.resolve(src));
if (!data || typeof data.items !== "object") throw new Error("Not a labels file: missing `items`.");

const heldout = loadHeldout();
const ids = new Set(heldout.items.map((x) => x.id));
const valid = new Set([...CLASSES, "none"]);
let reviewed = 0, changed = 0, unknown = 0;
const problems = [];
for (const [id, x] of Object.entries(data.items)) {
  if (!ids.has(id)) { unknown++; continue; }
  if (!Array.isArray(x.labels) || !x.labels.length) problems.push(`${id}: no labels`);
  else if (x.labels.some((l) => !valid.has(l))) problems.push(`${id}: unknown label in ${x.labels.join(",")}`);
  else if (x.labels.includes("none") && x.labels.length > 1) problems.push(`${id}: "none" combined with a class`);
  if (x.reviewed) reviewed++;
  if (x.reviewed && x.changed) changed++;
}
const missing = [...ids].filter((id) => !data.items[id]).length;
if (problems.length) {
  console.error(`Refusing to import — ${problems.length} problem(s):\n  ${problems.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
if (data.meta?.heldout_seed !== undefined && data.meta.heldout_seed !== heldout.meta.seed)
  console.warn(`warning: file was made for heldout seed ${data.meta.heldout_seed}, current is ${heldout.meta.seed}`);

const dst = path.join(EVAL_DIR, "labels.reviewed.json");
if (fs.existsSync(dst) && !argv.includes("--force")) {
  const old = readJSONFile(dst);
  const oldReviewed = Object.values(old.items || {}).filter((x) => x.reviewed).length;
  if (oldReviewed > reviewed) {
    console.error(`${dst} already has ${oldReviewed} reviewed items (new file: ${reviewed}). Pass --force to overwrite.`);
    process.exit(1);
  }
  fs.copyFileSync(dst, dst.replace(/\.json$/, `.bak-${Date.now()}.json`));
}
fs.mkdirSync(EVAL_DIR, { recursive: true });
fs.copyFileSync(path.resolve(src), dst);
console.log(`Imported ${Object.keys(data.items).length} items → data/eval/labels.reviewed.json`);
console.log(`  reviewed: ${reviewed}, changed from Claude: ${changed}, missing: ${missing}, not in held-out: ${unknown}`);
console.log("Next: node backend/scripts/eval/evaluate.js > data/eval/report.reviewed.txt");
