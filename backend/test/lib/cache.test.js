// Regression tests for the caching layer. Uses an in-memory SQLite database, a
// fake Claude client and a fake vector search, so it needs no data/ files, no
// network and no API key. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { hashKey, LRU, singleFlight, cacheStats } from "../../src/lib/cache.js";
import { parseDuration } from "../../src/config.js";
import { createUserTables } from "../../src/data/db.js";
import { llmStore } from "../../src/data/queries.js";
import { cachedLLM, useLlmStore } from "../../src/services/llmCache.js";
import { toDomainError, validateResponse } from "../../src/clients/claude.js";
import {
  DomainError, InvalidInputError, NotFoundError, ClaudeDisabledError, ModelUnavailableError, ModelTimeoutError, InvalidModelOutputError,
} from "../../src/lib/errors.js";
import { answerQuestion, writeReconnectBrief, writeAndSaveReconnectBrief } from "../../src/services/rag.js";

// ---------------------------------------------------------------- fixtures
const person = (id, name, extra = {}) => ({
  id, name, handle: name.toLowerCase().replace(/\s+/g, ""), title: "", pronouns: "", email: "",
  roles: [], linkedin: [], other_links: [], profile_fields: [], channels: ["general"], role_evidence: [],
  message_count: 1, dm_count: 0, last_seen: "2026-10-20T00:00:00Z", is_mentor: false, ...extra,
});
const messages = [
  { id: "m1", channel_id: "C1", channel: "general", user_id: "U1", user_name: "Jane Doe", text: "Happy to review resumes!", ts: "1", date: "2026-10-20T10:00:00Z" },
  { id: "m2", channel_id: "C1", channel: "general", user_id: "U2", user_name: "Me", text: "Thanks Jane", ts: "2", date: "2026-10-20T10:05:00Z" },
];
const data = {
  messages,
  messagesById: new Map(messages.map((m) => [m.id, m])),
  people: { U1: person("U1", "Jane Doe", { is_mentor: true }), U2: person("U2", "Me") },
  state: { me: "U2" },
};

function fakeSearch() {
  const fn = async (_q, { k = 12, filter } = {}) => {
    fn.calls++;
    return messages.filter((m) => !filter || filter(m.id)).slice(0, k).map((m) => ({ id: m.id, score: 0.9 }));
  };
  fn.calls = 0;
  return fn;
}

const ok = (text = "An answer.") => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} });

// behaviours: array of (params) => response | throws; the last one repeats.
function fakeClient(...behaviours) {
  const client = {
    calls: 0,
    params: [],
    beta: {
      messages: {
        create: async (params, opts) => {
          const b = behaviours[Math.min(client.calls, behaviours.length - 1)] || (() => ok());
          client.calls++;
          client.params.push(params);
          client.opts = opts;
          return b(params, opts);
        },
      },
    },
  };
  return client;
}

const freshDb = () => createUserTables(new Database(":memory:"));

function setup(...behaviours) {
  const client = fakeClient(...behaviours);
  const search = fakeSearch();
  const db = freshDb();
  const deps = { client, db, data, search, dataVersion: "v1", timeoutMs: 200 };
  return { client, search, db, deps };
}

const providerError = (status, message = "boom sk-ant-api03-SECRET request_id=req_0123") =>
  Object.assign(new Error(message), { status, name: "APIError" });

const rejectsWith = (p, cls, code) =>
  assert.rejects(p, (e) => {
    assert.ok(e instanceof DomainError && e instanceof cls, `expected ${cls.name}, got ${e}`);
    assert.equal(e.code, code);
    return true;
  });

// ---------------------------------------------------------------- keys
test("hashKey: separator-containing fields cannot collide", () => {
  assert.notEqual(hashKey(["a|b", "c"]), hashKey(["a", "b|c"]));
  assert.notEqual(hashKey(["a\nb", "c"]), hashKey(["a", "b\nc"]));
  assert.notEqual(hashKey(["a", "b"]), hashKey(["a,b"]));
  assert.notEqual(hashKey([1]), hashKey(["1"]));
  assert.notEqual(hashKey([null]), hashKey(["null"]));
  assert.equal(hashKey(["x", 1]), hashKey(["x", 1]));
});

