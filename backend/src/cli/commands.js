// Owns the CLI commands: one named function per `npm run <command>`. Each
// receives { text, flags } (positional words joined, parsed --flags) and
// orchestrates services; printing is done here, not in the services.
import fs from "node:fs";
import { readJSON, dataPath, FILES } from "../data/jsonStore.js";
import { ingestSlackWorkspace } from "../services/ingest.js";
import { buildContactBook } from "../services/people.js";
import { categorize } from "../services/categorize.js";
import { rebuildSearchIndex, refreshDatabase } from "../services/indexing.js";
import { semanticSearch } from "../services/search.js";
import { answerQuestion, writeReconnectBrief } from "../services/rag.js";
import { backupDataFolder } from "../services/backup.js";
import { exportContactsCsv } from "../services/contactExport.js";
import { CONFIG } from "../config.js";
import { openDb } from "../data/db.js";
import { createHttpFetcher } from "../clients/httpFetcher.js";
import { ingestAll } from "../services/intelIngest.js";
import { createQwenClient } from "../clients/qwen.js";
import { createIntelRag } from "../services/intelRag.js";
import { embed } from "../clients/embedder.js";
import { summarizeAll } from "../services/projectSummaries.js";
import { summarizeAllContributions } from "../services/contributions.js";
import { runExtractionEval } from "../eval/extractionEval.js";
import { writeEvalReport, metricDeltas } from "../eval/report.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_GOLD_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "eval", "devpost-gold.json");
const EVAL_REPORT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "evals");

const DEFAULT_SEARCH_RESULTS = 10;
const DEFAULT_PG_SEARCH_RESULTS = 15;
const PREVIEW_CHARS = 200;
const SOURCE_PREVIEW_CHARS = 120;
const INTRO_PREVIEW_CHARS = 400;

/** Command name → handler. Unknown names print the usage text. */
export const COMMANDS = {
  ingest: ingestCommand,
  "people:build": buildPeopleCommand,
  index: indexCommand,
  db: databaseCommand,
  sync: syncCommand,
  categorize: categorizeCommand,
  pg: pgvectorLoadCommand,
  collection: pgvectorCollectionCommand,
  "pg:search": pgvectorSearchCommand,
  serve: serveCommand,
  backup: backupCommand,
  search: searchCommand,
  ask: askCommand,
  brief: briefCommand,
  people: listPeopleCommand,
  export: exportCommand,
  "intel:ingest": intelIngestCommand,
  "intel:eval": intelEvalCommand,
  "intel:summarize": intelSummarizeCommand,
  "intel:ask": intelAskCommand,
};

export const USAGE = `Usage (npm run <command> -- …):
  sync [--all] [--full] [--no-files]   ingest Slack + build contacts + index + collections + database
  ask "who offered to review my resume?" [--person "Jane"] [--mentors] [--sources] [--fresh]
  search "react native auth" [--k 10]
  people [--mentors] [--linkedin]
  brief "Jane Doe" [--goal "ask about internships"] [--fresh]
  export                               contacts.csv for spreadsheets
  serve [--no-cache]                   local website at http://localhost:3000 (or CACHE=0)
  intel:ingest [--adapter devpost] [--max-hackathons 5]   fetch hackathon winners/people/jobs into the intel tables
  intel:summarize [--force]            write what-it-is + architecture paragraphs with Qwen (needs QWEN_BASE_URL)
  intel:ask "which winners used LangGraph?"   answer from the hackathon database with Qwen, cited
  intel:eval                           run extraction evals, write docs/evals/intel-eval-<date>.md + history.csv
  backup [--to D:\\]                    zip everything in data/
  ingest | index | db | categorize | pg | collection [name] | pg:search "query" [--in collection]`;

// ---------------------------------------------------------------- data pipeline
async function ingestCommand({ flags }) {
  await ingestSlackWorkspace(ingestOptions(flags));
}

function buildPeopleCommand() {
  buildContactBook();
  refreshDatabase();
}

async function indexCommand() {
  await rebuildSearchIndex();
}

function databaseCommand() {
  refreshDatabase();
}

