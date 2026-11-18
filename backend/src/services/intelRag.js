// Question answering over the hackathon database: chunk every project into
// labelled passages, embed them, retrieve the closest, and have Qwen answer
// from those passages only, with [n] citations mapped back to projects.
// The index is in memory (the corpus is hundreds of projects, not millions)
// and embed/qwen are injected so tests and benchmarks run offline.
import { listProjects, getProject } from "../data/intelStore.js";

const DEFAULT_K = 5;
const DEFAULT_MIN_SCORE = 0.25; // below this the best passage is unrelated: answer "unknown" without calling the model
const README_CHUNK_CHARS = 900;
const MAX_README_CHUNKS = 3;
const UNKNOWN_ANSWER = "I don't know: the hackathon database has nothing that answers this.";
const UNKNOWN_TOKEN = "UNKNOWN";

/**
 * @param {object} deps
 * @param {import("better-sqlite3").Database} deps.db
 * @param {(texts: string[]) => Promise<Float32Array[]>} deps.embed  normalized vectors
 * @param {{ chat: Function }} deps.qwen
 * @param {number} [deps.minScore]
 * @returns {{ buildIndex(): Promise<number>, retrieve(query: string, k?: number): Promise<object[]>, ask(question: string, opts?: { k?: number }): Promise<object> }}
 */
export function createIntelRag({ db, embed, qwen, minScore = DEFAULT_MIN_SCORE }) {
  let chunks = [];
  let vectors = [];

  async function buildIndex() {
    // getProject (not listProjects) so each project carries its contribution summaries
    chunks = buildChunks(listProjects(db).map((p) => getProject(db, p.id)));
    vectors = chunks.length ? await embed(chunks.map((c) => c.text)) : [];
    return chunks.length;
  }

  async function retrieve(query, k = DEFAULT_K) {
    if (!chunks.length) await buildIndex();
    if (!chunks.length) return [];
    const [queryVector] = await embed([query]);
    return chunks.map((chunk, i) => ({ ...chunk, score: similarity(queryVector, vectors[i]) }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  }

  async function ask(question, { k = DEFAULT_K } = {}) {
    const retrieved = await retrieve(question, k);
    if (!retrieved.length || retrieved[0].score < minScore) return unknownResult(retrieved);
    const reply = await qwen.chat(buildMessages(question, retrieved), { temperature: 0.1, maxTokens: 500 });
    if (reply.trim().toUpperCase().startsWith(UNKNOWN_TOKEN)) return unknownResult(retrieved);
    return { answer: reply.trim(), unknown: false, citations: citationsFor(reply, retrieved), retrieved: retrieved.map(summarizeHit) };
  }

  return { buildIndex, retrieve, ask };
}

/**
 * Turn projects into retrievable passages. Each passage names its project so a
 * chunk is understandable on its own.
 * @returns {{ id: string, projectId: number, title: string, label: string, text: string }[]}
 */
export function buildChunks(projects) {
  const chunks = [];
  for (const project of projects) {
    const add = (label, body) => {
      if (body?.trim()) chunks.push({ id: `${project.id}:${label}:${chunks.length}`, projectId: project.id, title: project.title, label, text: `${project.title} (${label}): ${body.trim()}` });
    };
    add("overview", overviewText(project));
    add("summary", [project.summary_what, project.summary_architecture].filter(Boolean).join(" "));
    splitText(project.readme ?? "", README_CHUNK_CHARS).slice(0, MAX_README_CHUNKS).forEach((part) => add("readme", part));
    add("team", teamText(project));
  }
  return chunks;
}

// ---------------------------------------------------------------- private helpers
function overviewText(project) {
  const prizes = project.prizes.map((p) => `${p.prize}${p.sponsor ? ` (sponsor ${p.sponsor})` : ""}${p.is_winner ? "" : " [finalist]"}`);
  return [
    project.hackathon_name ? `Hackathon: ${project.hackathon_name}.` : "",
    prizes.length ? `Prizes: ${prizes.join("; ")}.` : "",
    project.tagline ?? "", project.description ?? "",
    project.built_with?.length ? `Built with: ${project.built_with.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

function teamText(project) {
  const byPerson = new Map((project.contributions ?? []).map((c) => [c.person_id, c.summary]));
  return project.members.map((m) => `${m.name}${byPerson.has(m.id) ? `: ${byPerson.get(m.id)}` : ""}`).join(" ");
}

function splitText(text, size) {
  const parts = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length > size) { parts.push(current); current = ""; }
    current += (current ? "\n\n" : "") + paragraph;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function buildMessages(question, retrieved) {
  const system = [
    "You answer questions about hackathon projects using ONLY the numbered passages.",
    "Cite passages like [1]. Never state a fact the passages do not contain.",
    `If the passages do not answer the question, reply with exactly ${UNKNOWN_TOKEN}.`,
  ].join(" ");
  const body = retrieved.map((r, i) => `[${i + 1}] ${r.text}`).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: `Passages:\n${body}\n\nQuestion: ${question}` }];
}

function citationsFor(reply, retrieved) {
  const numbers = [...new Set([...reply.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  return numbers.filter((n) => n >= 1 && n <= retrieved.length)
    .map((n) => ({ n, projectId: retrieved[n - 1].projectId, title: retrieved[n - 1].title, label: retrieved[n - 1].label }));
}

function summarizeHit(hit) {
  return { projectId: hit.projectId, title: hit.title, label: hit.label, score: Math.round(hit.score * 1000) / 1000 };
}

function unknownResult(retrieved) {
  return { answer: UNKNOWN_ANSWER, unknown: true, citations: [], retrieved: retrieved.map(summarizeHit) };
}
