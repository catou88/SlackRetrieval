// Owns the request pipeline for API routes:
//   GET:  validate query → response cache (by data version) → handler → JSON + ETag
//   POST: read JSON body → invalidate cached GETs → handler → invalidate again
// Every request first passes the local-origin guard; unknown /api/ paths get a
// JSON 404 (or 405); anything else falls through to static files.
import { HttpError, sendErrorResponse } from "./middleware/errorHandler.js";
import { rejectForeignRequests } from "./middleware/requestGuard.js";
import { readJsonBody } from "./middleware/jsonBody.js";
import { sendJson } from "./middleware/respond.js";
import { serveStaticFile } from "./middleware/staticFiles.js";

const API_PREFIX = "/api/";

/**
 * @typedef {object} RouteDefinition
 * @property {"GET" | "POST"} method
 * @property {string} path  exact pathname, e.g. "/api/people"
 * @property {(ctx: { db, query: URLSearchParams, body?: object }) => unknown} handle  returns the JSON payload
 * @property {(query: URLSearchParams) => void} [validateQuery]  throws InvalidInputError
 * @property {boolean} [isCacheable]  GET only; default true
 * @property {boolean} [invalidatesResponses]  POST only; default true (it may change what GETs return)
 */

/**
 * Build the Node request listener.
 * @param {{ db: import("better-sqlite3").Database, routes: RouteDefinition[],
 *   responseCache: ReturnType<import("./middleware/responseCache.js").createResponseCache>,
 *   onDataWrite: () => void }} deps  onDataWrite bumps the data version around POSTs
 * @returns {(req, res) => Promise<void>}
 */
export function createRequestHandler({ db, routes, responseCache, onDataWrite }) {
  const routesByKey = new Map(routes.map((route) => [routeKey(route.method, route.path), route]));
  const methodsByPath = groupMethodsByPath(routes);

  return async function handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    const route = routesByKey.get(routeKey(req.method, url.pathname));
    try {
      rejectForeignRequests(req);
      if (!route && url.pathname.startsWith(API_PREFIX)) throw unknownApiRouteError(methodsByPath, url.pathname);
      if (!route) return serveStaticFile(req, res, url);
      if (route.method === "POST") return await handlePost(req, res, route, url);
      return await handleGet(req, res, route, url);
    } catch (err) {
      sendErrorResponse(req, res, err);
    }
  };

  async function handleGet(req, res, route, url) {
    const startedAt = performance.now();
    route.validateQuery?.(url.searchParams);
    const compute = () => route.handle({ db, query: url.searchParams });
    const { body, etag, status } = await responseCache.getOrCompute(url, compute, { isCacheable: route.isCacheable ?? true });
    sendJson(req, res, 200, body, {
      etag,
      "x-cache": status,
      "server-timing": `app;dur=${(performance.now() - startedAt).toFixed(1)}`,
    });
  }

  // Invalidate before and after, so nothing computed around the write is served afterwards.
  async function handlePost(req, res, route, url) {
    const body = await readJsonBody(req);
    const invalidates = route.invalidatesResponses ?? true;
    if (invalidates) invalidateCachedResponses();
    try {
      const payload = await route.handle({ db, query: url.searchParams, body });
      sendJson(req, res, 200, JSON.stringify(payload));
    } finally {
      if (invalidates) invalidateCachedResponses();
    }
  }

  function invalidateCachedResponses() {
    onDataWrite();
    responseCache.invalidate();
  }
}

// ---------------------------------------------------------------- private helpers
function routeKey(method, path) {
  return `${method} ${path}`;
}

function groupMethodsByPath(routes) {
  const methodsByPath = new Map();
  for (const route of routes) methodsByPath.set(route.path, [...(methodsByPath.get(route.path) || []), route.method]);
  return methodsByPath;
}

function unknownApiRouteError(methodsByPath, pathname) {
  const allowedMethods = methodsByPath.get(pathname);
  if (allowedMethods) return new HttpError(405, "method_not_allowed", `use ${allowedMethods.join(" or ")}`);
  return new HttpError(404, "not_found", "no such API endpoint");
}
