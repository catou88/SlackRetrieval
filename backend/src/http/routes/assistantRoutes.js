// HTTP routes for the Claude features: ask a question, write a reconnect brief.
import { answerQuestion, writeAndSaveReconnectBrief } from "../../services/rag.js";

/** @type {import("../router.js").RouteDefinition[]} */
export const ASSISTANT_ROUTES = [
  {
    method: "POST",
    path: "/api/ask",
    invalidatesResponses: false, // read-only: answers are cached in llm_cache, not shown by GET routes
    handle: async ({ db, body }) => {
      // Pass the server's connection: a second one would bump PRAGMA data_version
      // on every cached answer and needlessly invalidate all cached GETs.
      const { answer, hits, cached } = await answerQuestion(body.question, {
        deps: { db },
        person: body.person,
        mentorsOnly: body.mentors ?? false,
        fresh: body.fresh ?? false,
      });
      return { answer, cached, sources: hits.map((hit) => ({ score: hit.score, ...hit.message, raw: undefined })) };
    },
  },
  {
    // Briefs persist in the briefs table; a cached answer reuses its row.
    method: "POST",
    path: "/api/brief",
    handle: async ({ db, body }) => {
      const brief = await writeAndSaveReconnectBrief(db, body.person, { goal: body.goal, fresh: body.fresh ?? false });
      return { answer: brief.answer, cached: brief.cached, saved: brief.saved, brief_id: brief.brief_id };
    },
  },
];
