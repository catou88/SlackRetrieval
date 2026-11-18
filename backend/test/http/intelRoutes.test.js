// /api/intel/* routes against an in-memory database and a fake RAG (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord } from "../../src/data/intelStore.js";
import { createRequestHandler } from "../../src/http/router.js";
import { createResponseCache } from "../../src/http/middleware/responseCache.js";
import { createIntelRoutes } from "../../src/http/routes/intelRoutes.js";

function seedDb() {
  const db = new Database(":memory:");
  createIntelTables(db);
  upsertRecord(db, { kind: "project", source: "t", sourceUrl: "https://devpost.com/software/robo",
    data: { title: "Robo Chef", hackathonUrl: "https://h/1", hackathonName: "Bay Hack", builtWith: ["python"],
      prizes: [{ name: "Grand Prize", sponsor: "Acme", isWinner: true }] } });
  upsertRecord(db, { kind: "job", source: "slack", sourceUrl: "slack://C1/1", data: { title: "ML Intern", company: "Acme", source: "slack", channel: "jobs" } });
  return db;
}

async function withServer(rag, fn) {
  const db = seedDb();
  const handler = createRequestHandler({
    db, routes: createIntelRoutes({ getRag: () => rag }),
    responseCache: createResponseCache({ currentDataVersion: () => "v" }), onDataWrite: () => {},
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test("browse endpoints return stored rows and filters apply", async () => {
  await withServer({}, async (base) => {
    const projects = await (await fetch(`${base}/api/intel/projects`)).json();
    assert.equal(projects.length, 1);
    assert.equal((await (await fetch(`${base}/api/intel/projects?stack=rust`)).json()).length, 0);
    const detail = await (await fetch(`${base}/api/intel/project?id=${projects[0].id}`)).json();
    assert.equal(detail.title, "Robo Chef");
    assert.equal((await fetch(`${base}/api/intel/project?id=999`)).status, 404);
    assert.equal((await fetch(`${base}/api/intel/project?id=abc`)).status, 400);
    assert.equal((await (await fetch(`${base}/api/intel/jobs?source=slack`)).json()).length, 1);
    assert.equal((await fetch(`${base}/api/intel/jobs?source=email`)).status, 400);
    assert.ok(Array.isArray(await (await fetch(`${base}/api/intel/hackathons`)).json()));
    assert.ok(Array.isArray(await (await fetch(`${base}/api/intel/sponsors`)).json()));
    assert.ok(Array.isArray(await (await fetch(`${base}/api/intel/people`)).json()));
  });
});

test("ask validates input, returns the answer, and maps model failure to 503", async () => {
  const ok = { ask: async (q) => ({ answer: `echo ${q}`, unknown: false, citations: [] }) };
  await withServer(ok, async (base) => {
    const post = (body) => fetch(`${base}/api/intel/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ question: "x".repeat(1001) })).status, 400);
    assert.equal((await (await post({ question: " hi " })).json()).answer, "echo hi");
  });
  await withServer({ ask: async () => { throw new Error("ECONNREFUSED secret"); } }, async (base) => {
    const res = await fetch(`${base}/api/intel/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q" }) });
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes("secret"));
  });
});