test("ask: case and whitespace variants are distinct cache entries", async () => {
  const { client, deps } = setup();
  for (const q of ["resume", "Resume", " resume", "resume ", "re sume"]) await answerQuestion(q, { deps });
  assert.equal(client.calls, 5);
  // and each one is now a hit
  for (const q of ["resume", "Resume", " resume", "resume ", "re sume"]) assert.equal((await answerQuestion(q, { deps })).cached, true);
  assert.equal(client.calls, 5);
  assert.equal(client.params[1].messages[0].content[1].text, "Question: Resume"); // exact input, not normalized
});

test("ask: model, data version and every output-changing param are part of the key", async () => {
  const { client, deps } = setup();
  await answerQuestion("q", { deps });
  await answerQuestion("q", { deps: { ...deps, model: "claude-other-model" } });
  await answerQuestion("q", { deps: { ...deps, dataVersion: "v2" } });
  await answerQuestion("q", { deps, mentorsOnly: true });
  await answerQuestion("q", { deps, person: "Jane" });
  await answerQuestion("q", { deps, k: 5 });
  assert.equal(client.calls, 6);
  assert.equal(client.params[1].model, "claude-other-model");
});

test("ask: a cache hit does not call the model again", async () => {
  const { client, deps } = setup();
  const a = await answerQuestion("who reviews resumes?", { deps });
  const b = await answerQuestion("who reviews resumes?", { deps });
  assert.equal(client.calls, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.answer, a.answer);
});

test("ask: fresh: true bypasses the lookup and replaces the cached answer", async () => {
  const { client, deps } = setup(() => ok("old"), () => ok("new"));
  await answerQuestion("q", { deps });
  const f = await answerQuestion("q", { deps, fresh: true });
  assert.equal(f.answer, "new");
  assert.equal(f.cached, false);
  assert.equal((await answerQuestion("q", { deps })).answer, "new");
  assert.equal(client.calls, 2);
});

