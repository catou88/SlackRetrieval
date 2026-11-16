// HTTP routes for people: the People list, one person's page, teammates, notes.
import { listContacts, getPersonProfile, listTeammates, saveNote, MAX_PERSON_ID_CHARS } from "../../services/contacts.js";
import { requireTextParam, optionalTextParam } from "../middleware/queryValidation.js";

/** @type {import("../router.js").RouteDefinition[]} */
export const CONTACTS_ROUTES = [
  {
    method: "GET",
    path: "/api/people",
    validateQuery: (query) => optionalTextParam(query, "q"),
    handle: ({ db, query }) =>
      listContacts(db, {
        isMentorsOnly: query.has("mentors"),
        isLinkedInOnly: query.has("linkedin"),
        query: query.get("q") || undefined,
      }),
  },
  {
    method: "GET",
    path: "/api/person",
    validateQuery: (query) => requireTextParam(query, "id", MAX_PERSON_ID_CHARS),
    handle: ({ db, query }) => getPersonProfile(db, query.get("id")),
  },
  {
    method: "GET",
    path: "/api/teammates",
    handle: ({ db }) => listTeammates(db),
  },
  {
    method: "POST",
    path: "/api/note",
    handle: ({ db, body }) => {
      saveNote(db, body);
      return { ok: true };
    },
  },
];
