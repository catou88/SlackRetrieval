// RAG evals over the labelled corpus/questions fixtures. Retrieval metrics
// (recall@5, MRR, unknown-gate rate) need only an embedder. Answer metrics
// (correctness, citation accuracy, unknown rate) need a real model, so without
// a Qwen client they are reported as skipped instead of invented.
import fs from "node:fs";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord, listProjects } from "../data/intelStore.js";
import { createIntelRag, DEFAULT_MIN_SCORE } from "../services/intelRag.js";
import { round3 } from "./metrics.js";

export const SKIPPED = "skipped (no Qwen endpoint)";
const K = 5;
const SPLITS = ["dev", "heldout"];

/**
 * @param {{ corpusFile: string, questionsFile: string, embed: Function, qwen?: { chat: Function } | null, minScore?: number }} opts
 * @returns {Promise<Record<string, number | string>>} flat metric map, keys like "heldout.recall@5"
 */
export async function runRagEval({ corpusFile, questionsFile, embed, qwen = null, minScore = DEFAULT_MIN_SCORE }) {
  const db = loadCorpus(corpusFile);
  const idBySlug = new Map(listProjects(db).map((p) => [p.source_url.split("/").pop(), p.id]));
  const questions = JSON.parse(fs.readFileSync(questionsFile, "utf8")).questions;
  const rag = createIntelRag({ db, embed, qwen: qwen ?? { chat: async () => "UNKNOWN" }, minScore });
  const metrics = {};
  for (const split of SPLITS) {
    const subset = questions.filter((q) => q.split === split);
    Object.assign(metrics, await scoreSplit(split, subset, { rag, idBySlug, minScore, hasQwen: Boolean(qwen) }));
  }
  db.close();
  return metrics;
}

/**
 * @param {string} corpusFile
 * @returns {import("better-sqlite3").Database} in-memory database seeded from the labelled corpus
 */
export function loadCorpus(corpusFile) {
  const db = new Database(":memory:");
  createIntelTables(db);
  for (const p of JSON.parse(fs.readFileSync(corpusFile, "utf8")).projects) {
    upsertRecord(db, { kind: "project", source: "eval", sourceUrl: `https://devpost.com/software/${p.slug}`, data: {
      title: p.title, tagline: p.tagline, builtWith: p.builtWith, hackathonUrl: `https://eval.test/${p.hackathon}`, hackathonName: p.hackathon,
      prizes: [{ name: p.prize, sponsor: p.sponsor ?? undefined }], members: p.members.map((m) => ({ name: m, url: `https://devpost.com/${m.replace(/\s/g, "")}` })) } });
  }
  return db;
}

// ---------------------------------------------------------------- private helpers
async function scoreSplit(split, subset, { rag, idBySlug, minScore, hasQwen }) {
  const answerable = subset.filter((q) => q.answerable !== false);
  const unanswerable = subset.filter((q) => q.answerable === false);
  const ranks = [];
  for (const q of answerable) ranks.push(await firstGoldRank(q, rag, idBySlug));
  const gated = [];
  for (const q of unanswerable) gated.push(isGatedUnknown(await rag.retrieve(q.q, 1), minScore));
  const out = {
    [`${split}.recall@${K}`]: round3(mean(ranks.map((r) => (r > 0 ? 1 : 0)))),
    [`${split}.mrr`]: round3(mean(ranks.map((r) => (r > 0 ? 1 / r : 0)))),
    [`${split}.unknown_gate_rate`]: round3(mean(gated)),
    [`${split}.questions`]: subset.length,
  };
  Object.assign(out, hasQwen ? await answerMetrics(split, answerable, unanswerable, rag, idBySlug) : skippedAnswerMetrics(split));
  return out;
}

/** @returns {number} 1-based rank of the first chunk of a gold project among top-k chunks, 0 when absent */
async function firstGoldRank(question, rag, idBySlug) {
  const gold = new Set(question.gold.map((s) => idBySlug.get(s)));
  const hits = await rag.retrieve(question.q, K);
  const index = hits.findIndex((h) => gold.has(h.projectId));
  return index + 1;
}

async function answerMetrics(split, answerable, unanswerable, rag, idBySlug) {
  const correct = [];
  const cited = [];
  for (const q of answerable) {
    const result = await rag.ask(q.q);
    correct.push(!result.unknown && result.answer.toLowerCase().includes(q.answer.toLowerCase()));
    const gold = new Set(q.gold.map((s) => idBySlug.get(s)));
    cited.push(result.citations.length > 0 && result.citations.every((c) => gold.has(c.projectId)));
  }
  const unknown = [];
  for (const q of unanswerable) unknown.push((await rag.ask(q.q)).unknown);
  return {
    [`${split}.answer_correctness`]: round3(mean(correct)),
    [`${split}.citation_accuracy`]: round3(mean(cited)),
    [`${split}.unknown_rate`]: round3(mean(unknown)),
  };
}

function skippedAnswerMetrics(split) {
  return Object.fromEntries(["answer_correctness", "citation_accuracy", "unknown_rate"].map((m) => [`${split}.${m}`, SKIPPED]));
}

function isGatedUnknown(topHits, minScore) {
  return topHits.length === 0 || topHits[0].score < minScore;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + Number(b), 0) / values.length : 0;
}
