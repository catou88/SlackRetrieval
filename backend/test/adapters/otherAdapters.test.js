// Hugging Face, manualImport and slack adapters against fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as hf from "../../src/adapters/huggingface.js";
import * as manual from "../../src/adapters/manualImport.js";
import * as slack from "../../src/adapters/slack.js";
import { validateRecord } from "../../src/lib/records.js";
import { adapterNames } from "../../src/adapters/registry.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (f) => fs.readFileSync(path.join(FIX, f), "utf8");

test("registry lists every adapter", () => {
  assert.deepEqual(adapterNames(), ["devpost", "github", "huggingface", "manual", "slack", "slackJobs"]);
});

test("huggingface parses URLs and enriches projects", async () => {
  assert.deepEqual(hf.parseHfUrl("https://huggingface.co/spaces/alice-dev/robo-chef"), { kind: "spaces", owner: "alice-dev", repo: "robo-chef" });
  assert.equal(hf.parseHfUrl("https://huggingface.co/alice-dev/model").kind, "models");
  assert.equal(hf.parseHfUrl("https://example.com/x/y"), null);
  const http = { getJson: async (url) => { assert.match(url, /api\/spaces\/alice-dev\/robo-chef$/); return JSON.parse(read("huggingface/space.json")); } };
  const projects = [{ source_url: "https://devpost.com/software/robo-chef", title: "Robo Chef", hf_url: "https://huggingface.co/spaces/alice-dev/robo-chef" }];
  const [record] = await hf.fetchRecords({}, { http, projects });
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.data.hfInfo, { sdk: "gradio", likes: 3, tags: ["gradio"] });
});

test("manual CSV handles quotes, blanks and maps columns to data", async () => {
  const records = await manual.fetchRecords({ file: "x.csv" }, { readFile: () => read("manual/import.csv") });
  assert.equal(records.length, 2);
  for (const r of records) assert.deepEqual(validateRecord(r), []);
  assert.equal(records[0].data.linkedinUrl, "https://www.linkedin.com/in/alice-dev");
  assert.equal(records[1].data.title, "ML Engineer, Agents");
  assert.equal(records[1].source, "manual");
});

test("manual JSON retags source and rejects non-arrays", () => {
  const [r] = manual.parseJsonRecords('[{"kind":"sponsor","sourceUrl":"s:1","data":{"name":"Acme"}}]');
  assert.equal(r.source, "manual");
  assert.throws(() => manual.parseJsonRecords("{}"), /array/);
});

test("slack adapter maps contacts to person records, skipping me", async () => {
  const people = { U1: { id: "U1", name: "Jane", linkedin: ["https://linkedin.com/in/jane"], title: "Eng" }, U2: { id: "U2", name: "Me", is_me: true, linkedin: [] } };
  const records = await slack.fetchRecords({}, { readPeople: () => people });
  assert.equal(records.length, 1);
  assert.deepEqual(validateRecord(records[0]), []);
  assert.equal(records[0].data.linkedinUrl, "https://linkedin.com/in/jane");
});
