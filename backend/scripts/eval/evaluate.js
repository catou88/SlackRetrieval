#!/usr/bin/env node
// Scores backend/src/services/categorize.js against gold labels on the held-out set.
//
//   node backend/scripts/eval/evaluate.js [--gold <file>] [--frozen] [--no-sweep] [--split dev|test] [--code <git-rev>]
//
// Gold: data/eval/labels.reviewed.json if present, else labels.claude.json
//       (or --gold <file>). The file used is printed at the top.
// Predictions: data/categories.json as it is now (re-run `npm run categorize`
//       after changing the classifier), or --frozen for the snapshot stored in
//       heldout.json at sampling time. Scores/confidence always come from the
//       snapshot, so the calibration table uses snapshot predictions.
// Threshold sweep: re-runs categorize() in a sandbox copy of data/
//       (data/eval/.sweep, never touches data/categories.json) for a range of
//       CATEGORY_THRESHOLD values and scores each on DEV only. Uses the working
//       tree's categorize.js; if that can't load (or with --code <rev>) it runs
//       a copy of categorize.js + its imports from git instead.
// Report goes to stdout; redirect it to save (see README).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT, EVAL_DIR, findSrc, CLASSES, OUTREACH_COLLECTIONS, loadHeldout, loadGold, goldSet, readJSONFile, THRESHOLD } from "./common.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const heldout = loadHeldout();
const gold = loadGold({ prefer: opt("gold") });
if (!gold) {
  console.error("No gold labels found (data/eval/labels.reviewed.json or labels.claude.json).");
  process.exit(1);
}
const goldItems = gold.data.items || {};
const items = heldout.items.filter((x) => goldItems[x.id]);
const splits = opt("split") ? [opt("split")] : ["dev", "test"];

const out = [];
const p = (...a) => out.push(a.join(" "));
p(`# Classifier evaluation — ${new Date().toISOString()}`);
p(`Gold labels: ${path.relative(ROOT, gold.file)} (labeler: ${gold.data.meta?.labeler ?? "?"}${gold.data.meta?.reviewed ? ", human-reviewed" : ""})`);
p(`Held-out: ${heldout.items.length} items (seed ${heldout.meta.seed}); ${items.length} have gold labels.`);
if (items.length < heldout.items.length) p(`WARNING: ${heldout.items.length - items.length} held-out items have no gold label and are skipped.`);
const unsure = items.filter((x) => goldItems[x.id].confidence === "unsure").length;
p(`Gold marked unsure: ${unsure}`);
if (gold.data.meta?.reviewed) {
  const rv = items.filter((x) => goldItems[x.id].reviewed);
  p(`Human-reviewed: ${rv.length} of ${items.length} (${rv.filter((x) => goldItems[x.id].changed).length} changed from Claude); unreviewed items keep Claude's labels.`);
}

// ---- predictions --------------------------------------------------------
let predOf;
if (flag("frozen")) {
  predOf = (x) => new Set(x.prediction.collections);
  p(`Predictions: frozen snapshot in heldout.json (threshold ${heldout.meta.threshold})`);
} else {
  const cats = readJSONFile(path.join(ROOT, "data", "categories.json"));
  predOf = (x) => new Set(cats[x.id] || []);
  const drift = items.filter((x) => !sameSet(predOf(x), new Set(x.prediction.collections))).length;
  p(`Predictions: data/categories.json (current). ${drift} of ${items.length} items differ from the sampling-time snapshot.`);
}
p("");

