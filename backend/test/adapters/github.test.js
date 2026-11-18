// GitHub adapter: pure parsers + fetchRecords against fixtures, and that an
// enrichment record fills a project without clobbering Devpost data.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { fetchRecords, parseRepoUrl, parseReadme, parseTree, parseLanguages, parseContributors } from "../../src/adapters/github.js";
import { validateRecord } from "../../src/lib/records.js";
import { createIntelTables, upsertRecord, getProject } from "../../src/data/intelStore.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "github");
const json = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

test("parseRepoUrl accepts repo URLs only", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/alice-dev/robo-chef"), { owner: "alice-dev", repo: "robo-chef" });
  assert.deepEqual(parseRepoUrl("https://github.com/a/b.git"), { owner: "a", repo: "b" });
  assert.equal(parseRepoUrl("https://github.com/alice-dev"), null);
  assert.equal(parseRepoUrl(null), null);
});

test("parsers decode README, tree, languages, contributors", () => {
  assert.match(parseReadme(json("readme.json")), /## Architecture/);
  assert.deepEqual(parseTree(json("tree.json")), ["README.md", "app/main.py", "app/planner.py", "web/index.ts"]);
  assert.deepEqual(parseLanguages(json("languages.json")).map((l) => l.name), ["Python", "TypeScript", "Dockerfile"]);
  assert.equal(parseContributors(json("contributors.json"))[0].commits, 41);
  assert.equal(parseReadme(null), "");
});

test("fetchRecords enriches a project and the store keeps Devpost fields", async () => {
  const base = "https://api.github.com/repos/alice-dev/robo-chef";
  const seen = [];
  const http = {
    getJson: async (url, init) => {
      seen.push(init);
      const files = { [base]: "repo.json", [`${base}/languages`]: "languages.json", [`${base}/readme`]: "readme.json",
        [`${base}/contributors?per_page=10`]: "contributors.json", [`${base}/git/trees/main?recursive=1`]: "tree.json" };
      if (!files[url]) throw new Error(`unexpected ${url}`);
      return json(files[url]);
    },
  };
  const projects = [{ source_url: "https://devpost.com/software/robo-chef", title: "Robo Chef", github_url: "https://github.com/alice-dev/robo-chef" },
    { source_url: "https://devpost.com/software/no-repo", title: "X", github_url: null }];
  const records = await fetchRecords({ token: "t" }, { http, projects });
  assert.equal(records.length, 1);
  assert.deepEqual(validateRecord(records[0]), []);
  assert.equal(seen[0].headers.Authorization, "Bearer t");

  const db = new Database(":memory:");
  createIntelTables(db);
  const id = upsertRecord(db, { kind: "project", source: "devpost", sourceUrl: projects[0].source_url,
    data: { title: "Robo Chef", description: "cooks", builtWith: ["python"], prizes: [{ name: "Grand Prize" }] } });
  upsertRecord(db, records[0]);
  const project = getProject(db, id);
  assert.equal(project.description, "cooks");
  assert.deepEqual(project.built_with, ["python"]);
  assert.equal(project.is_winner, 1);
  assert.equal(project.source, "devpost");
  assert.match(project.readme, /Robo Chef/);
  assert.equal(project.file_tree.length, 4);
  assert.equal(project.github_stats.contributors[1].login, "bob-builder");
});
