// Retrieval-augmented answers: find the most relevant Slack messages with
// vector similarity, then have Claude answer using only that context. Owns the
// prompts, input validation and the cache key; the transport lives in
// clients/claude.js, the answer cache policy in services/llmCache.js, and HTTP
// status mapping in http/middleware/errorHandler.js.
//
// Caching:
//  * messages.json / people.json / state.json are parsed once per process and
//    reused until the files change (memoize + fileVersion).
//  * The frozen SYSTEM block and the large Slack-context block are marked
//    cache_control: ephemeral (Anthropic prompt caching).
//  * Successful, validated answers are stored in SQLite (llm_cache) keyed by a
//    hash of [cache version, prompt version, model, kind, raw inputs, data
//    version, full request]. Pass { fresh: true } to bypass the lookup.
import { CONFIG } from "../config.js";
import { hashKey, memoize } from "../lib/cache.js";
import { checkText, checkBool, InvalidInputError, NotFoundError, ClaudeDisabledError } from "../lib/errors.js";
import { readJSON, fileVersion, FILES } from "../data/jsonStore.js";
import { openDb } from "../data/db.js";
import { llmStoreFor, findBrief, insertBrief } from "../data/queries.js";
import { INDEX_FILES, loadIndex } from "../data/vectorIndex.js";
import { isClaudeConfigured, createClaudeClient, invokeClaude } from "../clients/claude.js";
import { semanticSearch } from "./search.js";
import { cachedLLM } from "./llmCache.js";
import { findPersonByQuery } from "./people.js";

// Bump CACHE_VERSION when the cache format changes and PROMPT_VERSION whenever
// SYSTEM_PROMPT, the prompt templates or REQUEST_OPTIONS change, so old answers are never served.
const CACHE_VERSION = 1;
const PROMPT_VERSION = 1;

const ASK_DEFAULT_K = 25;
const ASK_MAX_K = 100;
const BRIEF_THEIR_MESSAGES_K = 30;
const BRIEF_ABOUT_THEM_K = 10;
const BRIEF_MAX_DIRECT_MESSAGES = 150;
const CHANNELS_IN_PROFILE = 10;

const SNAPSHOT_FILES = [FILES.messages, FILES.people, FILES.state];
const PROMPT_INPUT_FILES = [...SNAPSHOT_FILES, ...INDEX_FILES];

