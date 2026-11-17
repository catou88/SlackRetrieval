// Parser tests for the Devpost adapter against SYNTHETIC fixtures (see
// fixtures/devpost/README.md), plus an offline end-to-end fetchRecords run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchRecords, selectTargetHackathons, parseGallery, parseProject, parseProfile, parsePrizes, linkPrizeSponsors,
} from "../../src/adapters/devpost.js";
import { validateRecord } from "../../src/lib/records.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "devpost");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

test("selectTargetHackathons keeps only San Francisco hackathons touching 2026", () => {
  const picked = selectTargetHackathons(JSON.parse(read("hackathons.json")));
  assert.deepEqual(picked.map((h) => h.data.name), ["Bay Agents Hackathon", "New Year SF Marathon"]);
  assert.equal(picked[1].data.year, 2026);
});

test("parseGallery flags winners and resolves relative links", () => {
  const items = parseGallery(read("gallery.html"), "https://bay.example.test/");
  assert.deepEqual(items.map((i) => [i.title, i.isWinner]), [["Robo Chef", true], ["Plain Todo", false], ["Relative One", true]]);
  assert.equal(items[2].url, "https://bay.example.test/software/relative-one");
});

test("parseProject extracts title, stack, links, prizes and team", () => {
  const p = parseProject(read("project.html"));
  assert.equal(p.title, "Robo Chef");
  assert.deepEqual(p.builtWith, ["python", "fastapi", "qwen"]);
  assert.equal(p.githubUrl, "https://github.com/alice-dev/robo-chef");
  assert.equal(p.hfUrl, "https://huggingface.co/spaces/alice-dev/robo-chef");
  assert.deepEqual(p.prizes.map((x) => x.name), ["Best Use of Acme API", "Grand Prize"]);
  assert.deepEqual(p.members.map((m) => m.name), ["Alice Dev", "Bob Builder"]);
  assert.match(p.description, /fridge/);
});

test("parseProfile only returns LinkedIn from the person's own links", () => {
  const profile = parseProfile(read("profile.html"));
  assert.equal(profile.linkedinUrl, "https://www.linkedin.com/in/alice-dev");
  assert.equal(profile.githubUrl, "https://github.com/alice-dev");
  assert.equal(parseProfile("<html></html>").linkedinUrl, null);
});

test("prize sponsors link by exact name; unmatched prizes stay null", () => {
  const prizes = parsePrizes(read("prizes.html"));
  const linked = linkPrizeSponsors([{ name: "best use of acme api" }, { name: "Mystery" }], prizes);
  assert.deepEqual(linked.map((p) => p.sponsor), ["Acme", null]);
});

test("fetchRecords produces valid records from a fake fetcher", async () => {
  const pages = {
    "https://devpost.com/api/hackathons?status[]=ended&page=1": read("hackathons.json"),
    "https://bayagents.example.test/details/prizes": read("prizes.html"),
    "https://bayagents.example.test/project-gallery": read("gallery.html"),
    "https://devpost.com/software/robo-chef": read("project.html"),
    "https://bayagents.example.test/software/relative-one": read("project.html"),
    "https://devpost.com/alice-dev": read("profile.html"),
    "https://devpost.com/bob-builder": "<html></html>",
  };
  const http = {
    getText: async (url) => { if (!(url in pages)) throw new Error(`unexpected ${url}`); return pages[url]; },
    getJson: async (url) => JSON.parse(await http.getText(url)),
  };
  const records = await fetchRecords({ maxHackathons: 1, maxPages: 1 }, { http });
  for (const r of records) assert.deepEqual(validateRecord(r), [], JSON.stringify(r).slice(0, 80));
  const kinds = records.map((r) => r.kind);
  assert.equal(kinds.filter((k) => k === "hackathon").length, 1);
  assert.equal(kinds.filter((k) => k === "project").length, 2);
  assert.deepEqual(records[0].data.sponsors, [{ name: "Acme" }]);
});
