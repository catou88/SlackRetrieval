// practice (track pick + reveal) and teammateFinder over a small seeded database.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord } from "../../src/data/intelStore.js";
import { pickTrack, revealTrack } from "../../src/services/practice.js";
import { findTeammates } from "../../src/services/teammateFinder.js";

function seed() {
  const db = new Database(":memory:");
  createIntelTables(db);
  const add = (kind, url, data) => upsertRecord(db, { kind, source: "t", sourceUrl: url, data });
  add("hackathon", "https://h/1", { name: "Bay Hack", year: 2026 });
  add("project", "https://devpost.com/software/robo", { title: "Robo", hackathonUrl: "https://h/1", builtWith: ["python", "langgraph"],
    prizes: [{ name: "Best Agent", sponsor: "Acme", isWinner: true }], members: [{ name: "Ada", url: "https://devpost.com/ada" }] });
  add("project", "https://devpost.com/software/other", { title: "Other", hackathonUrl: "https://h/1", builtWith: ["rust"],
    members: [{ name: "Bob", url: "https://devpost.com/bob" }] });
  add("person", "https://devpost.com/ada", { name: "Ada", skills: ["Python"], githubUrl: "https://github.com/ada" });
  add("person", "https://devpost.com/bob", { name: "Bob", skills: ["Rust"] });
  return db;
}

test("pickTrack returns a real winning track without winners; null when empty", () => {
  const db = seed();
  const pick = pickTrack(db, { random: () => 0 });
  assert.equal(pick.track.prize, "Best Agent");
  assert.equal(pick.track.sponsor, "Acme");
  assert.equal(pick.track.winners, undefined);
  const empty = new Database(":memory:");
  createIntelTables(empty);
  assert.equal(pickTrack(empty), null);
});

test("revealTrack lists winners and rejects unknown tracks", () => {
  const db = seed();
  const { track } = pickTrack(db, { random: () => 0 });
  const revealed = revealTrack(db, { hackathonId: track.hackathonId, prize: track.prize });
  assert.deepEqual(revealed.winners.map((w) => w.title), ["Robo"]);
  assert.equal(revealTrack(db, { hackathonId: track.hackathonId, prize: "Nope" }), null);
});

test("findTeammates ranks by skills/stack and explains why; no match => empty", () => {
  const db = seed();
  const [first, ...rest] = findTeammates(db, "python langgraph");
  assert.equal(first.name, "Ada");
  assert.equal(rest.length, 0);
  assert.ok(first.why.some((w) => w.includes("winning")));
  assert.equal(first.links.github, "https://github.com/ada");
  assert.deepEqual(findTeammates(db, "cobol"), []);
  assert.deepEqual(findTeammates(db, ""), []);
});