const REQUEST_OPTIONS = {
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { effort: "medium" },
  // If a safety classifier declines, the API retries on a fallback model.
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

const SYSTEM_PROMPT = `You help the user remember and follow up with people they met in a hackathon Slack workspace.
Answer only from the Slack messages and contact records provided. Cite who said what and in which channel.
If the context doesn't contain the answer, say so plainly instead of guessing. Never invent LinkedIn URLs.`;

const loadSnapshotMemo = memoize("rag-snapshot", () => fileVersion(SNAPSHOT_FILES), readSnapshot, {
  ttlMs: CONFIG.cache.ttl.memoMs,
});

/**
 * Free-form question over all messages.
 * @param {string} question
 * @param {{ k?: number, person?: string, mentorsOnly?: boolean, fresh?: boolean, deps?: RagDeps }} [opts]
 * @returns {Promise<{ answer: string, cached: boolean, hits: object[] }>}
 * @throws {import("../lib/errors.js").DomainError} invalid input, not found, Claude disabled or model errors
 */
export async function answerQuestion(question, { k = ASK_DEFAULT_K, person, mentorsOnly = false, fresh = false, deps = {} } = {}) {
  question = checkText(question, "question", { isRequired: true });
  person = checkText(person, "person");
  mentorsOnly = checkBool(mentorsOnly, "mentors");
  fresh = checkBool(fresh, "fresh");
  if (!Number.isInteger(k) || k < 1 || k > ASK_MAX_K) throw new InvalidInputError(`k must be 1–${ASK_MAX_K}`);
  requireClaude(deps);

  const { messagesById, people } = deps.data || loadSnapshotMemo();
  const target = person ? findPersonByQuery(people, person) : null;
  if (person && !target) throw new NotFoundError("person", `No one matching "${person}".`);
  const search = deps.search || semanticSearch;
  const hits = await search(question, { k, filter: questionFilter(messagesById, people, target, mentorsOnly) });
  const context = questionContext(hits, messagesById, people);
  const keyInputs = { question, person: person ?? null, mentorsOnly, k };
  const result = await callClaudeCached("ask", context, `Question: ${question}`, keyInputs, { fresh, deps });
  return { answer: result.answer, cached: result.cached, hits: hits.map((hit) => ({ ...hit, message: messagesById.get(hit.id) })) };
}

/**
 * Everything you need before reaching out to one person: who they are, what
 * you talked about, open threads, and a draft message.
 * @param {string} personQuery  id, @handle or name
 * @param {{ goal?: string, fresh?: boolean, deps?: RagDeps }} [opts]
 * @returns {Promise<{ person: object, goal: string, answer: string, cached: boolean, ok: boolean, directCount: number }>}
 * @throws {import("../lib/errors.js").DomainError}
 */
export async function writeReconnectBrief(personQuery, { goal = "", fresh = false, deps = {} } = {}) {
  personQuery = checkText(personQuery, "person", { isRequired: true });
  goal = checkText(goal, "goal") ?? "";
  fresh = checkBool(fresh, "fresh");
  requireClaude(deps);

  const snapshot = deps.data || loadSnapshotMemo();
  const person = findPersonByQuery(snapshot.people, personQuery);
  if (!person) throw new NotFoundError("person", `No one matching "${personQuery}". Try \`npm run people\`.`);
  const { context, directCount } = await briefContext(snapshot, person, goal, deps.search);
  const keyInputs = { person: person.id, goal };
  const result = await callClaudeCached("brief", context, briefInstruction(person, goal), keyInputs, { fresh, deps });
  return { person, goal, answer: result.answer, cached: result.cached, ok: result.ok, directCount };
}

/**
 * writeReconnectBrief() + persist into the briefs table. A failed call throws
 * before anything is written; a refusal / truncated answer (ok === false) is
 * shown but not saved; a cache hit reuses the matching row instead of adding a
 * duplicate.
 * @param {import("better-sqlite3").Database} db
 * @param {string} personQuery
 * @param {{ goal?: string, fresh?: boolean, deps?: RagDeps }} [opts]
 * @returns {Promise<object>} writeReconnectBrief() result plus { saved, brief_id }
 * @throws {import("../lib/errors.js").DomainError}
 */
export async function writeAndSaveReconnectBrief(db, personQuery, opts = {}) {
  const result = await writeReconnectBrief(personQuery, { ...opts, deps: { db, ...opts.deps } });
  if (result.ok === false) return { ...result, saved: false };
  const briefFields = { personId: result.person.id, goal: result.goal, body: result.answer };
  const existingId = findBrief(db, briefFields);
  if (existingId !== null) return { ...result, saved: false, brief_id: existingId };
  const briefId = insertBrief(db, { ...briefFields, createdAt: new Date().toISOString() });
  return { ...result, saved: true, brief_id: briefId };
}

/**
 * @typedef {object} RagDeps  injectable collaborators (tests pass fakes)
 * @property {object} [client]  Anthropic-like client
 * @property {object} [store]  llm cache store
 * @property {import("better-sqlite3").Database} [db]  used for the default store
 * @property {{ messages, messagesById, people, state }} [data]
 * @property {(query: string, opts: object) => Promise<{ id: string, score: number }[]>} [search]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {number} [ttlMs]
 * @property {string} [dataVersion]
 */

// ---------------------------------------------------------------- private helpers
function requireClaude(deps) {
  if (!deps.client && !isClaudeConfigured()) throw new ClaudeDisabledError();
}

function readSnapshot() {
  const messages = readJSON(FILES.messages, []);
  return {
    messages,
    messagesById: new Map(messages.map((message) => [message.id, message])),
    people: readJSON(FILES.people, {}),
    state: readJSON(FILES.state, {}),
  };
}

async function callClaudeCached(kind, context, instruction, keyInputs, { fresh, deps }) {
  const model = deps.model || CONFIG.claude.model;
  const params = buildRequestParams(model, context, instruction);
  const dataVersion = deps.dataVersion ?? fileVersion(PROMPT_INPUT_FILES);
  // params is the full request (system, context, instruction, thinking/effort/max_tokens).
  const key = hashKey([CACHE_VERSION, PROMPT_VERSION, model, kind, keyInputs, dataVersion, params]);
  const store = deps.store || llmStoreFor(deps.db || openDb());
  const client = deps.client || createClaudeClient();
  const timeoutMs = deps.timeoutMs || CONFIG.claude.timeoutMs;
  const call = () => invokeClaude(client, params, timeoutMs);
  return cachedLLM({ store, key, kind, model, fresh, call, ...(deps.ttlMs !== undefined && { ttlMs: deps.ttlMs }) });
}

// Prompt caching: the frozen system block, then the large per-person /
// per-query context block, each a cache breakpoint; only the short
// instruction after them varies.
function buildRequestParams(model, context, instruction) {
  return {
    model,
    ...REQUEST_OPTIONS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: context, cache_control: { type: "ephemeral" } },
        { type: "text", text: instruction },
      ],
    }],
  };
}

function questionFilter(messagesById, people, target, mentorsOnly) {
  return (id) => {
    const message = messagesById.get(id);
    if (!message) return false;
    if (target && !isAboutPerson(message, target)) return false;
    if (mentorsOnly && !people[message.user_id]?.is_mentor) return false;
    return true;
  };
}

function isAboutPerson(message, person) {
  return message.user_id === person.id || message.dm_with === person.id || message.text.includes(`@${person.name}`);
}