// ---- per-class metrics ---------------------------------------------------
function score(list, pred) {
  const res = {};
  for (const c of CLASSES) {
    let tp = 0, fp = 0, fn = 0;
    for (const x of list) {
      const g = goldSet(goldItems[x.id].labels).has(c);
      const pr = pred(x).has(c);
      if (g && pr) tp++;
      else if (pr) fp++;
      else if (g) fn++;
    }
    const prec = tp + fp ? tp / (tp + fp) : NaN;
    const rec = tp + fn ? tp / (tp + fn) : NaN;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : NaN;
    res[c] = { tp, fp, fn, support: tp + fn, predicted: tp + fp, prec, rec, f1: Number.isNaN(f1) && tp + fp + fn === 0 ? NaN : Number.isNaN(f1) ? 0 : f1 };
  }
  const tot = CLASSES.reduce((a, c) => ({ tp: a.tp + res[c].tp, fp: a.fp + res[c].fp, fn: a.fn + res[c].fn }), { tp: 0, fp: 0, fn: 0 });
  const microP = tot.tp / (tot.tp + tot.fp || 1), microR = tot.tp / (tot.tp + tot.fn || 1);
  res.micro = { ...tot, prec: microP, rec: microR, f1: microP + microR ? (2 * microP * microR) / (microP + microR) : 0, support: tot.tp + tot.fn };
  const f1s = CLASSES.map((c) => res[c].f1).filter((v) => !Number.isNaN(v));
  res.macroF1 = f1s.reduce((a, b) => a + b, 0) / (f1s.length || 1);
  return res;
}
const f = (v) => (Number.isNaN(v) ? "  -  " : v.toFixed(3));
function table(res) {
  p(`  ${"class".padEnd(20)} ${"P".padStart(6)} ${"R".padStart(6)} ${"F1".padStart(6)} ${"supp".padStart(5)} ${"pred".padStart(5)}  tp/fp/fn`);
  for (const c of [...CLASSES, "micro"]) {
    const r = res[c];
    p(`  ${c.padEnd(20)} ${f(r.prec).padStart(6)} ${f(r.rec).padStart(6)} ${f(r.f1).padStart(6)} ${String(r.support).padStart(5)} ${String(r.tp + r.fp).padStart(5)}  ${r.tp}/${r.fp}/${r.fn}`);
  }
  p(`  ${"macro F1".padEnd(20)} ${"".padStart(13)} ${f(res.macroF1).padStart(6)}`);
}

for (const s of splits) {
  const list = items.filter((x) => x.split === s);
  p(`## ${s.toUpperCase()} (${list.length} messages)`);
  table(score(list, predOf));
  const sure = list.filter((x) => goldItems[x.id].confidence !== "unsure");
  p(`  -- on gold-sure items only (${sure.length}): macro F1 ${f(score(sure, predOf).macroF1)}, micro F1 ${f(score(sure, predOf).micro.f1)}`);
  p("");
}

// ---- confusion examples --------------------------------------------------
const short = (t, n = 70) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
p(`## Errors by class (${splits.join(" + ")}; ids only — open data/eval/review.html to read the text)`);
for (const c of CLASSES) {
  const fps = [], fns = [];
  for (const x of items.filter((x) => splits.includes(x.split))) {
    const g = goldSet(goldItems[x.id].labels), pr = predOf(x);
    const sc = x.prediction.scores[c];
    const why = `[${x.split}] ${x.channel}${x.in_thread ? " reply" : ""}; ${roleStr(x)}${sc != null ? `; sim ${sc.toFixed(2)}` : ""}; gold=${[...g].join(",") || "none"}: ${short(goldItems[x.id].rationale || "")}`;
    if (pr.has(c) && !g.has(c)) fps.push(`    FP ${x.id}  ${why}`);
    if (!pr.has(c) && g.has(c)) fns.push(`    FN ${x.id}  ${why}; predicted=${[...pr].join(",") || "none"}`);
  }
  p(`  ${c}: ${fps.length} false positives, ${fns.length} false negatives`);
  for (const l of fps.slice(0, 12)) p(l);
  if (fps.length > 12) p(`    … ${fps.length - 12} more FP`);
  for (const l of fns.slice(0, 12)) p(l);
  if (fns.length > 12) p(`    … ${fns.length - 12} more FN`);
}
p("");

