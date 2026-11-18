// Generates two cited paragraphs per project ("what it is" and "how the code
// is architected") from the Devpost text, README, file tree and languages.
// Qwen only sees labelled sources ([S1], [S2], ...) and is told to say
// "unknown" when they do not support a claim; with no sources we skip the
// model entirely rather than let it invent something.
import { listProjects, setProjectSummary } from "../data/intelStore.js";
import { groundedness } from "../eval/groundedness.js";

const MAX_README_CHARS = 5000;
const MAX_DESCRIPTION_CHARS = 3000;
const MAX_TREE_PATHS = 80;
const UNKNOWN_TEXT = "Unknown: no source material (description, README or code tree) was available.";

/**
 * Summarize one project and store the result.
 * @param {import("better-sqlite3").Database} db
 * @param {{ chat: Function }} qwen
 * @param {object} project  a row from listProjects/getProject
 * @returns {Promise<{ what: string, architecture: string, sources: string[], groundedness: number }>}
 */
export async function summarizeProject(db, qwen, project) {
  const sources = buildSources(project);
  if (!sources.length) {
    const summary = { what: UNKNOWN_TEXT, architecture: UNKNOWN_TEXT, sources: [] };
    setProjectSummary(db, project.id, summary);
    return { ...summary, groundedness: 1 };
  }
  const reply = await qwen.chat(buildMessages(project, sources), { temperature: 0.1, maxTokens: 700 });
  const parsed = parseSummary(reply);
  const labels = sources.map((s) => s.label);
  const cited = labels.filter((l) => `${parsed.what} ${parsed.architecture}`.includes(`[${l}]`));
  const summary = { what: parsed.what, architecture: parsed.architecture, sources: cited };
  setProjectSummary(db, project.id, summary);
  const score = groundedness(`${parsed.what} ${parsed.architecture}`, sources.map((s) => s.text).join("\n")).score;
  return { ...summary, groundedness: score };
}

/**
 * Summarize every project that has none yet (or all, with force). A failure on
 * one project is recorded and does not stop the rest.
 * @returns {Promise<{ done: number, skipped: number, failed: { id: number, error: string }[] }>}
 */
export async function summarizeAll(db, qwen, { force = false } = {}) {
  const result = { done: 0, skipped: 0, failed: [] };
  for (const project of listProjects(db)) {
    if (project.summary_what && !force) { result.skipped++; continue; }
    try {
      await summarizeProject(db, qwen, project);
      result.done++;
    } catch (err) {
      result.failed.push({ id: project.id, error: err.message });
    }
  }
  return result;
}

/** @returns {{ label: string, title: string, text: string }[]} the labelled source blocks available for a project */
export function buildSources(project) {
  const blocks = [
    ["Devpost description", [project.tagline, project.description].filter(Boolean).join("\n").slice(0, MAX_DESCRIPTION_CHARS)],
    ["README", (project.readme ?? "").slice(0, MAX_README_CHARS)],
    ["File tree", treePaths(project.file_tree).slice(0, MAX_TREE_PATHS).join("\n")],
    ["Languages and stack", stackText(project)],
  ];
  return blocks.filter(([, text]) => text.trim()).map(([title, text], i) => ({ label: `S${i + 1}`, title, text }));
}

/**
 * Tolerant JSON extraction: models wrap JSON in prose or code fences.
 * @returns {{ what: string, architecture: string }}
 */
export function parseSummary(reply) {
  const match = /\{[\s\S]*\}/.exec(reply ?? "");
  if (!match) throw new Error("Model reply contained no JSON object");
  let json;
  try { json = JSON.parse(match[0]); } catch { throw new Error("Model reply was not valid JSON"); }
  if (typeof json.what !== "string" || typeof json.architecture !== "string") throw new Error("Model JSON lacks what/architecture strings");
  return { what: json.what.trim(), architecture: json.architecture.trim() };
}

// ---------------------------------------------------------------- private helpers
function buildMessages(project, sources) {
  const system = [
    "You write factual project summaries for a hackathon database.",
    "Use ONLY the labelled sources. Cite a source after each claim like [S1].",
    "If the sources do not support something, write 'unknown' instead of guessing.",
    'Reply with JSON only: {"what": "<one paragraph: what the project is and does>", "architecture": "<one paragraph: how the code is structured: components, languages, frameworks, data flow>"}.',
  ].join(" ");
  const body = sources.map((s) => `[${s.label}] ${s.title}\n${s.text}`).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: `Project: ${project.title}\n\n${body}` }];
}

function treePaths(tree) {
  if (Array.isArray(tree)) return tree.map((e) => (typeof e === "string" ? e : e.path)).filter(Boolean);
  return [];
}

function stackText(project) {
  const languages = (project.github_stats?.languages ?? []).map((l) => `${l.name} ${Math.round(l.share * 100)}%`);
  const lines = [];
  if (languages.length) lines.push(`Languages: ${languages.join(", ")}`);
  if (project.built_with?.length) lines.push(`Built with: ${project.built_with.join(", ")}`);
  return lines.join("\n");
}
