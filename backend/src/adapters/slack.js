// Adapter wrapping the existing Slack archive: turns contacts that published a
// LinkedIn URL on their Slack profile into person records, so the teammate
// finder can use them. Reads people.json; never touches the Slack API.
import { readJSON, FILES } from "../data/jsonStore.js";
import { makeRecord } from "../lib/records.js";

export const name = "slack";

/**
 * @param {object} options  unused
 * @param {{ readPeople?: () => Record<string, object> }} [deps]
 * @returns {Promise<object[]>}
 */
export async function fetchRecords(options, deps = {}) {
  const people = (deps.readPeople ?? (() => readJSON(FILES.people, {})))();
  return Object.values(people).filter((p) => !p.is_me && p.name).map((p) => toPersonRecord(p));
}

// ---------------------------------------------------------------- private helpers
function toPersonRecord(person) {
  return makeRecord("person", name, `slack:user:${person.id}`, {
    name: person.name, linkedinUrl: person.linkedin?.[0] ?? null, bio: person.title || null,
  });
}
