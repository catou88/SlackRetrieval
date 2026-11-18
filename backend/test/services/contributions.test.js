// contributions with mock Qwen: evidence-only, unknown when thin.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord, getProject } from "../../src/data/intelStore.js";
import { summarizeContributions, gatherEvidence } from "../../src/services/contributions.js";

function seed() {
  const db = new Database(":memory:");
  createIntelTables(db);
  upsertRecord(db, { kind: "person", source: "t", sourceUrl: "https://devpost.com/alice", data: { name: "Alice", githubUrl: "https://github.com/Alice-Dev", bio: "Backend engineer", skills: ["python"] } });
  upsertRecord(db, { kind: "person", source: "t", sourceUrl: "https://devpost.com/bob", data: { name: "Bob" } });
  upsertRecord(db, { kind: "project", source: "t", sourceUrl: "https://devpost.com/software/robo", data: {
    title: "Robo", members: [{ name: "Alice", url: "https://devpost.com/alice" }, { name: "Bob", url: "https://devpost.com/bob" }],
    githubStats: { contributors: [{ login: "alice-dev", commits: 41, url: "x" }, { login: "other", commits: 9, url: "y" }] } } });
  return db;
}

test("evidence uses GitHub commit share, bio and skills, case-insensitively", () => {
  const db = seed();
  const project = getProject(db, 1);
  const alice = project.members.find((m) => m.name === "Alice");
  const lines = gatherEvidence(project, alice);
  assert.match(lines[0], /41 of 50 commits/);
  assert.equal(lines.length, 3);
});

test("members without evidence get 'Unknown' and no model call; others are stored with evidence", async () => {
  const db = seed();
  const calls = [];
  const qwen = { chat: async (m) => { calls.push(m); return "Alice built the backend."; } };
  const results = await summarizeContributions(db, qwen, getProject(db, 1));
  assert.equal(calls.length, 1);
  assert.equal(results.find((r) => r.person === "Bob").summary.startsWith("Unknown"), true);
  const stored = getProject(db, 1).contributions;
  assert.equal(stored.length, 2);
  assert.equal(stored.find((c) => c.name === "Alice").evidence.length, 3);
  assert.match(calls[0][1].content, /41 of 50/);
});
