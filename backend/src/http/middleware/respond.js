// Owns writing JSON responses: content type, ETag revalidation for GETs
// (304 when the browser already has this body) and cache-control headers.
import crypto from "node:crypto";
import { isCacheEnabled } from "../../lib/cache.js";

const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string | Buffer} body  already-serialized JSON
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendJson(req, res, status, body, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  const isRevalidatable = req.method === "GET" && status === HTTP_OK && isCacheEnabled();
  if (!isRevalidatable) {
    headers["cache-control"] = "no-store";
    res.writeHead(status, headers).end(body);
    return;
  }
  headers.etag ??= etagOf(body);
  headers["cache-control"] = "no-cache"; // always revalidate; the ETag makes that cheap
  if (req.headers["if-none-match"] === headers.etag) {
    res.writeHead(HTTP_NOT_MODIFIED, headers).end();
    return;
  }
  res.writeHead(status, headers).end(body);
}

/** @returns {string} a strong ETag for a response body */
export function etagOf(body) {
  return `"${crypto.createHash("sha1").update(body).digest("base64url")}"`;
}