// ---- calibration (snapshot predictions + confidence) ---------------------
if (items[0]?.prediction?.confidence) {
  p("## Calibration by classifier confidence (snapshot predictions, all splits)");
  p("  confidence: rule hit = high; else |similarity - THRESHOLD| >= .10 high, >= .04 medium, < .04 low");
  p(`  ${"level".padEnd(8)} ${"pred+ n".padStart(8)} ${"precision".padStart(10)} ${"pred- n".padStart(8)} ${"neg. acc".padStart(9)}`);
  for (const level of ["high", "medium", "low"]) {
    let pn = 0, ptp = 0, nn = 0, ntn = 0;
    for (const x of items)
      for (const c of CLASSES) {
        if (x.prediction.confidence[c] !== level) continue;
        const g = goldSet(goldItems[x.id].labels).has(c);
        if (x.prediction.collections.includes(c)) { pn++; if (g) ptp++; }
        else { nn++; if (!g) ntn++; }
      }
    p(`  ${level.padEnd(8)} ${String(pn).padStart(8)} ${f(pn ? ptp / pn : NaN).padStart(10)} ${String(nn).padStart(8)} ${f(nn ? ntn / nn : NaN).padStart(9)}`);
  }
  p("  (counts are message×class decisions)");
  p("");
}

// ---- outreach "mention" keyword net (server GET /api/person) -------------
p("## Outreach highlights (person page): collections linkedin/mentor_intro/offer/sponsor_opportunity + keyword 'mention'");
{
  const isGoldOutreach = (x) => [...goldSet(goldItems[x.id].labels)].some((c) => OUTREACH_COLLECTIONS.has(c));
  const mention = items.filter((x) => x.prediction.mention);
  const mentionHit = mention.filter(isGoldOutreach).length;
  const goldOut = items.filter(isGoldOutreach);
  const highlighted = (x) => x.prediction.mention || [...predOf(x)].some((c) => OUTREACH_COLLECTIONS.has(c));
  const byColl = goldOut.filter((x) => [...predOf(x)].some((c) => OUTREACH_COLLECTIONS.has(c))).length;
  p(`  'mention'-only flags: ${mention.length}; of those gold-outreach: ${mentionHit} (precision ${f(mention.length ? mentionHit / mention.length : NaN)})`);
  p(`  gold-outreach messages: ${goldOut.length}; recall by collections alone ${f(byColl / (goldOut.length || 1))}; with mention net ${f(goldOut.filter(highlighted).length / (goldOut.length || 1))}`);
  p("  note: the sample over-represents keyword messages (kw stratum), so mention precision here is not the population rate.");
}
p("");

// ---- threshold sweep on dev ----------------------------------------------
if (!flag("no-sweep")) {
  p("## THRESHOLD sweep on DEV (categorize() re-run in data/eval/.sweep; test split untouched)");
  try {
    const sandbox = prepareSandbox();
    const dev = items.filter((x) => x.split === "dev");
    const thresholds = [0.35, 0.375, 0.4, 0.425, 0.45, 0.475, 0.5, 0.525, 0.55, 0.6];
    p(`  ${"T".padEnd(6)} ${CLASSES.map((c) => c.slice(0, 10).padStart(11)).join("")} ${"macroF1".padStart(8)} ${"microF1".padStart(8)}`);
    let best = null;
    for (const t of thresholds) {
      const cats = runCategorize(sandbox, t);
      const res = score(dev, (x) => new Set(cats[x.id] || []));
      if (!best || res.macroF1 > best.f1 + 1e-9) best = { t, f1: res.macroF1 };
      p(`  ${String(t).padEnd(6)} ${CLASSES.map((c) => f(res[c].f1).padStart(11)).join("")} ${f(res.macroF1).padStart(8)} ${f(res.micro.f1).padStart(8)}${t === THRESHOLD ? "  <- current" : ""}`);
    }
    p(`  best dev macro F1: T=${best.t} (${f(best.f1)}). Dev has few positives per class — treat differences < ~0.03 as noise; confirm on test once.`);
    const current = runCategorize(sandbox, THRESHOLD);
    const real = readJSONFile(path.join(ROOT, "data", "categories.json"));
    const mismatch = items.filter((x) => !sameSet(new Set(current[x.id] || []), new Set(real[x.id] || []))).length;
    p(`  sandbox re-run at T=${THRESHOLD} vs data/categories.json: ${mismatch} held-out items differ${mismatch ? " (categories.json is stale — re-run `npm run categorize`)" : ""}.`);
  } catch (e) {
    const why = (e.stderr?.toString() || "").match(/\w*Error( \[\w+\])?: [^\n]*/)?.[0] || e.message.split("\n")[0];
    p(`  sweep failed: ${why}`);
    p("  (the classifier could not run in the sandbox; re-run this script once backend/src/ imports resolve)");
  }
}

