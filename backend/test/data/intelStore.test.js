// Tests intelStore on an in-memory SQLite database: idempotent upserts,
// stub-then-fill ordering, relationships, and filtered reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord, intelCounts, listProjects, getProject, listSponsors, listJobs, listPeople } from "../../src/data/intelStore.js";

const HACK = "https://devpost.test/hack/1";
const PROJECT = "https://devpost.test/software/robo";
const ALICE = "https://devpost.test/alice";

function freshDb() {
  const db = new Database(":memory:");
  createIntelTables(db);
  return db;
}
const rec = (kind, sourceUrl, data) => ({ kind, source: "test", sourceUrl, data });
function seed(db) {
  upsertRecord(db, rec("hackathon", HACK, { name: "SF Hack", city: "San Francisco", year: 2026, sponsors: [{ name: "Acme" }] }));
  upsertRecord(db, rec("project", PROJECT, {
    title: "Robo", hackathonUrl: HACK, builtWith: ["Python", "FastAPI"],
    prizes: [{ name: "Best Agent", sponsor: "Acme" }], members: [{ name: "Alice", url: ALICE }],
  }));
}

test("upserting the same record twice does not duplicate rows", () => {
  const db = freshDb();
  seed(db);
  seed(db);
  assert.deepEqual(intelCounts(db), { hackathons: 1, projects: 1, people: 1, sponsors: 1, jobs: 0, contributions: 0 });
});

test("a project that arrives before its hackathon fills the stub later", () => {
  const db = freshDb();
  upsertRecord(db, rec("project", PROJECT, { title: "Robo", hackathonUrl: HACK, prizes: [] }));
  upsertRecord(db, rec("hackathon", HACK, { name: "SF Hack", city: "San Francisco", year: 2026 }));
  assert.equal(listProjects(db)[0].hackathon_name, "SF Hack");
  assert.equal(intelCounts(db).hackathons, 1);
});

test("projects carry prizes, sponsors, members and winner flag", () => {
  const db = freshDb();
  seed(db);
  const [project] = listProjects(db, { winnersOnly: true });
  assert.equal(project.is_winner, 1);
  assert.deepEqual(project.prizes.map((p) => p.sponsor), ["Acme"]);
  assert.deepEqual(project.members.map((m) => m.name), ["Alice"]);
});

test("filters by sponsor, stack and hackathon", () => {
  const db = freshDb();
  seed(db);
  assert.equal(listProjects(db, { sponsor: "acme" }).length, 1);
  assert.equal(listProjects(db, { sponsor: "other" }).length, 0);
  assert.equal(listProjects(db, { stack: "fastapi" }).length, 1);
  assert.equal(listProjects(db, { stack: "rust" }).length, 0);
});

test("a prize with isWinner=false does not mark the project a winner", () => {
  const db = freshDb();
  upsertRecord(db, rec("project", PROJECT, { title: "Robo", prizes: [{ name: "Finalist", isWinner: false }] }));
  assert.equal(listProjects(db)[0].is_winner, 0);
});

test("contributions attach to existing project and person and surface in getProject", () => {
  const db = freshDb();
  seed(db);
  upsertRecord(db, rec("person", ALICE, { name: "Alice", githubUrl: "https://github.test/alice", skills: ["ml"] }));
  upsertRecord(db, rec("contribution", `${PROJECT}#alice`, { projectUrl: PROJECT, personUrl: ALICE, summary: "Built the agent loop.", evidence: ["commit abc"] }));
  const project = getProject(db, listProjects(db)[0].id);
  assert.equal(project.contributions[0].summary, "Built the agent loop.");
  assert.deepEqual(project.contributions[0].evidence, ["commit abc"]);
  assert.equal(listPeople(db)[0].github_url, "https://github.test/alice");
});

test("contribution to an unknown project throws and writes nothing", () => {
  const db = freshDb();
  assert.throws(() => upsertRecord(db, rec("contribution", "x", { projectUrl: "nope", personUrl: "nope", summary: "s" })), /unknown/);
});

test("unknown kind throws", () => {
  assert.throws(() => upsertRecord(freshDb(), rec("alien", "x", {})), /Unknown record kind/);
});

test("jobs link to a sponsor deduped by name across adapters", () => {
  const db = freshDb();
  seed(db);
  upsertRecord(db, rec("job", "https://jobs.test/1", { title: "AI Engineer Intern", sponsorName: "Acme" }));
  assert.equal(listSponsors(db).length, 1);
  assert.equal(listSponsors(db)[0].prize_count, 1);
  assert.equal(listJobs(db, { sponsor: "ACME" }).length, 1);
});
