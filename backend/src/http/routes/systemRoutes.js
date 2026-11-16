// HTTP routes about the app itself: archive totals and cache statistics.
import { cacheStats, clearCaches } from "../../lib/cache.js";
import { isClaudeConfigured } from "../../clients/claude.js";
import { getArchiveStats } from "../../services/archive.js";

/** @type {import("../router.js").RouteDefinition[]} */
export const SYSTEM_ROUTES = [
  {
    method: "GET",
    path: "/api/stats",
    isCacheable: false, // includes live cache counters
    handle: ({ db }) => ({ ...getArchiveStats(db), claude: isClaudeConfigured(), cache: cacheStats() }),
  },
  {
    method: "GET",
    path: "/api/cache",
    isCacheable: false,
    handle: () => cacheStats(),
  },
  {
    // Drop the in-memory caches (the persistent Claude cache is bypassed with fresh: true).
    method: "POST",
    path: "/api/cache/clear",
    handle: () => {
      clearCaches();
      return { ok: true, cache: cacheStats() };
    },
  },
];