test("ask: prompt caching marks the system and context blocks ephemeral", async () => {
  const { client, deps } = setup();
  await answerQuestion("q", { deps });
  const p = client.params[0];
  assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(p.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(p.messages[0].content[1].cache_control, undefined);
  assert.ok(client.opts.signal, "request has an abort signal");
  assert.ok(client.opts.timeout > 0, "request has an SDK timeout");
});

// ---------------------------------------------------------------- failures
for (const [status, label] of [[500, "500"], [529, "overloaded"], [429, "rate limit"], [503, "503"]]) {
  test(`ask: provider ${label} maps to model_unavailable, is not cached, retry succeeds and is cached`, async () => {
    const { client, deps } = setup(() => { throw providerError(status); }, () => ok("recovered"));
    await rejectsWith(answerQuestion("q", { deps }), ModelUnavailableError, "model_unavailable");
    const r = await answerQuestion("q", { deps });
    assert.equal(r.answer, "recovered");
    assert.equal(r.cached, false);
    assert.equal((await answerQuestion("q", { deps })).cached, true);
    assert.equal(client.calls, 2);
  });
}

test("ask: public errors never carry provider text, keys or request ids", async () => {
  const { deps } = setup(() => { throw providerError(500); });
  await assert.rejects(answerQuestion("q", { deps }), (e) => {
    assert.doesNotMatch(e.message, /sk-ant|SECRET|req_0123|boom/);
    assert.doesNotMatch(JSON.stringify({ error: e.code, message: e.message }), /sk-ant|req_/);
    return true;
  });
  for (const s of [400, 401, 403, 404, 429, 500, 502, 529, undefined]) {
    const pub = toDomainError(providerError(s));
    assert.doesNotMatch(pub.message, /sk-ant|SECRET|req_0123|boom/);
  }
  assert.equal(toDomainError(providerError(401)).code, "claude_disabled");
  assert.equal(toDomainError(providerError(400)).code, "model_request_rejected");
});

test("ask: a timeout is model_timeout, not cached, and retryable", async () => {
  const hang = (_p, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
  const { client, deps } = setup(hang, () => ok("fast"));
  const t0 = Date.now();
  await rejectsWith(answerQuestion("q", { deps: { ...deps, timeoutMs: 50 } }), ModelTimeoutError, "model_timeout");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal((await answerQuestion("q", { deps })).answer, "fast");
  assert.equal(client.calls, 2);
});

test("ask: a client that ignores the abort signal still times out", async () => {
  const { deps } = setup(() => new Promise(() => {}));
  await rejectsWith(answerQuestion("q", { deps: { ...deps, timeoutMs: 30 } }), ModelTimeoutError, "model_timeout");
});

test("ask: invalid model output is invalid_model_output and is never cached", async () => {
  const bads = [
    () => ({ content: [], stop_reason: "end_turn" }),
    () => ({ content: [{ type: "text", text: "   " }], stop_reason: "end_turn" }),
    () => ({ content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" }),
    () => ({ content: "not an array", stop_reason: "end_turn" }),
    () => null,
    () => ({ content: [{ type: "text", text: 42 }], stop_reason: "end_turn" }),
  ];
  for (const b of bads) {
    const { client, deps } = setup(b, () => ok("good"));
    await rejectsWith(answerQuestion("q", { deps }), InvalidModelOutputError, "invalid_model_output");
    assert.equal((await answerQuestion("q", { deps })).answer, "good");
    assert.equal(client.calls, 2);
  }
});

test("ask: refusals and max_tokens-truncated answers are returned but not cached", async () => {
  for (const b of [
    () => ({ content: [], stop_reason: "refusal", stop_details: { explanation: "nope" } }),
    () => ({ content: [{ type: "text", text: "half an ans" }], stop_reason: "max_tokens" }),
  ]) {
    const { client, deps } = setup(b, () => ok("full"));
    const first = await answerQuestion("q", { deps });
    assert.equal(first.cached, false);
    assert.ok(first.answer.length > 0);
    assert.equal((await answerQuestion("q", { deps })).answer, "full");
    assert.equal(client.calls, 2);
  }
  assert.equal(validateResponse(ok("x")).ok, true);
});

test("ask: Claude disabled (no key, no client) is claude_disabled and never searches", async () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = "sk-ant-your-key-here";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const { search, db } = setup();
    await rejectsWith(answerQuestion("q", { deps: { db, data, search, dataVersion: "v1" } }), ClaudeDisabledError, "claude_disabled");
    assert.equal(search.calls, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get().n, 0);
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});

// ---------------------------------------------------------------- validation
test("invalid requests are rejected without touching search, cache or model", async () => {
  const { client, search, db, deps } = setup();
  const badAsks = [
    [undefined], [null], [""], ["   "], ["\n\t"], [42], [0], [true], [false], [["q"]], [{ q: 1 }], ["x".repeat(2001)],
    ["q", { person: 5 }], ["q", { person: ["Jane"] }], ["q", { person: {} }], ["q", { person: "x".repeat(2001) }],
    ["q", { mentorsOnly: "yes" }], ["q", { mentorsOnly: 1 }], ["q", { fresh: "true" }], ["q", { k: 0 }], ["q", { k: "5" }],
  ];
  for (const [q, opts = {}] of badAsks) await rejectsWith(answerQuestion(q, { ...opts, deps }), InvalidInputError, "invalid_request");
  const badBriefs = [
    [undefined], [""], ["  "], [7], [[]], [{}], [true], ["x".repeat(2001)],
    ["Jane", { goal: 3 }], ["Jane", { goal: ["a"] }], ["Jane", { goal: {} }], ["Jane", { goal: "g".repeat(2001) }],
    ["Jane", { fresh: 1 }],
  ];
  for (const [p, opts = {}] of badBriefs) {
    await rejectsWith(writeReconnectBrief(p, { ...opts, deps }), InvalidInputError, "invalid_request");
    await rejectsWith(writeAndSaveReconnectBrief(db, p, { ...opts, deps }), InvalidInputError, "invalid_request");
  }
  assert.equal(client.calls, 0);
  assert.equal(search.calls, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM briefs`).get().n, 0);
});

test("unknown person is not_found and never calls the model", async () => {
  const { client, deps } = setup();
  await rejectsWith(answerQuestion("q", { person: "Nobody Here", deps }), NotFoundError, "not_found");
  await rejectsWith(writeReconnectBrief("Nobody Here", { deps }), NotFoundError, "not_found");
  assert.equal(client.calls, 0);
});

// ---------------------------------------------------------------- concurrency
test("concurrent identical requests call the model once", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { client, deps } = setup(async () => (await gate, ok("shared")));
  const all = Promise.all(Array.from({ length: 5 }, () => answerQuestion("same", { deps })));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const res = await all;
  assert.equal(client.calls, 1);
  assert.ok(res.every((r) => r.answer === "shared"));
});

test("a rejected single-flight is not remembered: later requests retry", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { client, deps } = setup(async () => { await gate; throw providerError(500); }, () => ok("second try"));
  const all = Promise.allSettled(Array.from({ length: 3 }, () => answerQuestion("same", { deps })));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const res = await all;
  assert.ok(res.every((r) => r.status === "rejected" && r.reason.code === "model_unavailable"));
  assert.equal(client.calls, 1);
  assert.equal((await answerQuestion("same", { deps })).answer, "second try");
  assert.equal(client.calls, 2);
});

test("singleFlight helper shares one promise and clears on rejection", async () => {
  const m = new Map();
  let n = 0;
  const fail = () => (n++, Promise.reject(new Error("x")));
  const a = singleFlight(m, "k", fail);
  const b = singleFlight(m, "k", fail);
  assert.equal(a, b);
  await assert.rejects(a);
  assert.equal(m.size, 0);
  assert.equal(await singleFlight(m, "k", async () => (n++, 7)), 7);
  assert.equal(n, 2);
});

// ---------------------------------------------------------------- expiry / LRU
test("Claude response cache entries expire after the TTL", async () => {
  const db = freshDb();
  let t = 1_000_000;
  let calls = 0;
  const call = async () => (calls++, { answer: `a${calls}`, ok: true });
  const opts = { store: llmStore(db), key: "k", kind: "ask", model: "m", call, ttlMs: 1000, now: () => t };
  assert.equal((await cachedLLM(opts)).answer, "a1");
  t += 999;
  assert.equal((await cachedLLM(opts)).cached, true);
  t += 2;
  const r = await cachedLLM(opts);
  assert.equal(r.cached, false);
  assert.equal(r.answer, "a2");
  assert.equal(calls, 2);
});

test("LRU is bounded by entries and bytes; wrap() only stores accepted values", async () => {
  const l = new LRU("test-lru", { maxEntries: 2, maxBytes: 10, sizeOf: (v) => v.length });
  l.set("a", "1234");
  l.set("b", "1234");
  l.get("a"); // a is now most recent
  l.set("c", "12");
  assert.equal(l.get("b"), undefined); // evicted (entry bound)
  assert.equal(l.get("a"), "1234");
  l.set("d", "123456789"); // byte bound evicts the rest
  assert.ok(l.bytes <= 10);
  l.set("huge", "x".repeat(11)); // larger than the cap: not stored
  assert.equal(l.get("huge"), undefined);
  let n = 0;
  assert.equal(await l.wrap("w", async () => (n++, "")), "");
  assert.equal(await l.wrap("w", async () => (n++, "")), ""); // accepted by default
  assert.equal(n, 1);
  await l.wrap("r", async () => (n++, "bad"), () => false);
  await l.wrap("r", async () => (n++, "bad"), () => false);
  assert.equal(n, 3);
});

// ---------------------------------------------------------------- briefs table
test("briefAndSave: failures write nothing; success writes one row; cache hits reuse it", async () => {
  const { client, db, deps } = setup(
    () => { throw providerError(529); },
    () => ({ content: [], stop_reason: "refusal" }),
    () => ({ content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    () => ok("Brief for Jane")
  );
  const rows = () => db.prepare(`SELECT * FROM briefs`).all();
  await rejectsWith(writeAndSaveReconnectBrief(db, "Jane", { goal: "internships", deps }), ModelUnavailableError, "model_unavailable");
  assert.equal(rows().length, 0);
  const refused = await writeAndSaveReconnectBrief(db, "Jane", { goal: "internships", deps });
  assert.equal(refused.saved, false);
  assert.equal(rows().length, 0);
  await rejectsWith(writeAndSaveReconnectBrief(db, "Jane", { goal: "internships", deps }), InvalidModelOutputError, "invalid_model_output");
  assert.equal(rows().length, 0);
  const good = await writeAndSaveReconnectBrief(db, "Jane", { goal: "internships", deps });
  assert.equal(good.saved, true);
  assert.equal(rows().length, 1);
  const again = await writeAndSaveReconnectBrief(db, "Jane", { goal: "internships", deps });
  assert.equal(again.cached, true);
  assert.equal(again.saved, false);
  assert.equal(again.brief_id, good.brief_id);
  assert.equal(rows().length, 1);
  assert.equal(client.calls, 4);
  // A different goal is a different prompt.
  await writeAndSaveReconnectBrief(db, "Jane", { goal: "Internships", deps });
  assert.equal(client.calls, 5);
  assert.equal(rows().length, 2);
});

// ---------------------------------------------------------------- TTL (injectable clock, no sleeps)
test("parseDuration: units, inf, 0 and invalid values", () => {
  assert.equal(parseDuration("300", 1), 300e3);
  assert.equal(parseDuration("90s", 1), 90e3);
  assert.equal(parseDuration("5m", 1), 300e3);
  assert.equal(parseDuration("24h", 1), 86400e3);
  assert.equal(parseDuration("7d", 1), 7 * 86400e3);
  assert.equal(parseDuration("inf", 1), Infinity);
  assert.equal(parseDuration("0", 1), 0);
  assert.equal(parseDuration(undefined, 42), 42);
  assert.equal(parseDuration("soon", 42), 42);
});

test("LRU TTL: served before expiry, miss after, counted as expired", () => {
  let t = 0;
  const l = new LRU("ttl-basic", { maxEntries: 10, ttlMs: 1000, now: () => t });
  l.set("a", 1);
  t = 999;
  assert.equal(l.get("a"), 1);
  t = 1000;
  assert.equal(l.get("a"), undefined);
  assert.equal(l.stats.expired, 1);
  assert.equal(l.map.size, 0); // pruned lazily on read
  const s = cacheStats()["ttl-basic"];
  assert.equal(s.ttl_s, 1);
  assert.equal(s.expired, 1);
});

test("LRU TTL = 0 disables the cache (wrap always computes)", async () => {
  const l = new LRU("ttl-zero", { ttlMs: 0 });
  l.set("a", 1);
  assert.equal(l.get("a"), undefined);
  let n = 0;
  await l.wrap("k", async () => ++n);
  await l.wrap("k", async () => ++n);
  assert.equal(n, 2);
  assert.equal(l.map.size, 0);
});

test("LRU sweep prunes expired entries; eviction still bounded with TTL", () => {
  let t = 0;
  const l = new LRU("ttl-sweep", { maxEntries: 2, ttlMs: 100, now: () => t });
  l.set("a", 1);
  t = 50;
  l.set("b", 2);
  l.set("c", 3); // evicts a (LRU), not by TTL
  assert.equal(l.stats.evicted, 1);
  assert.equal(l.get("a"), undefined);
  t = 120; // b and c were set at t=50, so they expire at 150
  l.sweep();
  assert.equal(l.map.size, 2);
  t = 150;
  l.sweep();
  assert.equal(l.map.size, 0);
  assert.equal(l.stats.expired, 2);
});

test("persistent LLM cache: expired rows are not served and get pruned", async () => {
  const db = freshDb();
  const store = llmStore(db);
  let t = 10_000;
  let calls = 0;
  const call = async () => (calls++, { answer: `a${calls}`, ok: true });
  const base = { store, kind: "ask", model: "m", call, ttlMs: 1000, now: () => t };
  await cachedLLM({ ...base, key: "k1" });
  await cachedLLM({ ...base, key: "k2" });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get().n, 2);
  t += 1000; // both expired exactly now
  const r = await cachedLLM({ ...base, key: "k1" }); // expired row: not served, replaced
  assert.equal(r.cached, false);
  assert.equal(r.answer, "a3");
  // k2 is still on disk but expired; startup/sweep pruning removes it.
  useLlmStore(store, t);
  const keys = db.prepare(`SELECT key FROM llm_cache ORDER BY key`).all().map((x) => x.key);
  assert.deepEqual(keys, ["k1"]);
  assert.equal(store.prune(t + 1000), 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get().n, 0);
});

test("persistent LLM cache: ttl 0 disables it (always calls, never stores)", async () => {
  const db = freshDb();
  let calls = 0;
  const opts = { store: llmStore(db), key: "k", kind: "ask", model: "m", call: async () => (calls++, { answer: "x", ok: true }), ttlMs: 0 };
  await cachedLLM(opts);
  await cachedLLM(opts);
  assert.equal(calls, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM llm_cache`).get().n, 0);
});
