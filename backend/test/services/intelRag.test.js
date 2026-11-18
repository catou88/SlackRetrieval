// intelRag with a fake embedder and mock Qwen.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord } from "../../src/data/intelStore.js";
import { createIntelRag, buildChunks } from "../../src/services/intelRag.js";
import { fakeEmbed } from "../helpers/fakeEmbed.js";

function seed() {
  const db = new Database(":memory:");
  createIntelTables(db);
  const add = (slug, data) => upsertRecord(db, { kind: "project", source: "t", sourceUrl: `https://devpost.com/software/${slug}`, data });
  add("robo", { title: "Robo Chef", tagline: "Robot that cooks dinner from fridge photos", hackathonUrl: "https://h/1", hackathonName: "Bay Agents Hack",
    prizes: [{ name: "Best Use of Qwen", sponsor: "Alibaba" }], builtWith: ["python", "fastapi"] });
  add("tutor", { title: "Math Tutor", tagline: "Voice tutor for calculus homework", readme: "Uses whisper speech recognition and a tutoring graph" });
  return db;
}
const qwenSaying = (text) => ({ chat: async () => text });

test("index includes a passage per project facet", () => {
  const db = seed();
  const rag = createIntelRag({ db, embed: fakeEmbed, qwen: qwenSaying("x") });
  return rag.buildIndex().then((n) => assert.ok(n >= 2));
});

test("retrieve ranks the matching project first", async () => {
  const rag = createIntelRag({ db: seed(), embed: fakeEmbed, qwen: qwenSaying("x") });
  const [top] = await rag.retrieve("which robot cooks dinner from fridge photos");
  assert.equal(top.title, "Robo Chef");
});

test("ask answers with citations restricted to retrieved passages", async () => {
  const rag = createIntelRag({ db: seed(), embed: fakeEmbed, qwen: qwenSaying("Robo Chef won Best Use of Qwen [1] [9].") , minScore: 0.05 });
  const result = await rag.ask("Who won Best Use of Qwen sponsored by Alibaba?");
  assert.equal(result.unknown, false);
  assert.deepEqual(result.citations.map((c) => c.n), [1]);
  assert.ok(result.citations[0].title);
});

test("ask returns unknown without calling Qwen when retrieval is weak", async () => {
  const qwen = { chat: async () => { throw new Error("must not be called"); } };
  const rag = createIntelRag({ db: seed(), embed: fakeEmbed, qwen, minScore: 0.9 });
  const result = await rag.ask("What is the airspeed of a swallow?");
  assert.equal(result.unknown, true);
  assert.deepEqual(result.citations, []);
});

test("ask honours the model's UNKNOWN reply", async () => {
  const rag = createIntelRag({ db: seed(), embed: fakeEmbed, qwen: qwenSaying("UNKNOWN"), minScore: 0 });
  assert.equal((await rag.ask("anything")).unknown, true);
});

test("empty database yields unknown, not a crash", async () => {
  const db = new Database(":memory:");
  createIntelTables(db);
  const rag = createIntelRag({ db, embed: fakeEmbed, qwen: qwenSaying("x") });
  assert.equal((await rag.ask("hello")).unknown, true);
  assert.deepEqual(buildChunks([]), []);
});
