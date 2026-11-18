// Tests for the eval harness: metric maths, the extraction eval over the gold
// fixtures, and the report/history writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { precisionRecallF1, accuracy } from "../../src/eval/metrics.js";
import { runExtractionEval } from "../../src/eval/extractionEval.js";
import { writeEvalReport, metricDeltas } from "../../src/eval/report.js";

const GOLD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "eval", "devpost-gold.json");

test("precisionRecallF1 handles partial overlap and empties", () => {
  const r = precisionRecallF1(["a", "b"], ["b", "c"]);
  assert.equal(r.precision, 0.5);
  assert.equal(r.recall, 0.5);
  assert.equal(r.f1, 0.5);
  assert.equal(precisionRecallF1([], []).f1, 1);
  assert.equal(precisionRecallF1([], ["a"]).recall, 0);
});

test("accuracy is the true fraction", () => {
  assert.equal(accuracy([true, false, true, true]), 0.75);
  assert.equal(accuracy([]), 1);
});

test("extraction eval scores the gold fixtures", () => {
  const m = runExtractionEval(GOLD);
  assert.deepEqual(Object.keys(m), ["winner.precision", "winner.recall", "members.f1", "sponsor_link.accuracy", "sf2026_filter.accuracy"]);
  for (const value of Object.values(m)) assert.equal(value, 1);
});

test("report writer creates a markdown report and appends history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intel-eval-"));
  writeEvalReport({ extraction: { "winner.recall": 0.5 } }, { dir, date: "2026-11-18", commit: "abc" });
  const { historyFile, reportFile } = writeEvalReport({ extraction: { "winner.recall": 0.75 } }, { dir, date: "2026-11-19", commit: "def" });
  assert.match(fs.readFileSync(reportFile, "utf8"), /winner.recall \| 0.75/);
  assert.deepEqual(metricDeltas(historyFile, "extraction"), [{ metric: "winner.recall", previous: 0.5, current: 0.75 }]);
  fs.rmSync(dir, { recursive: true });
});

test("jobs eval scores the labelled chat messages", async () => {
  const { runJobsEval } = await import("../../src/eval/jobsEval.js");
  const m = runJobsEval(GOLD.replace("devpost-gold", "jobs-gold"));
  assert.ok(m["job_detect.precision"] >= 0.9 && m["job_detect.recall"] >= 0.9);
});
