// Tests for the HTTP pipeline (router + middleware) with fake routes: query
// validation runs before the cache, GETs are cached per data version, POSTs
// invalidate, and errors are mapped to stable public codes. No database or
// data/ files are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequestHandler } from "../../src/http/router.js";
import { createResponseCache } from "../../src/http/middleware/responseCache.js";
import { requireTextParam } from "../../src/http/middleware/queryValidation.js";
import { NotFoundError } from "../../src/lib/errors.js";

test("GET validates before the handler, caches per data version, and POST invalidates", async () => {
  const counter = { handlerCalls: 0 };
  await withServer(fakeRoutes(counter), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/echo`)).status, 400);
    assert.equal(counter.handlerCalls, 0);

    const first = await fetch(`${baseUrl}/api/echo?q=hi`);
    assert.equal(first.headers.get("x-cache"), "MISS");
    assert.deepEqual(await first.json(), { echo: "hi", call: 1 });
    const second = await fetch(`${baseUrl}/api/echo?q=hi`);
    assert.equal(second.headers.get("x-cache"), "HIT");
    assert.equal(counter.handlerCalls, 1);

    const notModified = await fetch(`${baseUrl}/api/echo?q=hi`, { headers: { "if-none-match": second.headers.get("etag") } });
    assert.equal(notModified.status, 304);

    assert.equal((await post(`${baseUrl}/api/write`, {})).status, 200);
    const afterWrite = await fetch(`${baseUrl}/api/echo?q=hi`);
    assert.equal(afterWrite.headers.get("x-cache"), "MISS");
    assert.equal(counter.handlerCalls, 2);
  });
});

test("errors become stable public codes without internal details", async () => {
  await withServer(fakeRoutes({ handlerCalls: 0 }), async (baseUrl) => {
    const notFound = await fetch(`${baseUrl}/api/missing`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: "not_found", message: "thing not found" });

    const crash = await fetch(`${baseUrl}/api/crash`);
    assert.equal(crash.status, 500);
    assert.deepEqual(await crash.json(), { error: "internal_error" });

    assert.equal((await post(`${baseUrl}/api/write`, [1])).status, 400);
    const badJson = await fetch(`${baseUrl}/api/write`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.deepEqual(await badJson.json(), { error: "invalid_request", message: "invalid JSON body" });

    // Cross-site protections: a non-JSON POST (no CORS preflight) and a foreign Origin/Host are refused.
    assert.equal((await fetch(`${baseUrl}/api/write`, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await post(`${baseUrl}/api/write`, {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await rawGet(baseUrl, "/api/missing", { host: "evil.example" })).status, 403);

    const wrongMethod = await fetch(`${baseUrl}/api/write`);
    assert.equal(wrongMethod.status, 405);
    assert.equal((await fetch(`${baseUrl}/api/nothing-here`)).status, 404);
  });
});

// ---------------------------------------------------------------- private helpers
function fakeRoutes(counter) {
  return [
    {
      method: "GET",
      path: "/api/echo",
      validateQuery: (query) => requireTextParam(query, "q"),
      handle: ({ query }) => ({ echo: query.get("q"), call: ++counter.handlerCalls }),
    },
    { method: "GET", path: "/api/missing", handle: () => { throw new NotFoundError("thing"); } },
    { method: "GET", path: "/api/crash", handle: () => { throw new Error("secret stack detail"); } },
    { method: "POST", path: "/api/write", handle: () => ({ ok: true }) },
  ];
}

async function withServer(routes, runChecks) {
  let writeGeneration = 0;
  const responseCache = createResponseCache({ currentDataVersion: () => String(writeGeneration) });
  const handleRequest = createRequestHandler({ db: null, routes, responseCache, onDataWrite: () => writeGeneration++ });
  const server = http.createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalConsoleError = console.error;
  console.error = () => {}; // the 500 test logs its cause on purpose
  try {
    await runChecks(`http://127.0.0.1:${server.address().port}`);
  } finally {
    console.error = originalConsoleError;
    server.close();
  }
}

function post(url, body, extraHeaders = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
}

// fetch() forbids overriding Host, so send this one request with node:http.
function rawGet(baseUrl, path, headers) {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, baseUrl), { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    }).on("error", reject);
  });
}
