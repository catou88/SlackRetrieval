// Owns refusing requests that did not come from this app's own pages. The
// server is bound to 127.0.0.1, but a web page in your browser can still reach
// it: a foreign Host header means DNS rebinding (a page reading the archive),
// and a foreign Origin means a cross-site request (a page writing notes or
// spending Claude credits). Both are rejected before any route runs.
import { HttpError } from "./errorHandler.js";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * @param {import("node:http").IncomingMessage} req
 * @throws {HttpError} 403 forbidden_origin
 */
export function rejectForeignRequests(req) {
  const hostname = hostnameOf(req.headers.host);
  if (!LOCAL_HOSTNAMES.has(hostname)) throw new HttpError(403, "forbidden_origin", "unexpected Host header");
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !isSameOrigin(origin, req.headers.host)) {
    throw new HttpError(403, "forbidden_origin", "cross-site request refused");
  }
}

// ---------------------------------------------------------------- private helpers
function hostnameOf(hostHeader = "") {
  const portSeparator = hostHeader.startsWith("[") ? hostHeader.indexOf("]") + 1 : hostHeader.lastIndexOf(":");
  return (portSeparator > 0 ? hostHeader.slice(0, portSeparator) : hostHeader).toLowerCase();
}

function isSameOrigin(origin, hostHeader) {
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}
