// Owns serving files from disk: the frontend (always revalidated, so edits
// show up at once) and downloaded Slack attachments / avatars from data/
// (reused for CACHE_TTL_STATIC, then revalidated). Refuses path traversal.
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";
import { isCacheEnabled } from "../../lib/cache.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
};
const DATA_FILE_FOLDERS = ["files", "avatars"];
const MAX_BROWSER_CACHE_MS = 365 * 86400e3;
const FRONTEND_CACHE_CONTROL = "no-cache";

/**
 * Serve the static file `url` names, or a 404/403.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 */
export function serveStaticFile(req, res, url) {
  const dataFolder = DATA_FILE_FOLDERS.find((folder) => url.pathname.startsWith(`/${folder}/`));
  if (dataFolder) {
    const root = path.resolve(CONFIG.dataDir, dataFolder);
    const file = resolveInside(root, url.pathname.slice(dataFolder.length + 1));
    return file ? sendFile(req, res, file, dataFileCacheControl()) : res.writeHead(403).end();
  }
  const root = CONFIG.frontendDir;
  const file = url.pathname === "/" ? path.join(root, "index.html") : resolveInside(root, url.pathname);
  return file ? sendFile(req, res, file, FRONTEND_CACHE_CONTROL) : res.writeHead(403).end();
}

// ---------------------------------------------------------------- private helpers
// Resolve a URL path inside `root`, refusing anything that escapes it.
function resolveInside(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  const resolved = path.resolve(root, "." + decoded);
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

function dataFileCacheControl() {
  const ttlMs = CONFIG.cache.ttl.staticMs;
  if (!(ttlMs > 0)) return "no-cache";
  return `private, max-age=${Math.floor(Math.min(ttlMs, MAX_BROWSER_CACHE_MS) / 1000)}`;
}

function sendFile(req, res, file, cacheControl) {
  const stats = statFile(file);
  if (!stats) return res.writeHead(404).end("not found");
  const headers = { "content-type": MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" };
  if (isCacheEnabled()) {
    headers.etag = `W/"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}"`;
    headers["last-modified"] = stats.mtime.toUTCString();
    headers["cache-control"] = cacheControl;
    if (req.headers["if-none-match"] === headers.etag) return res.writeHead(304, headers).end();
  } else {
    headers["cache-control"] = "no-store";
  }
  headers["content-length"] = stats.size;
  res.writeHead(200, headers);
  // The file can vanish or be locked between stat and open; end the response instead of crashing.
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function statFile(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}
