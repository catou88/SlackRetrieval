// HTTP client for the local archive server: a session GET cache, abortable request slots and
// typed errors. Server errors arrive as HTTP status + JSON {error: code, message}; pages branch on
// ApiError.code ("not_found", "claude_disabled", …) instead of matching message text.

const SERVER_DOWN_MESSAGE = "The archive server isn't running.";
const responseCache = new Map();

/** The server answered with an error status. `code` is the machine-readable error code. */
export class ApiError extends Error {
  constructor({ status, code, message }) {
    super(message || code || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code || codeForStatus(status);
  }
}

/** The request never reached the server (it is not running, or the network failed). */
export class NetError extends Error {
  constructor(message = SERVER_DOWN_MESSAGE) {
    super(message);
    this.name = "NetError";
  }
}

/**
 * GET JSON with a per-session cache. Successful responses only are cached, so a failure is
 * retried on the next call.
 * @param {string} url
 * @param {{signal?: AbortSignal, fresh?: boolean}} [options]  fresh skips (but refreshes) the cache
 * @throws {ApiError|NetError|DOMException} AbortError passes through untouched
 */
export async function getJson(url, { signal, fresh = false } = {}) {
  if (!fresh && responseCache.has(url)) return responseCache.get(url);
  const data = await request(url, { signal });
  responseCache.set(url, data);
  return data;
}

/** POST a JSON body and return the JSON reply. @throws {ApiError|NetError} */
export function postJson(url, body) {
  return request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Drop cached GETs whose URL starts with `prefix`. */
export function invalidateCache(prefix) {
  for (const key of responseCache.keys()) if (key.startsWith(prefix)) responseCache.delete(key);
}

/**
 * A request slot: starting a new request aborts the previous one, so only the latest
 * search-as-you-type answer can land.
 * @returns {(url: string, options?: object) => Promise<any>}
 */
export function createRequestSlot() {
  let controller;
  return (url, options) => {
    controller?.abort();
    controller = new AbortController();
    return getJson(url, { ...options, signal: controller.signal });
  };
}

/** True when the error is an aborted fetch that callers should ignore. */
export function isAbortError(error) {
  return error?.name === "AbortError";
}

// ---------- private helpers ----------

async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new NetError();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError({ status: response.status, code: data?.error, message: data?.message });
  return data;
}

// Older servers sent only a status; keep the codes pages rely on meaningful anyway.
function codeForStatus(status) {
  if (status === 404) return "not_found";
  if (status === 400) return "invalid_request";
  return "internal_error";
}