async function syncCommand({ flags }) {
  await ingestSlackWorkspace(ingestOptions(flags));
  buildContactBook();
  try {
    await rebuildSearchIndex();
    await categorize();
  } catch (err) {
    // Messages are already safely saved; search + collections can be built later.
    console.error(`Index/collections failed (${err.message}). Your data is saved; retry with: npm run categorize`);
  }
  refreshDatabase();
}

// Re-sort networking collections (after tuning) and refresh the website database.
async function categorizeCommand() {
  buildContactBook();
  await rebuildSearchIndex();
  await categorize();
  refreshDatabase();
}

// ---------------------------------------------------------------- pgvector (Docker)
async function pgvectorLoadCommand() {
  const { startPgvectorContainer, loadArchiveIntoPgvector, dumpPgvectorDatabase } = await import("../data/pgvector.js");
  await categorize();
  await startPgvectorContainer();
  await loadArchiveIntoPgvector();
  dumpPgvectorDatabase();
}

// linkedin-directory | mentors | offers | linkedin | mentor_intro | offer
async function pgvectorCollectionCommand({ text }) {
  const { listPgvectorCollection } = await import("../data/pgvector.js");
  const rows = await listPgvectorCollection(text || "linkedin-directory");
  for (const row of rows) {
    const who = [row.name || row.user_name, row.title].filter(Boolean).join(" — ");
    const link = Array.isArray(row.linkedin) ? row.linkedin.join(" ") : row.linkedin || "";
    console.log(`\n${who}  ${link}`.trimEnd());
    const intro = row.introduction || row.text;
    if (intro) console.log("  " + oneLine(intro).slice(0, INTRO_PREVIEW_CHARS));
  }
  console.log(`\n${rows.length} rows`);
}

async function pgvectorSearchCommand({ text, flags }) {
  const { searchPgvector } = await import("../data/pgvector.js");
  const rows = await searchPgvector(text, { collection: flags.in, k: Number(flags.k) || DEFAULT_PG_SEARCH_RESULTS });
  for (const row of rows) {
    console.log(`${row.score.toFixed(3)} [${row.collections.join(",")}] ${row.channel} — ${row.user_name}: ${oneLine(row.text).slice(0, PREVIEW_CHARS)}`);
  }
}

// ---------------------------------------------------------------- website, backup, export
async function serveCommand() {
  const { startServer } = await import("../http/server.js");
  await startServer();
}

function backupCommand({ flags }) {
  backupDataFolder({ destinationDir: flags.to || "." });
}

function exportCommand() {
  const { file, count } = exportContactsCsv();
  console.log(`Wrote ${count} contacts to ${file}`);
}

// ---------------------------------------------------------------- questions
async function searchCommand({ text, flags }) {
  const messagesById = new Map(readJSON(FILES.messages, []).map((message) => [message.id, message]));
  const hits = await semanticSearch(text, { k: Number(flags.k) || DEFAULT_SEARCH_RESULTS });
  for (const hit of hits) {
    const message = messagesById.get(hit.id);
    console.log(`${hit.score.toFixed(3)}  ${message.date.slice(0, 10)} ${message.channel} — ${message.user_name}: ${oneLine(message.text.slice(0, PREVIEW_CHARS))}`);
  }
}

async function askCommand({ text, flags }) {
  if (!text) throw new Error('Usage: ask "your question"');
  const { answer, hits } = await answerQuestion(text, { person: flags.person, mentorsOnly: !!flags.mentors, fresh: !!flags.fresh });
  console.log(answer);
  if (!flags.sources) return;
  console.log("\n--- sources ---");
  for (const hit of hits) {
    console.log(`${hit.score.toFixed(3)} ${hit.message.channel} ${hit.message.user_name}: ${hit.message.text.slice(0, SOURCE_PREVIEW_CHARS)}`);
  }
}

async function briefCommand({ text, flags }) {
  if (!text) throw new Error('Usage: brief "Person Name" [--goal "..."]');
  const { person, answer, directCount } = await writeReconnectBrief(text, { goal: flags.goal || "", fresh: !!flags.fresh });
  console.log(`# ${person.name}  (${directCount} direct messages found)\n`);
  console.log(answer);
  const briefFile = dataPath(`briefs/${person.name.replace(/[^\w-]+/g, "_")}.md`);
  fs.mkdirSync(dataPath("briefs"), { recursive: true });
  fs.writeFileSync(briefFile, `# ${person.name}\n\n${answer}\n`);
  console.log(`\n(saved to ${briefFile})`);
}

