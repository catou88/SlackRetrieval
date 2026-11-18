// RAG eval harness on the labelled fixtures with the offline hash embedder.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRagEval, SKIPPED } from "../../src/eval/ragEval.js";
import { hashEmbed } from "../../src/eval/hashEmbedder.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "eval");
const files = { corpusFile: path.join(FIX, "rag-corpus.json"), questionsFile: path.join(FIX, "rag-questions.json"), embed: hashEmbed };

test("retrieval metrics are computed per split and answer metrics are skipped without Qwen", async () => {
  const m = await runRagEval(files);
  assert.ok(m["dev.recall@5"] >= 0.8, `dev recall ${m["dev.recall@5"]}`);
  assert.ok(m["heldout.mrr"] > 0.5);
  assert.equal(m["dev.answer_correctness"], SKIPPED);
  assert.ok(m["dev.questions"] + m["heldout.questions"] >= 30);
});

test("with a Qwen stub that cites [1], metrics are numeric", async () => {
  const qwen = { chat: async () => "Answer [1]" };
  const m = await runRagEval({ ...files, qwen, minScore: 0 });
  assert.equal(typeof m["heldout.citation_accuracy"], "number");
});
