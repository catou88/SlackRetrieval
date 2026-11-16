// Owns turning any thrown error into a stable public JSON error: domain error
// codes map to HTTP statuses, everything unexpected becomes a 500. Never sends
// provider messages, stacks or request ids; 5xx causes go to the server log.
import { DomainError } from "../../lib/errors.js";
import { sendJson } from "./respond.js";

const STATUS_BY_DOMAIN_CODE = {
  invalid_request: 400,
  not_found: 404,
  claude_disabled: 503,
  model_unavailable: 503,
  index_unavailable: 503,
  model_timeout: 504,
  model_request_rejected: 502,
  invalid_model_output: 502,
};
// Our own validation / not-found / setup messages are fixed text, safe to show.
const MAX_STATUS_WITH_SAFE_MESSAGE = 499;
const CODES_WITH_SAFE_MESSAGE = new Set(["index_unavailable"]);

/** An HTTP-level error with a stable public code. */
export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} [message] */
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Send `err` as a JSON error response.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} err
 */
export function sendErrorResponse(req, res, err) {
  const publicError = toHttpError(err);
  if (publicError.status >= 500) console.error(`[${req.method} ${pathOf(req)}] ${publicError.code}:`, err?.cause || err);
  if (res.headersSent) {
    res.destroy(); // a streamed response failed midway; the status is already sent
    return;
  }
  const body = { error: publicError.code };
  if (publicError.status <= MAX_STATUS_WITH_SAFE_MESSAGE || CODES_WITH_SAFE_MESSAGE.has(publicError.code)) {
    body.message = publicError.message;
  }
  sendJson(req, res, publicError.status, JSON.stringify(body));
}

// ---------------------------------------------------------------- private helpers
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof DomainError && STATUS_BY_DOMAIN_CODE[err.code]) {
    return new HttpError(STATUS_BY_DOMAIN_CODE[err.code], err.code, err.message);
  }
  return new HttpError(500, "internal_error");
}

function pathOf(req) {
  return req.url.split("?")[0];
}
