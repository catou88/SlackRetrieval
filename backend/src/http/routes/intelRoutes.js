// HTTP routes for the hackathon database (/api/intel/*): browse winners,
// projects, people, sponsors and jobs, and ask Qwen questions about them.
// Detail pages use ?id= because the router matches exact paths. The intel
// tables are created at server start (http/server.js).
import { DomainError, InvalidInputError, NotFoundError } from "../../lib/errors.js";
import {
  listProjects, getProject, listHackathons, listSponsors, listJobs, listPeople,
} from "../../data/intelStore.js";
import { findTeammates } from "../../services/teammateFinder.js";
import { pickTrack, revealTrack } from "../../services/practice.js";
import { createIntelRag } from "../../services/intelRag.js";
import { createQwenClient } from "../../clients/qwen.js";
import { embed } from "../../clients/embedder.js";
import { requireTextParam, optionalTextParam, optionalChoiceParam } from "../middleware/queryValidation.js";

const MAX_FILTER_CHARS = 200;
const MAX_QUESTION_CHARS = 1000;
const JOB_SOURCES = ["slack", "discord"];

/**
 * Build the route list. The RAG factory is injectable so tests run offline.
 * @param {{ getRag?: (db) => { ask: Function } }} [deps]
 * @returns {import("../router.js").RouteDefinition[]}
 */
export function createIntelRoutes({ getRag = defaultRagFor } = {}) {
  return [
    { method: "GET", path: "/api/intel/hackathons", handle: ({ db }) => listHackathons(db) },
    {
      method: "GET",
      path: "/api/intel/projects",
      validateQuery: (query) => {
        optionalTextParam(query, "sponsor", MAX_FILTER_CHARS);
        optionalTextParam(query, "stack", MAX_FILTER_CHARS);
        optionalTextParam(query, "hackathon", 20);
        optionalChoiceParam(query, "winners", ["1", "0"]);
      },
      handle: ({ db, query }) => {
        return listProjects(db, projectFilters(query));
      },
    },
    {
      method: "GET",
      path: "/api/intel/project",
      validateQuery: (query) => requireTextParam(query, "id", 20),
      handle: ({ db, query }) => {
        const project = getProject(db, numericId(query));
        if (!project) throw new NotFoundError("project");
        return project;
      },
    },
    { method: "GET", path: "/api/intel/people", handle: ({ db }) => listPeople(db) },
    {
      method: "GET",
      path: "/api/intel/person",
      validateQuery: (query) => requireTextParam(query, "id", 20),
      handle: ({ db, query }) => {
        const person = listPeople(db).find((p) => p.id === numericId(query));
        if (!person) throw new NotFoundError("person");
        return person;
      },
    },
    { method: "GET", path: "/api/intel/sponsors", handle: ({ db }) => listSponsors(db) },
    {
      method: "GET",
      path: "/api/intel/jobs",
      validateQuery: (query) => {
        optionalChoiceParam(query, "source", JOB_SOURCES);
        for (const name of ["channel", "company", "sponsor"]) optionalTextParam(query, name, MAX_FILTER_CHARS);
      },
      handle: ({ db, query }) => {
        return listJobs(db, definedFilters(query, ["source", "channel", "company", "sponsor"]));
      },
    },
    {
      method: "GET",
      path: "/api/intel/teammates",
      validateQuery: (query) => requireTextParam(query, "q", MAX_FILTER_CHARS),
      handle: ({ db, query }) => findTeammates(db, query.get("q")),
    },
    {
      method: "GET",
      path: "/api/intel/practice",
      isCacheable: false, // random each time
      handle: ({ db }) => pickTrack(db) ?? { track: null },
    },
    {
      method: "GET",
      path: "/api/intel/practice/reveal",
      validateQuery: (query) => {
        requireTextParam(query, "hackathon", 20);
        requireTextParam(query, "prize", MAX_FILTER_CHARS);
      },
      handle: ({ db, query }) => {
        const revealed = revealTrack(db, { hackathonId: Number(query.get("hackathon")), prize: query.get("prize") });
        if (!revealed) throw new NotFoundError("track");
        return revealed;
      },
    },
    {
      method: "POST",
      path: "/api/intel/ask",
      invalidatesResponses: false, // read-only
      handle: async ({ db, body }) => {
        const question = body?.question;
        if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION_CHARS) {
          throw new InvalidInputError(`question must be 1-${MAX_QUESTION_CHARS} characters`);
        }
        return askSafely(getRag(db), question.trim());
      },
    },
  ];
}

export const INTEL_ROUTES = createIntelRoutes();

// ---------------------------------------------------------------- private helpers
const ragByDb = new WeakMap();

// The index is built lazily on first question and reused per connection.
function defaultRagFor(db) {
  if (!ragByDb.has(db)) ragByDb.set(db, createIntelRag({ db, embed, qwen: createQwenClient() }));
  return ragByDb.get(db);
}

async function askSafely(rag, question) {
  try {
    return await rag.ask(question);
  } catch (err) {
    // Model or embedder down: surface a stable 503 instead of leaking internals.
    throw new DomainError("model_unavailable", "The Qwen model is unavailable right now", err);
  }
}

function numericId(query) {
  const id = Number(query.get("id"));
  if (!Number.isInteger(id) || id < 1) throw new InvalidInputError("id must be a positive integer");
  return id;
}

function projectFilters(query) {
  const filters = definedFilters(query, ["sponsor", "stack"]);
  if (query.get("winners") === "1") filters.winnersOnly = true;
  const hackathon = query.get("hackathon");
  if (hackathon) {
    const id = Number(hackathon);
    if (!Number.isInteger(id) || id < 1) throw new InvalidInputError("hackathon must be a positive integer");
    filters.hackathonId = id;
  }
  return filters;
}

function definedFilters(query, names) {
  return Object.fromEntries(names.filter((n) => query.get(n)).map((n) => [n, query.get(n)]));
}
