// intelIngest: adapters -> validation -> store, with a fake adapter fetcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { ingestFromAdapter, ingestAll } from "../../src/services/intelIngest.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "devpost");
const read = (f) => fs.readFileSync(path.join(FIX, f), "utf8");

function fakeHttp() {
  const pages = {
    "https://devpost.com/api/hackathons?status[]=ended&page=1": read("hackathons.json"),
    "https://bayagents.example.test/details/prizes": read("prizes.html"),
    "https://bayagents.example.test/project-gallery": read("gallery.html"),
    "https://devpost.com/software/robo-chef": read("project.html"),
    "https://bay.example.test/software/relative-one": read("project.html"),
    "https://bayagents.example.test/software/relative-one": read("project.html"),
    "https://devpost.com/alice-dev": read("profile.html"),
    "https://devpost.com/bob-builder": "<html></html>",
  };
  const getText = async (url) => { if (!(url in pages)) throw new Error(`unexpected ${url}`); return pages[url]; };
  return { getText, getJson: async (url) => JSON.parse(await getText(url)) };
}

test("ingestFromAdapter stores devpost records and is idempotent", async () => {
  const db = new Database(":memory:");
  const opts = { maxHackathons: 1, maxPages: 1 };
  const first = await ingestFromAdapter(db, "devpost", opts, { http: fakeHttp() });
  assert.equal(first.problems.length, 0, first.problems.join("\n"));
  assert.equal(first.counts.hackathons, 1);
  assert.equal(first.counts.projects, 2);
  const second = await ingestFromAdapter(db, "devpost", opts, { http: fakeHttp() });
  assert.deepEqual(second.counts, first.counts);
});

test("ingestAll reports a failing adapter without aborting", async () => {
  const db = new Database(":memory:");
  const http = { getText: async () => { throw new Error("blocked"); }, getJson: async () => { throw new Error("blocked"); } };
  const summaries = await ingestAll(db, ["devpost"], {}, { http });
  assert.equal(summaries[0].error, "blocked");
  await assert.rejects(ingestFromAdapter(db, "nope"), /Unknown adapter/);
});
