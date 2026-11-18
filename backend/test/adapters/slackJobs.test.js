// slackJobs adapter over a fake Slack archive; no files, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as slackJobs from "../../src/adapters/slackJobs.js";
import { validateRecord } from "../../src/lib/records.js";
import { createIntelTables, upsertRecord, listJobs } from "../../src/data/intelStore.js";

const messages = [
  { channel_id: "C1", channel: "#jobs", channel_type: "channel", ts: "1700000000.000100", date: "2023-11-14T22:13:20.000Z",
    text: "*Acme AI* is hiring a Machine Learning Engineer Intern in San Francisco! Apply here: <https://boards.greenhouse.io/acme/jobs/1|Greenhouse>" },
  { channel_id: "C1", channel: "#jobs", channel_type: "channel", ts: "1700000100.000100", date: "2023-11-14T22:15:00.000Z", text: "thanks for sharing!" },
  { channel_id: "D1", channel: "@bob", channel_type: "im", dm_with: "U2", ts: "1700000200.000100", date: "2023-11-14T22:16:40.000Z",
    text: "Initech is hiring a Founding Engineer, apply now https://jobs.ashbyhq.com/initech/x" },
  { channel_id: "C2", channel: "#general", channel_type: "channel", ts: "1700000300.000100", date: "2023-11-14T22:18:20.000Z",
    text: "Globex is hiring interns, apply at http://evil.test/careers <script>x</script> Remote" },
];

test("extracts postings, skips chatter and DMs, builds permalinks", async () => {
  const records = await slackJobs.fetchRecords({ workspaceUrl: "https://myteam.slack.com" }, { readMessages: () => messages });
  assert.equal(records.length, 2);
  for (const r of records) assert.deepEqual(validateRecord(r), []);
  assert.equal(records[0].sourceUrl, "slack:message:C1:1700000000.000100");
  assert.equal(records[0].data.permalink, "https://myteam.slack.com/archives/C1/p1700000000000100");
  assert.equal(records[0].data.channel, "#jobs");
  assert.equal(records[0].data.company, "Acme AI");
  assert.equal(records[1].data.link, null, "non-https links are dropped");
});

test("permalink needs a valid slack.com workspace URL", () => {
  assert.equal(slackJobs.slackPermalink("https://evil.test", "C1", "1.2"), null);
  assert.equal(slackJobs.slackPermalink(undefined, "C1", "1.2"), null);
});

test("stored jobs are filterable by source, channel and company and link sponsors", async () => {
  const db = new Database(":memory:");
  createIntelTables(db);
  for (const r of await slackJobs.fetchRecords({}, { readMessages: () => messages })) upsertRecord(db, r);
  assert.equal(listJobs(db, { source: "slackJobs", channel: "#jobs" }).length, 1);
  assert.equal(listJobs(db, { company: "acme ai" })[0].sponsor_name, null, "unknown companies do not become sponsors");
  upsertRecord(db, { kind: "sponsor", source: "devpost", sourceUrl: "https://acme.example", data: { name: "Acme AI" } });
  for (const r of await slackJobs.fetchRecords({}, { readMessages: () => messages })) upsertRecord(db, r);
  assert.equal(listJobs(db, { company: "acme ai" })[0].sponsor_name, "Acme AI");
  assert.equal(listJobs(db, { source: "discord" }).length, 0);
});

test("bot postings are kept; a link label cannot spoof the stored href", async () => {
  const bot = [{ channel_id: "C9", channel: "#jobs", channel_type: "channel", subtype: "bot_message", ts: "1.1", date: "2026-01-01T00:00:00.000Z",
    text: "Hooli is hiring a Software Engineer, apply <https://evil.test/x|https://good.test/jobs/1>" }];
  const [r] = await slackJobs.fetchRecords({}, { readMessages: () => bot });
  assert.equal(r.data.link, "https://evil.test/x");
});
