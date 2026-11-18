// projectSummaries with a mock Qwen and an in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord, listProjects } from "../../src/data/intelStore.js";
import { summarizeAll, summarizeProject, buildSources, parseSummary } from "../../src/services/projectSummaries.js";
import { groundedness } from "../../src/eval/groundedness.js";

function seed(extra = {}) {
  const db = new Database(":memory:");
  createIntelTables(db);
  upsertRecord(db, { kind: "project", source: "t", sourceUrl: "https://devpost.com/software/robo", data: {
    title: "Robo", tagline: "Robot chef", description: "Cooks dinner from fridge photos", readme: "FastAPI backend plus Qwen planner",
    fileTree: ["app/main.py", "web/index.ts"], githubStats: { languages: [{ name: "Python", share: 0.9 }] }, ...extra } });
  return db;
}
const mock = (reply) => ({ chat: async () => reply });
const GOOD = JSON.stringify({ what: "Robo cooks dinner from fridge photos [S1].", architecture: "A FastAPI backend with a Qwen planner [S2]." });

test("summarizeProject stores paragraphs, cited sources and a groundedness score", async () => {
  const db = seed();
  const result = await summarizeProject(db, mock("```json\n" + GOOD + "\n```"), listProjects(db)[0]);
  assert.deepEqual(result.sources, ["S1", "S2"]);
  assert.equal(result.groundedness, 1);
  const stored = listProjects(db)[0];
  assert.match(stored.summary_what, /fridge photos/);
  assert.deepEqual(stored.summary_sources, ["S1", "S2"]);
});

test("no source material means unknown, without calling the model", async () => {
  const db = seed({ tagline: null, description: null, readme: null, fileTree: null, githubStats: null });
  const qwen = { chat: async () => { throw new Error("must not be called"); } };
  const result = await summarizeProject(db, qwen, listProjects(db)[0]);
  assert.match(result.what, /^Unknown/);
});

test("summarizeAll skips done projects, records failures and continues", async () => {
  const db = seed();
  upsertRecord(db, { kind: "project", source: "t", sourceUrl: "https://devpost.com/software/two", data: { title: "Two", description: "Second thing" } });
  const failing = { chat: async (m) => { if (m[1].content.includes("Project: Two")) throw new Error("boom"); return GOOD; } };
  const first = await summarizeAll(db, failing);
  assert.deepEqual([first.done, first.failed.length], [1, 1]);
  const second = await summarizeAll(db, mock(GOOD));
  assert.deepEqual([second.done, second.skipped], [1, 1]);
});

test("parseSummary rejects non-JSON and wrong shapes", () => {
  assert.throws(() => parseSummary("sorry"), /no JSON/);
  assert.throws(() => parseSummary("{bad json}"), /not valid JSON/);
  assert.throws(() => parseSummary('{"what": 1}'), /lacks/);
});

test("buildSources omits empty blocks and labels sequentially", () => {
  const sources = buildSources({ readme: "text here", file_tree: [], built_with: ["Python"] });
  assert.deepEqual(sources.map((s) => s.label), ["S1", "S2"]);
});

test("groundedness flags sentences absent from the sources", () => {
  const source = "FastAPI backend with a Qwen planner and Postgres storage";
  const result = groundedness("The backend uses FastAPI and Postgres storage. It deploys on Kubernetes clusters with Terraform.", source);
  assert.equal(result.score, 0.5);
  assert.equal(result.ungrounded.length, 1);
});
