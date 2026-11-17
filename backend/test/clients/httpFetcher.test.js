// Offline tests for the polite fetcher: a fake fetch, clock and sleeper.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpFetcher, parseRobotsDisallowed } from "../../src/clients/httpFetcher.js";
import { buildConfig } from "../../src/config.js";

function harness(handler, extra = {}) {
  let clock = 1_000_000;
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, calls.length);
  };
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const fetcher = createHttpFetcher({ fetchImpl, now: () => clock, sleep, cacheDir: null, respectRobots: false, minIntervalMs: 1000, ...extra });
  return { fetcher, calls, sleeps };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => body });
const fail = (status) => ({ ok: false, status, text: async () => "" });

test("spaces requests to the same host by the minimum interval", async () => {
  const { fetcher, sleeps } = harness(() => ok("x"));
  await fetcher.getText("https://a.test/1");
  await fetcher.getText("https://a.test/2");
  assert.deepEqual(sleeps, [1000]);
});

test("does not delay requests to different hosts", async () => {
  const { fetcher, sleeps } = harness(() => ok("x"));
  await fetcher.getText("https://a.test/1");
  await fetcher.getText("https://b.test/1");
  assert.deepEqual(sleeps, []);
});

test("retries 503 with backoff then succeeds, sending a generic User-Agent", async () => {
  const { fetcher, calls } = harness((_, n) => (n < 2 ? fail(503) : ok("done")));
  assert.equal(await fetcher.getText("https://a.test/x"), "done");
  assert.equal(calls.length, 2);
  assert.match(calls[0].init.headers["User-Agent"], /HackathonIntelBot/);
});

test("does not retry a 404", async () => {
  const { fetcher, calls } = harness(() => fail(404));
  await assert.rejects(fetcher.getText("https://a.test/x"), /HTTP 404/);
  assert.equal(calls.length, 1);
});

test("gives up after the attempt limit", async () => {
  const { fetcher, calls } = harness(() => fail(500));
  await assert.rejects(fetcher.getText("https://a.test/x"), /HTTP 500/);
  assert.equal(calls.length, 3);
});

test("serves repeats from the on-disk cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-"));
  const { fetcher, calls } = harness(() => ok('{"a":1}'), { cacheDir: dir });
  assert.deepEqual(await fetcher.getJson("https://a.test/j"), { a: 1 });
  assert.deepEqual(await fetcher.getJson("https://a.test/j"), { a: 1 });
  assert.equal(calls.length, 1);
  fs.rmSync(dir, { recursive: true });
});

test("refuses URLs disallowed by robots.txt and fetches allowed ones", async () => {
  const { fetcher } = harness((url) => (url.endsWith("robots.txt") ? ok("User-agent: *\nDisallow: /private") : ok("page")), { respectRobots: true });
  await assert.rejects(fetcher.getText("https://a.test/private/x"), /robots/);
  assert.equal(await fetcher.getText("https://a.test/public"), "page");
});

test("parseRobotsDisallowed only reads the wildcard agent and skips patterns", () => {
  const text = "User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /a # c\nDisallow: /*.pdf\nDisallow:\n";
  assert.deepEqual(parseRobotsDisallowed(text), ["/a"]);
});

test("config never allows a request interval under one second", () => {
  assert.equal(buildConfig({ INTEL_MIN_INTERVAL_MS: "10" }).intel.http.minIntervalMs, 1000);
  assert.equal(buildConfig({}).qwen.model, "qwen3:8b");
});
