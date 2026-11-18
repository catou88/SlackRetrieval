// Jobs adapter against saved Greenhouse/Lever/Ashby responses; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as jobs from "../../src/adapters/jobs.js";
import { validateRecord } from "../../src/lib/records.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "jobs");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

test("parseBoard accepts shorthand and board URLs, rejects others", () => {
  assert.deepEqual(jobs.parseBoard("greenhouse:acme"), { vendor: "greenhouse", slug: "acme" });
  assert.deepEqual(jobs.parseBoard("https://jobs.lever.co/globex"), { vendor: "lever", slug: "globex" });
  assert.deepEqual(jobs.parseBoard("https://jobs.ashbyhq.com/initech"), { vendor: "ashby", slug: "initech" });
  assert.equal(jobs.parseBoard("https://example.com/careers"), null);
});

test("fetchRecords normalizes all three vendors and skips bad rows and dead boards", async () => {
  const responses = {
    "boards-api.greenhouse.io/v1/boards/acme/jobs": load("greenhouse.json"),
    "api.lever.co/v0/postings/globex": load("lever.json"),
    "api.ashbyhq.com/posting-api/job-board/initech": load("ashby.json"),
  };
  const http = { getJson: async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error("404");
    return responses[key];
  } };
  const sponsors = [
    { name: "Acme", jobs_board: "greenhouse:acme" }, { name: "Globex", jobs_board: "lever:globex" },
    { name: "NoBoard", jobs_board: null }, { name: "Dead", jobs_board: "greenhouse:gone" },
  ];
  const records = await jobs.fetchRecords({ boards: [{ company: "Initech", board: "ashby:initech" }] }, { http, sponsors });
  assert.equal(records.length, 3);
  for (const r of records) assert.deepEqual(validateRecord(r), []);
  assert.deepEqual(records.map((r) => r.data.sponsorName), ["Acme", "Globex", "Initech"]);
  assert.equal(records[0].data.location, "San Francisco, CA");
  assert.equal(records[1].data.postedAt, new Date(1760000000000).toISOString());
});
