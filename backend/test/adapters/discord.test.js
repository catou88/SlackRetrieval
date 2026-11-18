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

test("direct-message exports are never read", async () => {
  const dm = JSON.stringify({ guild: { id: "0", name: "Direct Messages" }, channel: { id: "5", type: "DirectTextChat", name: "bob" },
    messages: [{ id: "1", type: "Default", timestamp: "2026-01-01T00:00:00+00:00", content: "Initech is hiring a Founding Engineer, apply now https://jobs.ashbyhq.com/initech/x" }] });
  const warnings = [];
  assert.deepEqual(await discord.fetchRecords({}, deps({ readFile: () => dm, warn: (m) => warnings.push(m) })), []);
  assert.match(warnings[0], /direct-message/);
});
