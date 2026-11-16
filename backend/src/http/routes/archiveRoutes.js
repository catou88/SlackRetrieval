// HTTP routes for browsing the archive: channels, threads, search and the
// networking collections.
import { InvalidInputError } from "../../lib/errors.js";
import {
  listChannels, getChannelPage, getThread, listCollectionsWithCounts, getCollectionMessages, isKnownCollection,
} from "../../services/archive.js";
import { searchMessages } from "../../services/search.js";
import {
  requireTextParam, optionalTextParam, optionalIntegerParam, optionalChoiceParam, integerParam,
} from "../middleware/queryValidation.js";

const MAX_SLACK_ID_CHARS = 200;
const MAX_TS_CHARS = 64;
const MAX_COLLECTION_KEY_CHARS = 64;
const MAX_PAGE_LIMIT = 1000;
const MAX_PAGE_OFFSET = 10_000_000;
const SEARCH_MODES = ["semantic", "keyword"];

/** @type {import("../router.js").RouteDefinition[]} */
export const ARCHIVE_ROUTES = [
  {
    method: "GET",
    path: "/api/channels",
    handle: ({ db }) => listChannels(db),
  },
  {
    method: "GET",
    path: "/api/channel",
    validateQuery: (query) => {
      requireTextParam(query, "id", MAX_SLACK_ID_CHARS);
      optionalIntegerParam(query, "limit", MAX_PAGE_LIMIT);
      optionalIntegerParam(query, "offset", MAX_PAGE_OFFSET);
    },
    handle: ({ db, query }) =>
      getChannelPage(db, query.get("id"), { limit: integerParam(query, "limit"), offset: integerParam(query, "offset") }),
  },
  {
    method: "GET",
    path: "/api/thread",
    validateQuery: (query) => {
      requireTextParam(query, "channel", MAX_SLACK_ID_CHARS);
      requireTextParam(query, "ts", MAX_TS_CHARS);
    },
    handle: ({ db, query }) => getThread(db, query.get("channel"), query.get("ts")),
  },
  {
    method: "GET",
    path: "/api/search",
    validateQuery: (query) => {
      requireTextParam(query, "q");
      optionalChoiceParam(query, "mode", SEARCH_MODES);
    },
    handle: ({ db, query }) => searchMessages(db, query.get("q"), query.get("mode") || "semantic"),
  },
  {
    method: "GET",
    path: "/api/collections",
    handle: ({ db }) => listCollectionsWithCounts(db),
  },
  {
    method: "GET",
    path: "/api/collection",
    validateQuery: (query) => {
      requireTextParam(query, "key", MAX_COLLECTION_KEY_CHARS);
      if (!isKnownCollection(query.get("key"))) throw new InvalidInputError("unknown collection");
      optionalTextParam(query, "q");
    },
    handle: ({ db, query }) => getCollectionMessages(db, query.get("key"), { text: query.get("q") || undefined }),
  },
];
