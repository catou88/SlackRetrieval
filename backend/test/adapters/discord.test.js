// discord adapter against a DiscordChatExporter-format fixture; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as discord from "../../src/adapters/discord.js";
import { validateRecord } from "../../src/lib/records.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "discord", "jobs-channel.json");
const deps = (extra = {}) => ({ listFiles: () => [FIX], readFile: (f) => fs.readFileSync(f, "utf8"), warn: () => {}, ...extra });

test("extracts postings from message text and embeds with permalinks", async () => {
  const records = await discord.fetchRecords({}, deps());
  assert.equal(records.length, 2);
  for (const r of records) assert.deepEqual(validateRecord(r), []);
  const [text, embed] = records;
  assert.equal(text.source, "discord");
  assert.equal(text.sourceUrl, "discord:message:222:301");
  assert.equal(text.data.permalink, "https://discord.com/channels/111/222/301");
  assert.equal(text.data.channel, "AI Builders #job-board");
  assert.equal(text.data.postedAt, "2026-03-02T18:00:00.000+00:00");
  assert.equal(text.data.company, "Acme AI");
  assert.equal(embed.data.link, "https://hooli.example/careers/swe");
});

test("invalid exports are skipped with a warning, not fatal", async () => {
  const warnings = [];
  const records = await discord.fetchRecords({}, deps({ readFile: () => "{not json", warn: (m) => warnings.push(m) }));
  assert.deepEqual(records, []);
  assert.match(warnings[0], /skipped jobs-channel\.json/);
});

test("missing folder yields no records", async () => {
  assert.deepEqual(await discord.fetchRecords({ discordDir: "/nonexistent/discord-x" }, { warn: () => {} }), []);
});