function questionContext(hits, messagesById, people) {
  const messageLines = hits.map((hit) => formatMessage(messagesById.get(hit.id))).join("\n");
  const authorIds = new Set(hits.map((hit) => messagesById.get(hit.id).user_id));
  const contacts = [...authorIds].map((id) => people[id]).filter(Boolean).map(formatPerson).join("\n\n");
  return `<contacts>\n${contacts}\n</contacts>\n\n<slack_messages>\n${messageLines}\n</slack_messages>`;
}

// Builds the <contact>/<me>/conversation sections for a brief.
async function briefContext({ messages, messagesById, people, state }, person, goal, search = semanticSearch) {
  const me = people[state.me];
  const direct = directMessages(messages, person, state.me, me);
  const directIds = new Set(direct.map((message) => message.id));
  const index = search === semanticSearch ? loadIndex() : undefined; // load once for both searches
  const theirs = await search(`${person.name} introduction background expertise advice offer help ${goal}`, {
    k: BRIEF_THEIR_MESSAGES_K,
    index,
    filter: (id) => !directIds.has(id) && messagesById.get(id)?.user_id === person.id,
  });
  const firstName = person.name.split(" ")[0];
  const aboutThem = await search(`${person.name} ${goal}`, {
    k: BRIEF_ABOUT_THEM_K,
    index,
    filter: (id) => {
      const message = messagesById.get(id);
      return message && !directIds.has(id) && message.user_id !== person.id && message.text.includes(firstName);
    },
  });
  const evidence = person.role_evidence.length ? "Role evidence: " + person.role_evidence.join("; ") : "";
  const context = [
    `<contact>\n${formatPerson(person)}\n${evidence}\n</contact>`,
    me ? `<me>${me.name}${me.title ? ", " + me.title : ""}</me>` : "",
    promptSection("direct_conversations", direct.slice(-BRIEF_MAX_DIRECT_MESSAGES)),
    promptSection("their_messages", theirs.map((hit) => messagesById.get(hit.id))),
    promptSection("others_about_them", aboutThem.map((hit) => messagesById.get(hit.id))),
  ].join("\n\n");
  return { context, directCount: direct.length };
}

// Every direct interaction (DMs + threads you were both in), verbatim.
function directMessages(messages, person, myId, me) {
  const threadKey = (message) => `${message.channel_id}:${message.thread_ts || message.ts}`;
  const myThreads = new Set(messages.filter((message) => message.user_id === myId).map(threadKey));
  const theirThreads = new Set(messages.filter((message) => message.user_id === person.id).map(threadKey));
  const isSharedThread = (message) => myThreads.has(threadKey(message)) && theirThreads.has(threadKey(message));
  return messages.filter(
    (message) =>
      message.dm_with === person.id ||
      isSharedThread(message) ||
      (message.user_id === myId && message.text.includes(`@${person.name}`)) ||
      (message.user_id === person.id && me && message.text.includes(`@${me.name}`))
  );
}

function briefInstruction(person, goal) {
  return `I want to reconnect with ${person.name}${goal ? ` — my goal: ${goal}` : ""}. Write me a brief with:
1. **Who they are** — role, company, expertise, LinkedIn (only if present above).
2. **How we know each other** — what we actually discussed, with dates.
3. **What they helped with / offered** — advice, intros, follow-ups they or I promised.
4. **What to tell them** — 3–5 concrete updates or talking points worth sharing, based on what we discussed.
5. **Draft message** — a short, warm LinkedIn/Slack message I could send now.`;
}

function promptSection(title, messages) {
  return messages.length ? `<${title}>\n${messages.map(formatMessage).join("\n")}\n</${title}>` : `<${title}>(none)</${title}>`;
}

function formatMessage(message) {
  return `[${message.date.slice(0, 16).replace("T", " ")}] ${message.channel} — ${message.user_name}: ${message.text}`;
}

function formatPerson(person) {
  const lines = [
    `Name: ${person.name}${person.handle ? ` (@${person.handle})` : ""}`,
    person.title && `Title: ${person.title}`,
    person.pronouns && `Pronouns: ${person.pronouns}`,
    person.roles.length && `Roles: ${person.roles.join(", ")}`,
    person.linkedin.length && `LinkedIn: ${person.linkedin.join(", ")}`,
    person.other_links.length && `Other links: ${person.other_links.join(", ")}`,
    person.email && `Email: ${person.email}`,
    ...person.profile_fields.filter((field) => field.value).map((field) => `${field.label || "Profile"}: ${field.value}`),
    `Active in: ${person.channels.slice(0, CHANNELS_IN_PROFILE).join(", ")}`,
    `Messages: ${person.message_count} (DMs: ${person.dm_count}), last seen ${person.last_seen?.slice(0, 10)}`,
  ];
  return lines.filter(Boolean).join("\n");
}
