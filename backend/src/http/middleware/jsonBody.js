// Owns reading a POST body: it must be declared as JSON (which makes browsers
// send a CORS preflight that this server never approves, so other sites cannot
// POST here), size-limited, parsed, and a plain object.
import { InvalidInputError } from "../../lib/errors.js";
import { HttpError } from "./errorHandler.js";

const MAX_BODY_BYTES = 1024 * 1024;
const JSON_CONTENT_TYPE = "application/json";

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>} {} for an empty body
 * @throws {HttpError} 415 wrong content type, 413 too large
 * @throws {InvalidInputError} malformed JSON or not a JSON object
 */
export async function readJsonBody(req) {
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== JSON_CONTENT_TYPE) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json");
  const text = await readBodyText(req);
  const body = parseJson(text || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidInputError("body must be a JSON object");
  return body;
}

// ---------------------------------------------------------------- private helpers
async function readBodyText(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidInputError("invalid JSON body");
  }
}
