// Job-post detection eval: score jobPostDetector against hand-labelled chat
// messages (precision/recall on isJob, accuracy on extracted company/location/link).
import fs from "node:fs";
import { detectJobPost } from "../services/jobPostDetector.js";
import { precisionRecallF1, accuracy, round3 } from "./metrics.js";

/**
 * @param {string} goldFile  path to jobs-gold.json
 * @returns {Record<string, number>} metric name -> value (0..1)
 */
export function runJobsEval(goldFile) {
  const { messages } = JSON.parse(fs.readFileSync(goldFile, "utf8"));
  const results = messages.map((m) => ({ gold: m, got: detectJobPost(m) }));
  const ids = (pick) => results.map((r, i) => (pick(r) ? i : null)).filter((i) => i !== null);
  const detection = precisionRecallF1(ids((r) => r.got.isJob), ids((r) => r.gold.isJob));
  const positives = results.filter((r) => r.gold.isJob && r.got.isJob);
  return {
    "job_detect.precision": round3(detection.precision),
    "job_detect.recall": round3(detection.recall),
    "job_company.accuracy": round3(fieldAccuracy(positives, "company")),
    "job_location.accuracy": round3(fieldAccuracy(positives, "location")),
    "job_link.accuracy": round3(fieldAccuracy(positives, "link")),
  };
}

/** Accuracy of one extracted field over true positives; 0 (not a vacuous 1) when nothing was detected. */
function fieldAccuracy(positives, field) {
  if (!positives.length) return 0;
  return accuracy(positives.map((r) => (r.got[field] ?? null) === (r.gold[field] ?? null)));
}
