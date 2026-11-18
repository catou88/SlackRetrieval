// Benchmarks: ingest throughput, embedding time, retrieval latency and
// end-to-end ask latency over the labelled corpus. Timings use an injected
// clock so tests are deterministic; qwen is a mock unless a real one is passed.
import fs from "node:fs";
import Database from "better-sqlite3";
import { createIntelTables, upsertRecord } from "../data/intelStore.js";
import { createIntelRag, buildChunks } from "../services/intelRag.js";
import { listProjects, getProject } from "../data/intelStore.js";
import { loadCorpus } from "./ragEval.js";

const INGEST_RECORDS = 500;
const EMBED_BATCH = 100;

/**
 * @param {{ corpusFile: string, questionsFile: string, embed: Function, qwen: { chat: Function }, qwenIsReal?: boolean, now?: () => number }} opts
 * @returns {Promise<Record<string, number | string>>}
 */
export async function runBench({ corpusFile, questionsFile, embed, qwen, qwenIsReal = false, now = () => performance.now() }) {
  const questions = JSON.parse(fs.readFileSync(questionsFile, "utf8")).questions.map((q) => q.q);
  const db = loadCorpus(corpusFile);
  const rag = createIntelRag({ db, embed, qwen });
  const chunks = buildChunks(listProjects(db).map((p) => getProject(db, p.id)));
  const texts = Array.from({ length: EMBED_BATCH }, (_, i) => chunks[i % chunks.length].text);

  const embedMs = await timed(now, () => embed(texts));
  await rag.buildIndex();
  const retrieval = await sample(now, questions, (q) => rag.retrieve(q));
  const ask = await sample(now, questions, (q) => rag.ask(q));
  db.close();
  return {
    "ingest.records_per_sec": round(ingestThroughput(now)),
    "embed.ms_per_100_chunks": round(embedMs),
    "retrieval.p50_ms": round(percentile(retrieval, 50)),
    "retrieval.p95_ms": round(percentile(retrieval, 95)),
    [qwenIsReal ? "ask.p50_ms" : "ask.p50_ms(mock_qwen)"]: round(percentile(ask, 50)),
    [qwenIsReal ? "ask.p95_ms" : "ask.p95_ms(mock_qwen)"]: round(percentile(ask, 95)),
  };
}

/** @returns {number} nearest-rank percentile of numbers (0 for empty) */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// ---------------------------------------------------------------- private helpers
function ingestThroughput(now) {
  const db = new Database(":memory:");
  createIntelTables(db);
  const start = now();
  for (let i = 0; i < INGEST_RECORDS; i++) {
    upsertRecord(db, { kind: "project", source: "bench", sourceUrl: `https://bench.test/p${i}`, data: { title: `Project ${i}`, tagline: "bench", builtWith: ["js"] } });
  }
  const seconds = Math.max((now() - start) / 1000, 1e-6);
  db.close();
  return INGEST_RECORDS / seconds;
}

async function timed(now, fn) {
  const start = now();
  await fn();
  return now() - start;
}

async function sample(now, items, fn) {
  const times = [];
  for (const item of items) times.push(await timed(now, () => fn(item)));
  return times;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
