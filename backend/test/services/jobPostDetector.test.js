// jobPostDetector rules against labelled messages plus markup/edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectJobPost, stripChatMarkup } from "../../src/services/jobPostDetector.js";

test("detects a Slack-formatted posting and extracts fields", () => {
  const r = detectJobPost({ text: "*Acme AI* is hiring a Machine Learning Engineer Intern in San Francisco! Apply here: <https://boards.greenhouse.io/acme/jobs/1|Greenhouse>", channel: "#jobs" });
  assert.equal(r.isJob, true);
  assert.equal(r.company, "Acme AI");
  assert.equal(r.location, "San Francisco");
  assert.equal(r.link, "https://boards.greenhouse.io/acme/jobs/1");
  assert.match(r.title, /Engineer/);
});

test("job seekers and chatter are not postings", () => {
  assert.equal(detectJobPost({ text: "I'm currently looking for a summer ML internship, anyone hiring?" }).isJob, false);
  assert.equal(detectJobPost({ text: "The engineer who built our demo is at table 14 come see" }).isJob, false);
  assert.equal(detectJobPost({ text: "thanks!" }).isJob, false);
  assert.equal(detectJobPost({}).isJob, false);
});

test("stripChatMarkup unwraps links, mentions and emphasis", () => {
  assert.equal(stripChatMarkup("<@U1> *hi* <https://a.test|site> <https://b.test>"), "hi site https://a.test https://b.test");
});

test("recruiter saying 'I'm looking for' still counts; hiring questions and team-formation do not", () => {
  assert.equal(detectJobPost({ text: "I'm looking for a backend engineer to join our startup, we're hiring! https://s.example/careers" }).isJob, true);
  assert.equal(detectJobPost({ text: "Anyone know if Stripe is hiring interns? Looking for a referral" }).isJob, false);
  assert.equal(detectJobPost({ text: "Apply now for the hackathon, we still need one designer on the team, join our team!" }).isJob, false);
});
