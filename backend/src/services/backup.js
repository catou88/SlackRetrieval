// Owns zipping the whole data folder (messages, files, avatars, database,
// notes) into one timestamped archive you can keep after workspace access ends.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CONFIG } from "../config.js";
import { openDb } from "../data/db.js";

/**
 * @param {{ destinationDir?: string, log?: (line: string) => void }} [opts]
 * @returns {string} the path of the zip that was written
 */
export function backupDataFolder({ destinationDir = ".", log = console.log } = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const zipPath = path.resolve(destinationDir, `slack-backup-${stamp}.zip`);
  flushDatabaseLog();
  const dataDir = CONFIG.dataDir;
  execFileSync(tarExecutable(), ["-a", "-c", "-f", zipPath, "-C", path.dirname(dataDir), path.basename(dataDir)], { stdio: "inherit" });
  log(`Backed up ${dataDir} → ${zipPath} (${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB)`);
  return zipPath;
}

// ---------------------------------------------------------------- private helpers
// Flush the write-ahead log into slack.db so the copy is complete.
function flushDatabaseLog() {
  const db = openDb();
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

// Windows 10+ ships bsdtar, which can write zip files.
function tarExecutable() {
  return process.platform === "win32" ? path.join(CONFIG.systemRoot, "System32", "tar.exe") : "tar";
}
