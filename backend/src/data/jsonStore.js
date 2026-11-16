// Owns the JSON snapshot under DATA_DIR (messages, users, people, channels,
// categories, state) and the paths of everything else stored there: atomic
// writes, reads with useful errors, file-stat version stamps, and the local
// names of downloaded files and avatars.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { hashKey } from "../lib/cache.js";

export const DATA_DIR = CONFIG.dataDir;

/** Every snapshot file, by role (one place for the names). */
export const FILES = Object.freeze({
  messages: "messages.json",
  users: "users.json",
  people: "people.json",
  channels: "channels.json",
  state: "state.json",
  categories: "categories.json", // { messageId: [collection, …] }
  categoryDetails: "category-details.json", // { messageId: { collection: { confidence, score, source } } }
  indexVectors: "index.bin",
  indexMeta: "index.meta.json",
  database: "slack.db",
  mentorList: "mentors.txt",
});

const MAX_FILE_NAME_CHARS = 150;

/** @returns {string} absolute path of `name` under DATA_DIR */
export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

/**
 * @template T
 * @param {string} name  file under DATA_DIR
 * @param {T} fallback  returned when the file does not exist
 * @returns {T}
 * @throws {Error} when the file exists but is not valid JSON (names the file)
 */
export function readJSON(name, fallback) {
  const file = dataPath(name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); re-run the step that writes it.`, { cause: err });
  }
}

/** Write JSON atomically (tmp + rename), so readers never see half a file. */
export function writeJSON(name, value) {
  writeFileAtomic(dataPath(name), JSON.stringify(value, null, 2));
}

/**
 * Atomic file write: tmp file + rename (the rename replaces the old file in one step).
 * @param {string} file  absolute path
 * @param {string | Buffer} contents
 */
export function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/** @returns {string[]} trimmed non-empty, non-# lines of a text file (empty if missing) */
export function readLines(name) {
  const file = dataPath(name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * Version stamp of files under DATA_DIR: changes when any of them is
 * replaced, resized or touched (a missing file is part of the stamp).
 * @param {string[]} names
 * @returns {string}
 */
export function fileVersion(names) {
  return hashKey(names.map(statEntry));
}

/** @returns {string} the name a Slack file is saved under in data/files/ */
export function localFileName(file) {
  return `${file.id}_${file.name.replace(/[^\w.\-]+/g, "_")}`.slice(0, MAX_FILE_NAME_CHARS);
}

/** @returns {string} path relative to DATA_DIR ("files/F1_x.png"), forward slashes */
export function relativeFilePath(file) {
  return `files/${localFileName(file)}`;
}

/** @returns {string} relative path of a person's saved profile photo */
export function avatarPath(personId) {
  return `avatars/${personId}.jpg`;
}

/** @returns {boolean} whether `name` exists under DATA_DIR */
export function hasDataFile(name) {
  return fs.existsSync(dataPath(name));
}

// ---------------------------------------------------------------- private helpers
function statEntry(name) {
  try {
    const stat = fs.statSync(dataPath(name));
    return [name, stat.mtimeMs, stat.size];
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return [name, null]; // a missing file is part of the stamp, not an error
  }
}