console.log(out.join("\n"));

// ---------------------------------------------------------------------------
function sameSet(a, b) {
  return a.size === b.size && [...a].every((v) => b.has(v));
}
function roleStr(x) {
  const r = x.author_roles;
  return [r.is_mentor && "mentor", r.judge && "judge", r.sponsor && "sponsor", r.organizer && "organizer"].filter(Boolean).join("/") || "no role";
}
function prepareSandbox() {
  const dir = path.join(EVAL_DIR, ".sweep");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["messages.json", "people.json", "index.bin", "index.meta.json"]) {
    const src = path.join(ROOT, "data", name), dst = path.join(dir, name);
    const fresh = fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs && fs.statSync(dst).size === fs.statSync(src).size;
    if (!fresh) {
      fs.rmSync(dst, { force: true });
      try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    }
  }
  const models = path.join(dir, "models");
  if (!fs.existsSync(models)) {
    try { fs.symlinkSync(path.join(ROOT, "data", "models"), models, "junction"); }
    catch { fs.cpSync(path.join(ROOT, "data", "models"), models, { recursive: true }); }
  }
  return dir;
}
// The working tree may be mid-refactor (imports not resolving). Then — or with
// --code <git-rev> — run the classifier from a git snapshot extracted into the
// sandbox (categorize.js plus its relative imports, recursively).
var codeUrl; // var: used by top-level code above this declaration
function classifierUrl(dir) {
  if (codeUrl) return codeUrl;
  const rev = opt("code");
  if (!rev) {
    try {
      const url = findSrc("categorize.js");
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
      return (codeUrl = url);
    } catch (e) {
      const why = ((e.stderr || "").toString().match(/\w*Error( \[\w+\])?: [^\n]*/) || ["?"])[0];
      p(`  working-tree classifier does not load (${why.slice(0, 160)})`);
    }
  }
  const useRev = rev || "HEAD";
  const codeDir = path.join(dir, "code", "src");
  fs.rmSync(path.join(dir, "code"), { recursive: true, force: true });
  fs.mkdirSync(codeDir, { recursive: true });
  const todo = ["src/categorize.js"], done = new Set();
  while (todo.length) {
    const rel = todo.pop();
    if (done.has(rel)) continue;
    done.add(rel);
    const src = execFileSync("git", ["show", `${useRev}:${rel}`], { cwd: ROOT }).toString();
    fs.mkdirSync(path.dirname(path.join(dir, "code", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "code", rel), src);
    for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) todo.push(path.posix.join(path.posix.dirname(rel), m[1]));
  }
  p(`  using classifier from git ${useRev} (${[...done].join(", ")}); its src/categorize.js ${matchesWorkingTree(useRev, "src/categorize.js") ? "matches" : "DIFFERS from"} the working tree's backend/src/services/categorize.js`);
  return (codeUrl = pathToFileURL(path.join(dir, "code", "src", "categorize.js")).href);
}
// The classifier moved (src/categorize.js -> backend/src/services/categorize.js),
// so compare file contents rather than `git diff` on one path.
function matchesWorkingTree(rev, rel) {
  try {
    const committed = execFileSync("git", ["show", `${rev}:${rel}`], { cwd: ROOT }).toString();
    return committed === fs.readFileSync(fileURLToPath(findSrc("categorize.js")), "utf8");
  } catch {
    return false;
  }
}
function runCategorize(dir, t) {
  const url = classifierUrl(dir);
  execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); await m.categorize({ log: () => {} });`], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dir, CATEGORY_THRESHOLD: String(t) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return readJSONFile(path.join(dir, "categories.json"));
}