function listPeopleCommand({ flags }) {
  const people = Object.values(readJSON(FILES.people, {}))
    .filter((person) => !person.is_me)
    .filter((person) => !flags.mentors || person.is_mentor)
    .filter((person) => !flags.linkedin || person.linkedin.length)
    .sort((a, b) => b.dm_count - a.dm_count || b.message_count - a.message_count);
  for (const person of people) console.log(formatPersonRow(person));
  console.log(`\n${people.length} people`);
}

// ---------------------------------------------------------------- hackathon intel
async function intelIngestCommand({ flags }) {
  const db = openDb();
  const names = flags.adapter ? [flags.adapter] : [];
  const options = ingestIntelOptions(flags);
  let summaries;
  try {
    summaries = await ingestAll(db, names, options, { http: createHttpFetcher() });
  } finally {
    db.close();
  }
  for (const s of summaries) {
    console.log(`${s.adapter}: fetched ${s.fetched}, stored ${s.stored}${s.error ? `, FAILED: ${s.error}` : ""}`);
    for (const problem of s.problems) console.log(`  - ${problem}`);
  }
  console.log(summaries.at(-1)?.counts ?? {});
}

async function intelSummarizeCommand({ flags }) {
  const qwen = createQwenClient();
  if (!(await qwen.isReachable())) throw new Error(`No Qwen endpoint at ${CONFIG.qwen.baseUrl}. Start Ollama (ollama run ${CONFIG.qwen.model}) or set QWEN_BASE_URL.`);
  const db = openDb();
  try {
    const result = await summarizeAll(db, qwen, { force: !!flags.force });
    console.log(`summarized ${result.done}, skipped ${result.skipped}, failed ${result.failed.length}`);
    for (const f of result.failed) console.log(`  - project ${f.id}: ${f.error}`);
    const contributions = await summarizeAllContributions(db, qwen);
    console.log(`contributions for ${contributions.people} people across ${contributions.projects} projects, failed ${contributions.failed.length}`);
  } finally {
    db.close();
  }
}

async function intelAskCommand({ text }) {
  if (!text) throw new Error('Usage: intel:ask "your question"');
  const qwen = createQwenClient();
  const db = openDb();
  try {
    const result = await createIntelRag({ db, embed, qwen }).ask(text);
    console.log(result.answer);
    for (const c of result.citations) console.log(`  [${c.n}] ${c.title} (${c.label})`);
  } finally {
    db.close();
  }
}

function intelEvalCommand() {
  const date = new Date().toISOString().slice(0, 10);
  const suites = { extraction: runExtractionEval(EVAL_GOLD_FILE) };
  const { reportFile, historyFile } = writeEvalReport(suites, { dir: EVAL_REPORT_DIR, date, commit: currentCommit() });
  console.log(`Wrote ${reportFile}`);
  for (const [metric, value] of Object.entries(suites.extraction)) console.log(`  ${metric.padEnd(26)} ${value}`);
  for (const d of metricDeltas(historyFile, "extraction")) {
    if (d.current !== d.previous) console.log(`  delta ${d.metric}: ${d.previous} -> ${d.current}`);
  }
}

// ---------------------------------------------------------------- private helpers
function ingestIntelOptions(flags) {
  const options = {};
  if (flags["max-hackathons"]) {
    const max = Number(flags["max-hackathons"]);
    if (!Number.isInteger(max) || max < 1) throw new Error("--max-hackathons must be a positive integer");
    options.maxHackathons = max;
  }
  if (flags.file) options.file = flags.file;
  if (CONFIG.intel.githubToken) options.token = CONFIG.intel.githubToken;
  return options;
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function ingestOptions(flags) {
  return { onlyMember: !flags.all, full: !!flags.full, downloadFiles: !flags["no-files"] };
}

function formatPersonRow(person) {
  const tags = [person.roles.join("/"), person.dm_count ? `${person.dm_count} DMs` : ""].filter(Boolean).join(", ");
  const title = (person.title || "").slice(0, 34);
  return `${person.name.padEnd(28)} ${title.padEnd(34)} ${(person.linkedin[0] || "").padEnd(50)} ${tags}`;
}

function oneLine(text) {
  return text.replace(/\n/g, " ");
}
