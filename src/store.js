// Tiny JSON file store under ./data — everything the pipeline keeps lives here.
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");

export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

export function readJSON(name, fallback) {
  const p = dataPath(name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJSON(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = dataPath(name);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

export function readLines(name) {
  const p = dataPath(name);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
